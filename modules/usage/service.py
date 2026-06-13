"""Claude-Max-Wochenkontingent on-demand lesen.

Strategie (siehe brain/ideas/usage-monitor.md):

  1. Network-Sniff: schau ob claude.ai die Werte als XHR/Fetch laedt
     (URLs mit 'usage', 'limits', 'rate', 'subscription' oder 'organization').
  2. DOM-Read: extrahiere sichtbaren Text der Settings-Page.
  3. Heuristik: aus dem rohen Text Prozent + Reset-Zeit parsen.

Persistentes Browser-Profil unter `data/usage/claude_profile/`.
Einmaliger Login via `python -m modules.usage.service login` (headed).
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent.parent
DATA_DIR = ROOT / "data" / "usage"
PROFILE_DIR = DATA_DIR / "claude_profile"
LATEST = DATA_DIR / "latest.json"
HISTORY = DATA_DIR / "history.jsonl"
SHOTS = DATA_DIR / "screenshots"

USAGE_URL = "https://claude.ai/settings/usage"
LOGIN_URL = "https://claude.ai/login"

TZ = ZoneInfo("Europe/Berlin")


def _now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def _interesting_url(url: str) -> bool:
    u = url.lower()
    if "claude.ai" not in u and "anthropic" not in u:
        return False
    needles = ("usage", "limit", "rate", "subscription", "organization", "billing", "quota", "plan")
    return any(n in u for n in needles)


_WEEKDAY_DE = {"Mo.": 0, "Di.": 1, "Mi.": 2, "Do.": 3, "Fr.": 4, "Sa.": 5, "So.": 6}


def _next_weekday_at(now: datetime, weekday: int, hour: int, minute: int) -> datetime:
    """Naechster Wochentag (Mo=0..So=6) mit Uhrzeit in TZ des `now`."""
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    delta = (weekday - now.weekday()) % 7
    if delta == 0 and target <= now:
        delta = 7
    return target + timedelta(days=delta)


def _block_after(lines: list[str], anchor: str, window: int = 8) -> list[str]:
    """Liefert die naechsten `window` Zeilen nach der ersten Zeile, die `anchor` enthaelt."""
    for i, ln in enumerate(lines):
        if anchor.lower() in ln.lower():
            return lines[i + 1 : i + 1 + window]
    return []


def _parse_text(text: str) -> dict[str, Any]:
    """Aus rohem Settings-Seitentext alle Limits + Reset-Zeiten extrahieren."""
    out: dict[str, Any] = {}
    now = datetime.now(TZ)
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]

    # Plan: "Max (20x)" oder "Max 20x" oder "Pro" / "Team" / "Free"
    m_plan = re.search(r"\bMax\s*\(?\s*(\d+)\s*x\s*\)?", text, re.I)
    if m_plan:
        out["plan"] = f"Max {m_plan.group(1)}x"
    else:
        m_simple = re.search(r"\b(Pro|Team|Free)\b", text)
        if m_simple:
            out["plan"] = m_simple.group(1)

    # ── Aktuelle Sitzung ──
    sess_block = _block_after(lines, "Aktuelle Sitzung", window=6)
    for ln in sess_block:
        m_in = re.search(r"Zur[uü]cksetzung\s+in\s+(\d+)\s*Std\.?\s*(\d+)?\s*Min\.?", ln, re.I)
        if m_in:
            h = int(m_in.group(1))
            mn = int(m_in.group(2) or 0)
            reset = now + timedelta(hours=h, minutes=mn)
            out["session_resets_at"] = reset.replace(second=0, microsecond=0).isoformat(timespec="seconds")
            out["session_resets_in_min"] = h * 60 + mn
        m_pct = re.search(r"(\d{1,3})\s*%\s*verwendet", ln, re.I)
        if m_pct and "session_used_pct" not in out:
            out["session_used_pct"] = int(m_pct.group(1))

    # ── Woechentliche Limits / Alle Modelle ──
    week_block = _block_after(lines, "Alle Modelle", window=4)
    for ln in week_block:
        m_wd = re.search(r"Zur[uü]cksetzung\s+(Mo|Di|Mi|Do|Fr|Sa|So)\.?,?\s+(\d{1,2}):(\d{2})", ln, re.I)
        if m_wd:
            wd_key = m_wd.group(1).capitalize() + "."
            weekday = _WEEKDAY_DE.get(wd_key)
            if weekday is not None:
                reset = _next_weekday_at(now, weekday, int(m_wd.group(2)), int(m_wd.group(3)))
                out["week_resets_at"] = reset.isoformat(timespec="seconds")
        m_pct = re.search(r"(\d{1,3})\s*%\s*verwendet", ln, re.I)
        if m_pct and "week_used_pct" not in out:
            out["week_used_pct"] = int(m_pct.group(1))

    # Backwards-Compat: alter Feldname
    if "week_used_pct" in out:
        out["week_remaining_pct"] = 100 - out["week_used_pct"]

    # ── Routinen: "0 / 15" nach "Tägliche inbegriffene Routine-Ausführungen" ──
    routine_block = _block_after(lines, "Routine-Ausf", window=4)
    for ln in routine_block:
        m_r = re.match(r"(\d+)\s*/\s*(\d+)$", ln)
        if m_r:
            out["routines_used"] = int(m_r.group(1))
            out["routines_total"] = int(m_r.group(2))
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
        "week_remaining_pct": None,
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
            # Cloudflare-Challenge kann ein paar Sekunden brauchen
            for _ in range(15):
                await asyncio.sleep(1)
                try:
                    txt = await page.evaluate("() => document.body.innerText")
                except Exception:
                    txt = ""
                if "Sicherheits" not in txt and "Checking" not in txt and "Performance und Sicherheit" not in txt:
                    break
            # Login-Check: wenn auf login-Seite umgelenkt, abbruch
            if "/login" in page.url:
                result["error"] = "not_logged_in"
                shot = SHOTS / f"login-redirect-{int(time.time())}.png"
                await page.screenshot(path=str(shot), full_page=False)
                result["screenshot_path"] = str(shot)
                await ctx.close()
                return result

            # Settings-Page laedt Werte ggf. nach -- kurz warten.
            try:
                await page.wait_for_load_state("networkidle", timeout=8_000)
            except Exception:
                pass

            body_text = await page.evaluate("() => document.body.innerText")
            result["raw_text"] = (body_text or "")[:5000]

            # Strategie 1: Netzwerk
            for pl in captured_payloads:
                blob = json.dumps(pl["body"])
                if any(k in blob.lower() for k in ("usage", "limit", "remaining", "reset")):
                    result["source"] = "network"
                    result["network_url"] = pl["url"]
                    result["network_payload_keys"] = list(pl["body"].keys()) if isinstance(pl["body"], dict) else []
                    break

            # Strategie 2: DOM-Text parsen
            parsed = _parse_text(body_text or "")
            for k, v in parsed.items():
                if result.get(k) is None:
                    result[k] = v
            if parsed.get("week_remaining_pct") is not None:
                if not result["source"]:
                    result["source"] = "dom"
                result["confidence"] = "medium" if result["source"] == "dom" else "high"

            # Screenshot fuers Debugging (immer, klein)
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

    # Fallback: wenn der neue Scrape fehlschlaegt oder leer ist, den letzten
    # validen Snapshot behalten und nur die Versuch-Metadaten draufschreiben.
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
    # Nur sinnvolle Snapshots in die History (mit mindestens einem %-Wert).
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
    """Liefert Snapshots der letzten `max_age_hours` Stunden, alteste zuerst."""
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


def check_claude_usage() -> dict[str, Any]:
    """Synchroner Wrapper -- vom FastAPI-Endpoint aufgerufen."""
    result = asyncio.run(_async_check())
    _persist(result)
    return result


async def _async_login() -> None:
    """Headed Chromium oeffnen, auf erfolgreichen Login warten, Profil persistieren.

    Erkennt Login automatisch: sobald die URL nicht mehr /login enthaelt
    UND ein Session-Cookie gesetzt ist, wartet noch 3s fuer Persistenz
    und schliesst sich selbst.
    """
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
        print("\n→ Login-Fenster ist offen. Logg dich bei claude.ai ein.")
        print("→ Schliesse das Fenster NICHT -- es macht sich selbst zu,")
        print("  sobald der Login durch ist.\n", flush=True)

        deadline = time.time() + 600  # 10 min
        while time.time() < deadline:
            await asyncio.sleep(2)
            try:
                url = page.url
                cookies = await ctx.cookies("https://claude.ai")
                has_session = any(
                    c["name"].lower() in ("sessionkey", "session_key", "lastactiveorg")
                    or "session" in c["name"].lower()
                    for c in cookies
                )
                if "/login" not in url and has_session and "claude.ai" in url:
                    print(f"Login erkannt ({url}). Persistiere Profil...", flush=True)
                    await asyncio.sleep(3)
                    await ctx.close()
                    print(f"Fertig. Profil liegt unter {PROFILE_DIR}", flush=True)
                    return
            except Exception:
                # Page wurde manuell geschlossen oder navigiert
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
        r = check_claude_usage()
        print(json.dumps(r, indent=2, ensure_ascii=False))
    else:
        print(f"Usage: python -m modules.usage.service [login|check]", file=sys.stderr)
        sys.exit(1)
