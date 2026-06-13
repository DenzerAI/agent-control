"""Local LLM helper — talks to LM Studio's OpenAI-compatible server.

Server-Start manuell: `lms server start` (siehe brain/INFRA.md).
Modell-Default: qwen/qwen3-vl-30b (MLX 4bit, ~17 GiB im RAM).

Jeder erfolgreiche Call inkrementiert den Tageszähler unter data/local_llm_counter.json,
damit der Heartbeat-Wächter „local-llm" zeigen kann, was das Modell heute geleistet hat.
"""
import os
import json
import urllib.request
import urllib.error
import asyncio
import time
from pathlib import Path

try:
    from llm_log import log_call as _log_call
except Exception:
    def _log_call(*_a, **_kw):
        pass

LOCAL_LLM_URL = os.environ.get("LOCAL_LLM_URL", "http://127.0.0.1:1234/v1")
LOCAL_LLM_MODEL = os.environ.get("LOCAL_LLM_MODEL", "qwen/qwen3-vl-30b")

_COUNTER_PATH = Path(__file__).resolve().parent.parent / "data" / "local_llm_counter.json"


def _bump_counter() -> None:
    """Erhöht den Tageszähler. Best-effort, schluckt Fehler."""
    try:
        today = time.strftime("%Y-%m-%d")
        data = {}
        if _COUNTER_PATH.exists():
            try:
                data = json.loads(_COUNTER_PATH.read_text(encoding="utf-8") or "{}")
            except Exception:
                data = {}
        data[today] = int(data.get(today, 0)) + 1
        data["last_call_ts"] = time.time()
        # Alte Tage > 30 wegwerfen, sonst wächst die Datei ins Unendliche.
        cutoff = time.strftime("%Y-%m-%d", time.localtime(time.time() - 30 * 86400))
        for k in list(data.keys()):
            if k != "last_call_ts" and k < cutoff:
                data.pop(k, None)
        _COUNTER_PATH.parent.mkdir(parents=True, exist_ok=True)
        _COUNTER_PATH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def read_counter() -> dict:
    """Liest den Tageszähler. Returns {today_count: int, total_30d: int, last_call_ts: float|None}."""
    if not _COUNTER_PATH.exists():
        return {"today_count": 0, "total_30d": 0, "last_call_ts": None}
    try:
        data = json.loads(_COUNTER_PATH.read_text(encoding="utf-8") or "{}")
    except Exception:
        return {"today_count": 0, "total_30d": 0, "last_call_ts": None}
    today = time.strftime("%Y-%m-%d")
    today_count = int(data.get(today, 0))
    total = sum(int(v) for k, v in data.items() if k != "last_call_ts" and isinstance(v, (int, float)))
    return {
        "today_count": today_count,
        "total_30d": total,
        "last_call_ts": data.get("last_call_ts"),
    }


def call_local_sync(prompt: str, system: str = "", max_tokens: int = 256,
                    temperature: float = 0.3, timeout: float = 30.0,
                    feature: str = "unknown") -> str:
    """Blocking call to local LLM. Returns assistant text or raises.

    feature: kurzer Slug für den Engines-Tab (z.B. 'auto_title', 'whatsapp_classify').
    """
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    payload = json.dumps({
        "model": LOCAL_LLM_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        f"{LOCAL_LLM_URL}/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode())
        text = body["choices"][0]["message"]["content"]
        _bump_counter()
        _log_call(feature, "qwen", LOCAL_LLM_MODEL, (time.time() - t0) * 1000, ok=True)
        return text
    except Exception:
        _log_call(feature, "qwen", LOCAL_LLM_MODEL, (time.time() - t0) * 1000, ok=False)
        raise


async def call_local(prompt: str, system: str = "", max_tokens: int = 256,
                     temperature: float = 0.3, timeout: float = 30.0,
                     feature: str = "unknown") -> str:
    """Async wrapper — runs call_local_sync in a thread."""
    return await asyncio.to_thread(
        call_local_sync, prompt, system, max_tokens, temperature, timeout, feature
    )


def is_available(timeout: float = 1.5) -> bool:
    """Quick check ob der Server antwortet."""
    try:
        req = urllib.request.Request(f"{LOCAL_LLM_URL}/models")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


async def call_with_haiku_fallback(
    prompt: str,
    feature: str,
    system: str = "",
    max_tokens: int = 256,
    temperature: float = 0.3,
    qwen_timeout: float = 15.0,
    haiku_timeout: float = 30.0,
) -> tuple[str, str]:
    """Qwen-first, Haiku als Fallback. Gibt (text, model_used) zurück.

    Bei beiden Fehlern leerer String + leeres Modell — Caller entscheidet.
    """
    import logging
    text = ""
    model_used = ""
    qwen_failed = False
    try:
        if is_available():
            text = await call_local(
                prompt=prompt, system=system,
                max_tokens=max_tokens, temperature=temperature,
                timeout=qwen_timeout, feature=feature,
            )
            if text and text.strip():
                return text, LOCAL_LLM_MODEL
    except Exception as e:
        logging.getLogger(__name__).warning("[%s] Qwen failed (%s) — fallback Haiku", feature, e)
        qwen_failed = True

    try:
        from db import run_claude_cli
        rc, stdout, stderr = await run_claude_cli(prompt, model="claude-haiku-4-5", timeout=haiku_timeout)
        if rc == 0 and stdout and stdout.strip():
            text = stdout
            model_used = "claude-haiku-4-5"
            try:
                from llm_log import log_call as _lc
                _lc(feature, "claude", "claude-haiku-4-5", 0.0, ok=True,
                    fallback_from="qwen" if qwen_failed else "")
            except Exception:
                pass
        else:
            logging.getLogger(__name__).warning("[%s] Haiku rc=%d stderr=%r", feature, rc, (stderr or "")[:200])
    except Exception as e:
        logging.getLogger(__name__).warning("[%s] Haiku failed (%s)", feature, e)

    return text, model_used
