"""Codex/ChatGPT-Pro-Kontingent on-demand lesen.

Analog zu `service.py` (Claude), nur fuer chatgpt.com/codex/settings/usage.
Persistentes Browser-Profil unter `data/usage/codex_profile/`.
Einmaliger Login via `python -m modules.usage.codex_service login` (headed).
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT / "data" / "usage"
PROFILE_DIR = DATA_DIR / "codex_profile"
LATEST = DATA_DIR / "latest_codex.json"
HISTORY = DATA_DIR / "history_codex.jsonl"
SHOTS = DATA_DIR / "screenshots_codex"

USAGE_URL = "https://chatgpt.com/codex/settings/usage"
LOGIN_URL = "https://chatgpt.com/auth/login"

TZ = ZoneInfo("Europe/Berlin")


def _now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def _interesting_url(url: str) -> bool:
    u = url.lower()
    if "chatgpt.com" not in u and "openai.com" not in u:
        return False
    needles = ("usage", "limit", "rate", "subscription", "billing", "quota", "plan", "codex")
    return any(n in u for n in needles)


def _parse_network_body(body: dict[str, Any]) -> dict[str, Any]:
    """Aus chatgpt.com/backend-api/wham/usage saubere Werte ziehen."""
    out: dict[str, Any] = {}
    if not isinstance(body, dict):
        return out

    plan = body.get("plan_type")
    if isinstance(plan, str):
        out["plan"] = plan

    rl = body.get("rate_limit") or {}
    prim = rl.get("primary_window") or {}
    sec = rl.get("secondary_window") or {}

    if "used_percent" in prim:
        out["session_used_pct"] = int(prim["used_percent"])
    if "reset_at" in prim:
        ts = datetime.fromtimestamp(int(prim["reset_at"]), TZ)
        out["session_resets_at"] = ts.replace(microsecond=0).isoformat(timespec="seconds")
        delta = ts - datetime.now(TZ)
        out["session_resets_in_min"] = max(0, int(delta.total_seconds() // 60))

    if "used_percent" in sec:
        out["week_used_pct"] = int(sec["used_percent"])
    if "reset_at" in sec:
        ts = datetime.fromtimestamp(int(sec["reset_at"]), TZ)
        out["week_resets_at"] = ts.replace(microsecond=0).isoformat(timespec="seconds")

    return out


def _block_after(lines: list[str], anchor: str, window: int = 8) -> list[str]:
    for i, ln in enumerate(lines):
        if anchor.lower() in ln.lower():
            return lines[i + 1 : i + 1 + window]
    return []


def _parse_text(text: str) -> dict[str, Any]:
    """Aus rohem Codex-Settings-Seitentext Plan + Limits + Reset-Zeiten extrahieren.

    Codex zeigt typischerweise zwei Fenster: 5-Stunden-Bucket und Wochen-Bucket.
    Wir versuchen beide zu fischen und auf das gleiche Schema wie Claude zu mappen,
    damit Frontend einheitlich rendern kann.
    """
    out: dict[str, Any] = {}
    now = datetime.now(TZ)
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]

    # Plan: "Plus" / "Pro" / "Business" (englisch oder deutsch)
    m_plan = re.search(r"\b(ChatGPT\s+)?(Plus|Pro|Business|Team|Enterprise|Free)\b", text)
    if m_plan:
        out["plan"] = m_plan.group(2)

    # ── 5-Stunden-Bucket (Codex nennt das "5h limit" oder "Session") ──
    # Suche nach %-Werten + Reset-Zeitstempel in einem 5h-Block.
    for anchor in ("5-hour", "5h", "5 hour", "Local", "Sitzung", "Session"):
        block = _block_after(lines, anchor, window=6)
        if not block:
            continue
        for ln in block:
            m_pct = re.search(r"(\d{1,3})\s*%", ln)
            if m_pct and "session_used_pct" not in out:
                out["session_used_pct"] = int(m_pct.group(1))
            m_in = re.search(r"resets?\s+in\s+(\d+)\s*h(?:\s*(\d+)\s*m)?", ln, re.I)
            if m_in:
                h = int(m_in.group(1))
                mn = int(m_in.group(2) or 0)
                reset = now + timedelta(hours=h, minutes=mn)
                out["session_resets_at"] = reset.replace(second=0, microsecond=0).isoformat(timespec="seconds")
                out["session_resets_in_min"] = h * 60 + mn
        if "session_used_pct" in out:
            break

    # ── Wochenlimit ──
    for anchor in ("Weekly", "Woche", "week"):
        block = _block_after(lines, anchor, window=6)
        if not block:
            continue
        for ln in block:
            m_pct = re.search(r"(\d{1,3})\s*%", ln)
            if m_pct and "week_used_pct" not in out:
                out["week_used_pct"] = int(m_pct.group(1))
            m_in = re.search(r"resets?\s+in\s+(\d+)\s*d(?:\s*(\d+)\s*h)?", ln, re.I)
            if m_in:
                d = int(m_in.group(1))
                h = int(m_in.group(2) or 0)
                reset = now + timedelta(days=d, hours=h)
                out["week_resets_at"] = reset.replace(second=0, microsecond=0).isoformat(timespec="seconds")
        if "week_used_pct" in out:
            break

    return out


async def _async_check() -> dict[str, Any]:
    from patchright.async_api import async_playwright

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    SHOTS.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    captured_payloads: list[dict[str, Any]] = []
    result: dict[str, Any] = {
        "captured_at": _now_iso(),
        "plan": None,
        "session_used_pct": None,
        "session_resets_at": None,
        "session_resets_in_min": None,
        "week_used_pct": None,
        "week_resets_at": None,
        "raw_text": "",
        "confidence": "low",
        "source": None,
        "screenshot_path": None,
        "error": None,
    }

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            channel="chrome",
            headless=False,
            viewport={"width": 1280, "height": 900},
            no_viewport=True,
        )
        page = await ctx.new_page()

        async def on_response(resp):
            try:
                if not _interesting_url(resp.url):
                    return
                ctype = (resp.headers or {}).get("content-type", "")
                if "json" not in ctype.lower():
                    return
                body = await resp.json()
                captured_payloads.append({"url": resp.url, "body": body})
            except Exception:
                pass

        page.on("response", on_response)

        try:
            await page.goto(USAGE_URL, wait_until="domcontentloaded", timeout=30_000)
            for _ in range(15):
                await asyncio.sleep(1)
                try:
                    txt = await page.evaluate("() => document.body.innerText")
                except Exception:
                    txt = ""
                if "Checking" not in txt and "Cloudflare" not in txt:
                    break
            if "/login" in page.url or "/auth" in page.url:
                result["error"] = "not_logged_in"
                shot = SHOTS / f"login-redirect-{int(time.time())}.png"
                await page.screenshot(path=str(shot), full_page=False)
                result["screenshot_path"] = str(shot)
                await ctx.close()
                return result

            try:
                await page.wait_for_load_state("networkidle", timeout=8_000)
            except Exception:
                pass

            body_text = await page.evaluate("() => document.body.innerText")
            result["raw_text"] = (body_text or "")[:5000]

            # Network bevorzugt: das wham/usage-Endpoint liefert strukturiertes JSON.
            network_parsed: dict[str, Any] = {}
            for pl in captured_payloads:
                body = pl["body"]
                if isinstance(body, dict) and "rate_limit" in body and isinstance(body.get("rate_limit"), dict):
                    parsed = _parse_network_body(body)
                    if "session_used_pct" in parsed or "week_used_pct" in parsed:
                        network_parsed = parsed
                        result["source"] = "network"
                        result["network_url"] = pl["url"]
                        result["network_payload_keys"] = list(body.keys())
                        result["network_body"] = body
                        break

            if network_parsed:
                for k, v in network_parsed.items():
                    result[k] = v
                result["confidence"] = "high"
            else:
                parsed = _parse_text(body_text or "")
                for k, v in parsed.items():
                    if result.get(k) is None:
                        result[k] = v
                if parsed.get("week_used_pct") is not None or parsed.get("session_used_pct") is not None:
                    result["source"] = "dom"
                    result["confidence"] = "medium"

            shot = SHOTS / f"usage-{int(time.time())}.png"
            await page.screenshot(path=str(shot), full_page=True)
            result["screenshot_path"] = str(shot)

        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"
        finally:
            await ctx.close()

    return result


def _persist(result: dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    has_values = result.get("session_used_pct") is not None or result.get("week_used_pct") is not None
    has_error = bool(result.get("error"))
    if (has_error or not has_values) and LATEST.exists():
        try:
            prev = json.loads(LATEST.read_text(encoding="utf-8"))
            if prev.get("session_used_pct") is not None or prev.get("week_used_pct") is not None:
                prev["last_attempted_at"] = result.get("captured_at")
                prev["last_error"] = result.get("error") or "no_values"
                LATEST.write_text(json.dumps(prev, indent=2, ensure_ascii=False), encoding="utf-8")
                return
        except Exception:
            pass

    LATEST.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    if has_values:
        slim = {
            "captured_at": result.get("captured_at"),
            "session_used_pct": result.get("session_used_pct"),
            "session_resets_at": result.get("session_resets_at"),
            "session_resets_in_min": result.get("session_resets_in_min"),
            "week_used_pct": result.get("week_used_pct"),
            "week_resets_at": result.get("week_resets_at"),
        }
        with HISTORY.open("a", encoding="utf-8") as f:
            f.write(json.dumps(slim, ensure_ascii=False) + "\n")


def read_history(max_age_hours: int = 168) -> list[dict[str, Any]]:
    if not HISTORY.exists():
        return []
    cutoff = datetime.now(TZ) - timedelta(hours=max_age_hours)
    rows: list[dict[str, Any]] = []
    for line in HISTORY.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        cap = r.get("captured_at")
        if not cap:
            continue
        try:
            ts = datetime.fromisoformat(cap)
        except Exception:
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=TZ)
        if ts < cutoff:
            continue
        rows.append({
            "captured_at": r.get("captured_at"),
            "session_used_pct": r.get("session_used_pct"),
            "session_resets_at": r.get("session_resets_at"),
            "week_used_pct": r.get("week_used_pct"),
            "week_resets_at": r.get("week_resets_at"),
        })
    rows.sort(key=lambda r: r.get("captured_at") or "")
    return rows


def check_codex_usage() -> dict[str, Any]:
    result = asyncio.run(_async_check())
    _persist(result)
    return result


async def _async_login() -> None:
    from patchright.async_api import async_playwright

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            channel="chrome",
            headless=False,
            viewport={"width": 1280, "height": 900},
        )
        page = await ctx.new_page()
        await page.goto(LOGIN_URL)
        print("\n→ Login-Fenster ist offen. Logg dich bei chatgpt.com ein.")
        print("→ Schliesse das Fenster NICHT -- es macht sich selbst zu,")
        print("  sobald der Login durch ist.\n", flush=True)

        deadline = time.time() + 600
        while time.time() < deadline:
            await asyncio.sleep(2)
            try:
                url = page.url
                cookies = await ctx.cookies("https://chatgpt.com")
                has_session = any(
                    "session" in c["name"].lower() or "auth" in c["name"].lower()
                    for c in cookies
                )
                if "/login" not in url and "/auth" not in url and has_session and "chatgpt.com" in url:
                    print(f"Login erkannt ({url}). Persistiere Profil...", flush=True)
                    await asyncio.sleep(3)
                    await ctx.close()
                    print(f"Fertig. Profil liegt unter {PROFILE_DIR}", flush=True)
                    return
            except Exception:
                break

        print("Timeout nach 10 Minuten -- Profil nicht gespeichert.", flush=True)
        try:
            await ctx.close()
        except Exception:
            pass


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "login":
        asyncio.run(_async_login())
    elif cmd == "check":
        r = check_codex_usage()
        print(json.dumps(r, indent=2, ensure_ascii=False))
    else:
        print(f"Usage: python -m modules.usage.codex_service [login|check]", file=sys.stderr)
        sys.exit(1)
