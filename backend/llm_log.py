"""LLM-Call-Logger.

Jeder LLM-Aufruf wird hier mit feature/provider/model/latency_ms protokolliert.
Quelle für den Engines-Tab, Limits-Tab und die Auswertung „wie viel macht Qwen wirklich".

Fire-and-forget: Fehler beim Schreiben dürfen den eigentlichen Call nie kippen.
"""
import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "chat.db"

# Standard-API-Preise je 1M Tokens (USD). Stand 2026-05.
# https://docs.claude.com/en/docs/about-claude/pricing
# Cache-Read = 10% Input, Cache-Creation = 125% Input.
_PRICING = {
    # Anthropic
    "claude-opus-4-8":   {"in":  5.00, "out": 25.00},
    "claude-fable-5":    {"in":  5.00, "out": 25.00},  # TODO Preis verifizieren
    "claude-fable-5-mythos-5": {"in":  5.00, "out": 25.00},  # TODO Preis verifizieren
    "claude-opus-4-7":   {"in":  5.00, "out": 25.00},
    "claude-opus-4-6":   {"in": 15.00, "out": 75.00},
    "claude-opus-4":     {"in": 15.00, "out": 75.00},
    "claude-sonnet-4-6": {"in":  3.00, "out": 15.00},
    "claude-sonnet-4":   {"in":  3.00, "out": 15.00},
    "claude-haiku-4-5":  {"in":  1.00, "out":  5.00},
    # OpenAI Codex / GPT-5
    "gpt-5.5":           {"in":  5.00, "out": 30.00},
    "GPT-5.5":           {"in":  5.00, "out": 30.00},
    "gpt-5.4":           {"in":  2.50, "out": 15.00},
    "GPT-5.4":           {"in":  2.50, "out": 15.00},
    "gpt-5-codex":       {"in":  1.25, "out": 10.00},
    "gpt-5":             {"in":  1.25, "out": 10.00},
    "gpt-5-mini":        {"in":  0.25, "out":  2.00},
    # Qwen via OpenRouter (grob)
    "qwen/qwen3-vl-30b": {"in":  0.10, "out":  0.30},
    # Groq
    "llama-3.1-8b-instant": {"in": 0.05, "out": 0.08},
}


def _cost(provider: str, model: str, input_tokens: int, output_tokens: int, cache_read: int, cache_creation: int) -> float:
    """Berechne USD-Kosten. Lokale Modelle (ollama) → 0."""
    p = _PRICING.get(model)
    if not p:
        return 0.0
    # Anthropic liefert uncached input getrennt von cache_read/creation.
    # OpenAI/Codex liefert input_tokens inklusive cached_input_tokens.
    if (provider or "").lower() == "openai":
        base_in = max(0, input_tokens - cache_read)
    else:
        base_in = max(0, input_tokens)
    cost = (
        base_in * p["in"] / 1_000_000
        + cache_read * p["in"] * 0.10 / 1_000_000
        + cache_creation * p["in"] * 1.25 / 1_000_000
        + output_tokens * p["out"] / 1_000_000
    )
    return round(cost, 6)


def log_call(
    feature: str,
    provider: str,
    model: str,
    latency_ms: float,
    ok: bool = True,
    fallback_from: str = "",
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
    conversation_id: str = "",
) -> None:
    try:
        cost = _cost(provider or "", model or "", input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
        db = sqlite3.connect(DB_PATH, timeout=2)
        db.execute(
            """INSERT INTO llm_calls(
                ts, feature, provider, model, latency_ms, ok, fallback_from,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, conversation_id
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                time.time(),
                feature or "unknown",
                provider or "unknown",
                model or "",
                int(latency_ms),
                1 if ok else 0,
                fallback_from or "",
                int(input_tokens or 0),
                int(output_tokens or 0),
                int(cache_read_tokens or 0),
                int(cache_creation_tokens or 0),
                float(cost),
                conversation_id or "",
            ),
        )
        db.commit()
        db.close()
    except Exception:
        pass


def stats_since(seconds: int = 86400) -> dict:
    """Liefert Aggregate je feature über die letzten N Sekunden."""
    since = time.time() - seconds
    out: dict[str, dict] = {}
    try:
        db = sqlite3.connect(DB_PATH, timeout=2)
        rows = db.execute(
            """SELECT feature, provider, model, latency_ms, ok, fallback_from
               FROM llm_calls WHERE ts >= ?""",
            (since,),
        ).fetchall()
        db.close()
    except Exception:
        return out
    buckets: dict[str, list] = {}
    for feature, provider, model, lat, ok, fb in rows:
        buckets.setdefault(feature, []).append((provider, model, lat, ok, fb))
    for feature, items in buckets.items():
        n = len(items)
        latencies = sorted(int(x[2]) for x in items)
        median = latencies[n // 2] if n else 0
        errors = sum(1 for x in items if not x[3])
        fallbacks = sum(1 for x in items if x[4])
        last = items[-1]
        out[feature] = {
            "calls": n,
            "provider": last[0],
            "model": last[1],
            "median_latency_ms": median,
            "error_pct": round(100.0 * errors / n) if n else 0,
            "fallback_pct": round(100.0 * fallbacks / n) if n else 0,
        }
    return out


def limits_snapshot() -> dict:
    """Aggregate für den Limits-Tab: aktueller Kalender-Monat, je Provider.

    Liefert Calls, Tokens (in/out/cached), Cost-USD pro Provider plus
    Gesamt-Summen und Restbudget gegen den $200 Agent-SDK-Credit.
    """
    import datetime as _dt
    now = _dt.datetime.now()
    month_start = _dt.datetime(now.year, now.month, 1).timestamp()
    today_start = _dt.datetime(now.year, now.month, now.day).timestamp()

    out = {
        "month": now.strftime("%Y-%m"),
        "today": now.strftime("%Y-%m-%d"),
        "providers": [],
        "totals": {
            "calls": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cost_usd_month": 0.0,
            "cost_usd_today": 0.0,
        },
        "agent_sdk_credit_usd": 200.0,
        "cutover_date": "2026-06-15",
    }
    try:
        db = sqlite3.connect(DB_PATH, timeout=2)
        # Chat-Engines laufen hier als Abo-/CLI-Nutzung. Ihre Token sind fuer
        # Quota-Diagnose wertvoll, aber keine belastbare API-Monatsrechnung.
        rows = db.execute(
            """SELECT provider, model,
                      COUNT(*) as calls,
                      SUM(input_tokens) as ti,
                      SUM(output_tokens) as to_,
                      SUM(cache_read_tokens) as cr,
                      SUM(CASE WHEN feature IN ('chat_codex', 'chat_claude') THEN 0 ELSE cost_usd END) as c_month,
                      SUM(CASE WHEN ts >= ? AND feature NOT IN ('chat_codex', 'chat_claude') THEN cost_usd ELSE 0 END) as c_today,
                      SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) as calls_today
               FROM llm_calls
               WHERE ts >= ?
               GROUP BY provider, model
               ORDER BY c_month DESC""",
            (today_start, today_start, month_start),
        ).fetchall()
        db.close()
    except Exception:
        return out

    for provider, model, calls, ti, to_, cr, c_month, c_today, calls_today in rows:
        out["providers"].append({
            "provider": provider,
            "model": model,
            "calls": int(calls or 0),
            "calls_today": int(calls_today or 0),
            "input_tokens": int(ti or 0),
            "output_tokens": int(to_ or 0),
            "cache_read_tokens": int(cr or 0),
            "cost_usd_month": round(float(c_month or 0), 4),
            "cost_usd_today": round(float(c_today or 0), 4),
        })
        out["totals"]["calls"] += int(calls or 0)
        out["totals"]["input_tokens"] += int(ti or 0)
        out["totals"]["output_tokens"] += int(to_ or 0)
        out["totals"]["cache_read_tokens"] += int(cr or 0)
        out["totals"]["cost_usd_month"] += float(c_month or 0)
        out["totals"]["cost_usd_today"] += float(c_today or 0)

    out["totals"]["cost_usd_month"] = round(out["totals"]["cost_usd_month"], 4)
    out["totals"]["cost_usd_today"] = round(out["totals"]["cost_usd_today"], 4)

    # Anthropic-Sicht: was würde der Agent-SDK-Credit nach Cutover kosten
    anthropic_month = sum(
        p["cost_usd_month"] for p in out["providers"] if p["provider"] == "anthropic"
    )
    out["agent_sdk_used_usd_month"] = round(anthropic_month, 4)
    out["agent_sdk_remaining_usd"] = round(max(0.0, out["agent_sdk_credit_usd"] - anthropic_month), 2)
    out["agent_sdk_pct"] = round(min(100.0, 100.0 * anthropic_month / out["agent_sdk_credit_usd"]), 1)
    return out
