"""YouTube router: schlanke Suche für das YouTube-Workspace-Modul (Stufe 1).

GET /api/youtube/search?q=...&limit=12

Datenquelle ist yt-dlp (ytsearch, flat-playlist), kein Data-API-Key nötig.
Der Extractor-Arg approximate_date liefert im Flat-Modus einen ungefähren
Upload-Timestamp, mehr Genauigkeit bräuchte teure Einzelabrufe.
"""

import json
import re
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from pydantic import BaseModel

from fastapi import APIRouter, HTTPException, Query

router = APIRouter()

_CACHE: dict = {}
_CACHE_TTL = 300  # Sekunden; Suchen sind langsam (~3-6s), Wiederholungen kommen aus dem Cache


def _yt_dlp_bin():
    found = shutil.which("yt-dlp")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"):
        if os.path.exists(candidate):
            return candidate
    return None


@router.get("/api/youtube/search")
def youtube_search(q: str = Query(..., min_length=1), limit: int = Query(12, ge=1, le=25)):
    query = q.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Leere Suchanfrage")
    cache_key = f"{limit}:{query.lower()}"
    hit = _CACHE.get(cache_key)
    if hit and time.time() - hit[0] < _CACHE_TTL:
        return {"results": hit[1], "cached": True}

    binpath = _yt_dlp_bin()
    if not binpath:
        raise HTTPException(status_code=503, detail="yt-dlp ist nicht installiert")
    cmd = [
        binpath,
        "--flat-playlist",
        "-J",
        "--extractor-args", "youtubetab:approximate_date",
        f"ytsearch{limit}:{query}",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="YouTube-Suche hat zu lange gedauert")
    if proc.returncode != 0:
        raise HTTPException(status_code=502, detail=f"yt-dlp Fehler: {(proc.stderr or '')[-300:]}")

    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="yt-dlp lieferte kein gültiges JSON")

    results = []
    for entry in data.get("entries") or []:
        video_id = entry.get("id")
        if not video_id:
            continue
        results.append({
            "id": video_id,
            "title": entry.get("title") or "",
            "channel": entry.get("channel") or entry.get("uploader") or "",
            "channel_id": entry.get("channel_id"),
            "duration": int(entry["duration"]) if entry.get("duration") else None,
            "views": entry.get("view_count"),
            "timestamp": entry.get("timestamp"),
            "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        })

    _CACHE[cache_key] = (time.time(), results)
    return {"results": results}


# ── Abo-Feed (Stufe 2) ──────────────────────────────────────────────────────
# Gefolgte Kanäle lokal als JSON, neueste Videos über die öffentlichen
# RSS-Feeds von YouTube (kein API-Key, kein Quota). Ein Abo-Import über
# Google-OAuth (youtube.readonly) ist als spätere Stufe vorgesehen.

FOLLOWS_PATH = Path(__file__).resolve().parents[2] / "data" / "youtube_follows.json"
_FEED_CACHE: dict = {}
_FEED_TTL = 600  # Sekunden pro Kanal-RSS


class FollowBody(BaseModel):
    channel_id: str
    name: str = ""


def _load_follows() -> list[dict]:
    try:
        data = json.loads(FOLLOWS_PATH.read_text())
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_follows(follows: list[dict]):
    FOLLOWS_PATH.parent.mkdir(parents=True, exist_ok=True)
    FOLLOWS_PATH.write_text(json.dumps(follows, ensure_ascii=False, indent=2))


@router.get("/api/youtube/follows")
def youtube_follows():
    return {"follows": _load_follows()}


@router.post("/api/youtube/follows")
def youtube_follow(body: FollowBody):
    cid = body.channel_id.strip()
    if not cid:
        raise HTTPException(status_code=400, detail="channel_id fehlt")
    follows = _load_follows()
    if not any(f.get("channel_id") == cid for f in follows):
        follows.append({"channel_id": cid, "name": body.name.strip() or cid})
        _save_follows(follows)
    return {"follows": follows}


@router.delete("/api/youtube/follows/{channel_id}")
def youtube_unfollow(channel_id: str):
    follows = [f for f in _load_follows() if f.get("channel_id") != channel_id]
    _save_follows(follows)
    _FEED_CACHE.pop(channel_id, None)
    return {"follows": follows}


def _fetch_channel_feed(channel_id: str) -> list[dict]:
    hit = _FEED_CACHE.get(channel_id)
    if hit and time.time() - hit[0] < _FEED_TTL:
        return hit[1]
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        root = ET.fromstring(resp.read())
    ns = {
        "a": "http://www.w3.org/2005/Atom",
        "yt": "http://www.youtube.com/xml/schemas/2015",
        "media": "http://search.yahoo.com/mrss/",
    }
    channel_name = (root.findtext("a:title", default="", namespaces=ns) or "").strip()
    items = []
    for entry in root.findall("a:entry", ns):
        video_id = entry.findtext("yt:videoId", default="", namespaces=ns)
        if not video_id:
            continue
        published = entry.findtext("a:published", default="", namespaces=ns)
        ts = None
        try:
            ts = int(datetime.fromisoformat(published).astimezone(timezone.utc).timestamp())
        except Exception:
            pass
        views = None
        stats = entry.find("media:group/media:community/media:statistics", ns)
        if stats is not None:
            try:
                views = int(stats.get("views") or "")
            except ValueError:
                pass
        items.append({
            "id": video_id,
            "title": (entry.findtext("a:title", default="", namespaces=ns) or "").strip(),
            "channel": channel_name,
            "channel_id": channel_id,
            "duration": None,  # RSS liefert keine Laufzeit
            "views": views,
            "timestamp": ts,
            "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        })
    _FEED_CACHE[channel_id] = (time.time(), items)
    return items


@router.get("/api/youtube/feed")
def youtube_feed(limit: int = Query(60, ge=1, le=200)):
    follows = _load_follows()
    if not follows:
        return {"results": []}
    results: list[dict] = []
    errors = 0
    with ThreadPoolExecutor(max_workers=6) as pool:
        for items in pool.map(
            lambda f: _safe_feed(f.get("channel_id", "")), follows
        ):
            if items is None:
                errors += 1
            else:
                results.extend(items)
    results.sort(key=lambda v: v.get("timestamp") or 0, reverse=True)
    picks = _load_picks()
    for v in results:
        pick = picks.get(v.get("id") or "")
        if pick:
            v["klaus_pick"] = True
            v["klaus_reason"] = pick.get("reason") or ""
    return {"results": results[:limit], "failed_channels": errors}


def _safe_feed(channel_id: str):
    if not channel_id:
        return []
    try:
        return _fetch_channel_feed(channel_id)
    except Exception:
        return None


# ── Abo-Import über Google OAuth (Stufe 3, Einmal-Import) ──────────────────
# Bewusst keine Dauerverbindung: Consumer-Tokens im Test-Mode-Projekt laufen
# nach 7 Tagen mit invalid_grant ab (brain/INFRA.md). Deshalb wird die
# Abo-Liste direkt nach dem Consent einmalig gezogen und in die lokalen
# Follows gemerged; danach läuft der Feed wie bisher tokenfrei über RSS.
# Redirect ist das registrierte http://localhost: der Nutzer kopiert nach dem
# Consent die volle Redirect-URL aus der Browserzeile zurück ins Modul
# (gleiches Muster wie scripts/oauth-denzer-init.py, funktioniert von jedem
# Gerät aus, kein erreichbarer Callback-Port nötig).

OAUTH_CLIENT_PATH = Path(__file__).resolve().parents[2] / ".secrets" / "google-oauth-denzer-client.json"
OAUTH_REDIRECT = "http://localhost"
YT_SCOPE = "https://www.googleapis.com/auth/youtube.readonly"


def _oauth_client() -> dict:
    try:
        data = json.loads(OAUTH_CLIENT_PATH.read_text())
        return data.get("installed") or data.get("web") or {}
    except Exception:
        return {}


@router.get("/api/youtube/import/start")
def youtube_import_start():
    client = _oauth_client()
    if not client.get("client_id"):
        raise HTTPException(status_code=503, detail="Google OAuth Client fehlt (.secrets/google-oauth-denzer-client.json)")
    params = urllib.parse.urlencode({
        "client_id": client["client_id"],
        "redirect_uri": OAUTH_REDIRECT,
        "response_type": "code",
        "scope": YT_SCOPE,
        "access_type": "online",
        "prompt": "consent",
    })
    return {"url": f"{client.get('auth_uri', 'https://accounts.google.com/o/oauth2/auth')}?{params}"}


class ImportFinishBody(BaseModel):
    redirect_url: str


def _google_post(url: str, form: dict) -> dict:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read()).get("error_description") or ""
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"Google Token Tausch fehlgeschlagen: {detail or e}")


def _fetch_subscriptions(access_token: str) -> list[dict]:
    channels: list[dict] = []
    page_token = None
    while True:
        query = {"part": "snippet", "mine": "true", "maxResults": "50"}
        if page_token:
            query["pageToken"] = page_token
        req = urllib.request.Request(
            "https://www.googleapis.com/youtube/v3/subscriptions?" + urllib.parse.urlencode(query),
            headers={"Authorization": f"Bearer {access_token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = (json.loads(e.read()).get("error") or {}).get("message") or ""
            except Exception:
                pass
            if e.code == 403 and ("not been used" in body.lower() or "disabled" in body.lower()):
                raise HTTPException(status_code=502, detail="YouTube Data API ist im Google Cloud Projekt nicht aktiviert. Einmal in der Cloud Console für das Projekt klaus-487921 freischalten, dann erneut importieren.")
            raise HTTPException(status_code=502, detail=f"Abo-Abruf fehlgeschlagen: {body or e}")
        for item in data.get("items") or []:
            snippet = item.get("snippet") or {}
            cid = (snippet.get("resourceId") or {}).get("channelId")
            if cid:
                channels.append({"channel_id": cid, "name": (snippet.get("title") or cid).strip()})
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return channels


@router.post("/api/youtube/import/finish")
def youtube_import_finish(body: ImportFinishBody):
    client = _oauth_client()
    if not client.get("client_id"):
        raise HTTPException(status_code=503, detail="Google OAuth Client fehlt")
    raw = body.redirect_url.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Redirect URL fehlt")
    code = raw
    if "://" in raw or "?" in raw:
        parsed = urllib.parse.urlparse(raw)
        code = (urllib.parse.parse_qs(parsed.query).get("code") or [""])[0]
    if not code:
        raise HTTPException(status_code=400, detail="Kein code in der URL gefunden")
    token_data = _google_post(client.get("token_uri", "https://oauth2.googleapis.com/token"), {
        "code": code,
        "client_id": client["client_id"],
        "client_secret": client.get("client_secret", ""),
        "redirect_uri": OAUTH_REDIRECT,
        "grant_type": "authorization_code",
    })
    access_token = token_data.get("access_token")
    if not access_token:
        raise HTTPException(status_code=502, detail="Google lieferte kein access_token")
    subs = _fetch_subscriptions(access_token)
    follows = _load_follows()
    known = {f.get("channel_id") for f in follows}
    added = 0
    for ch in subs:
        if ch["channel_id"] not in known:
            follows.append(ch)
            known.add(ch["channel_id"])
            added += 1
    if added:
        _save_follows(follows)
    return {"imported": added, "subscriptions": len(subs), "follows": follows}


# ── Video-Intelligenz: Dossiers und Merkliste (Stufe 4) ─────────────────────
# Beim Abspielen entscheidet eine billige Heuristik (Titel + Kanal), ob ein
# Video Inhalt ist (KI, Business, Tech) oder Musik/Unterhaltung. Inhalt wird
# automatisch verarbeitet: Transkript via skills/youtube-transcript, daraus
# per Default-Engine mit Fallback eine kompakte Auswertung. Ablage als Dossier unter
# data/youtube/dossiers/<video_id>.md, ausdrücklich nicht als Brain-Wahrheit.

import threading
import tempfile

ROOT = Path(__file__).resolve().parents[2]
YT_DATA_DIR = ROOT / "data" / "youtube"
DOSSIER_DIR = YT_DATA_DIR / "dossiers"
DOSSIER_INDEX_PATH = DOSSIER_DIR / "index.json"
NOW_PLAYING_PATH = YT_DATA_DIR / "now_playing.json"
ACTIVITY_PATH = YT_DATA_DIR / "activity.jsonl"
WATCHLIST_PATH = ROOT / "data" / "youtube_watchlist.json"
TRANSCRIBE_SH = ROOT / "skills" / "youtube-transcript" / "transcribe.sh"

_DOSSIER_LOCK = threading.Lock()
_DOSSIER_INFLIGHT: set[str] = set()
_ACTIVITY_LAST: dict[tuple[str, str], float] = {}

# Inhalts-Hinweise: ein Wort-Treffer reicht, dann wird verarbeitet.
# Wortgrenzen statt Substrings, sonst matcht "ai" in "trailer" oder "daily".
_CONTENT_RE = re.compile(
    r"\b(ai|ki|k\.i|llm\w*|gpt\w*|claude|openai|anthropic|gemini|copilot|"
    r"chatbots?|prompts?\w*|automat\w*|workflows?|n8n|coding|codes?|"
    r"programm\w*|software|developer\w*|entwickl\w*|startups?|business|"
    r"marketing|vertrieb\w*|sales|unternehm\w*|gründ\w*|geld\w*|umsatz\w*|"
    r"finanz\w*|invest\w*|produktiv\w*|tutorials?|tech|saas|tools?|apis?|"
    r"modell\w*|models?|robot\w*|mcp|workshops?|selbstständig\w*|kunden\w*|"
    r"agents?|agenten)\b",
    re.IGNORECASE,
)
_MUSIC_RE = re.compile(
    r"\b(official (video|audio)|music video|lyrics?|songs?|remix\w*|"
    r"full album|dj set|live performance|konzert\w*|concert\w*|soundtrack\w*|"
    r"instrumental\w*|karaoke|feat\.|ft\.|musik\w*|lofi|playlist)\b",
    re.IGNORECASE,
)
_FUN_RE = re.compile(
    r"\b(trailer\w*|gameplay|let'?s play|comedy|pranks?|vlogs?|highlights?|"
    r"funny|memes?|satire|best of)\b",
    re.IGNORECASE,
)


def _classify_video(title: str, channel: str) -> tuple[str, str]:
    """Billige Heuristik: ("content"|"skip", Grund). Bei Unsicherheit Inhalt."""
    text = f"{title} {channel}"
    chan = (channel or "").strip().lower()
    if chan.endswith("- topic") or "vevo" in chan:
        return "skip", "Musik-Kanal"
    if _CONTENT_RE.search(text):
        return "content", ""
    if _MUSIC_RE.search(text):
        return "skip", "sieht nach Musik aus"
    if _FUN_RE.search(text):
        return "skip", "sieht nach Unterhaltung aus"
    return "content", ""


def _load_dossier_index() -> dict:
    try:
        data = json.loads(DOSSIER_INDEX_PATH.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_dossier_entry(video_id: str, entry: dict):
    with _DOSSIER_LOCK:
        index = _load_dossier_index()
        index[video_id] = {**index.get(video_id, {}), **entry}
        DOSSIER_DIR.mkdir(parents=True, exist_ok=True)
        DOSSIER_INDEX_PATH.write_text(json.dumps(index, ensure_ascii=False, indent=2))


def _append_activity(event: str, video_id: str, **payload):
    """Best-effort Nutzungsspur fuer Jobs: ansehen, auswerten, Fehler, merken."""
    try:
        if not video_id:
            return
        now = time.time()
        key = (event, video_id)
        if event in {"watched", "analysis_viewed"} and now - _ACTIVITY_LAST.get(key, 0) < 300:
            return
        _ACTIVITY_LAST[key] = now
        YT_DATA_DIR.mkdir(parents=True, exist_ok=True)
        row = {
            "ts": now,
            "day": datetime.now().strftime("%Y-%m-%d"),
            "event": event,
            "video_id": video_id,
            **{k: v for k, v in payload.items() if v not in (None, "")},
        }
        with ACTIVITY_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    except Exception:
        pass


_DOSSIER_PROMPT = """Du bist der persönliche Agent des Nutzers. Der Nutzer arbeitet mit Agent Control (seinem persönlichen Agent-Betriebssystem) und will daraus konkreten Nutzen ziehen.

Unten steht das Transkript eines YouTube-Videos. Schreibe eine kompakte Auswertung auf Deutsch, Markdown, höchstens 350 Wörter, exakt diese Abschnitte:

## Kernaussagen
4 bis 7 Bullets, je ein Satz.

## Machen wir schon
Was davon läuft bei uns bereits (Agent Control). Kurz, ehrlich, 1 bis 3 Bullets oder "Nichts davon".

## Können wir uns abgucken
Konkrete übernehmbare Ideen, 1 bis 4 Bullets. Wenn nichts taugt, sag das.

## Bezug zu unseren Zielen
2 bis 3 Sätze: lohnt sich das für der Nutzer, und wofür genau.

Keine Gedankenstriche im Text, keine Einleitung, keine Schlussfloskel. Echte Umlaute.

Video: {title}
Kanal: {channel}

Transkript:
{transcript}"""


def _json_file(path: Path, fallback):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, type(fallback)) else fallback
    except Exception:
        return fallback


def _enabled_analysis_engines() -> list[str]:
    prefs = _json_file(ROOT / "config" / "preferences.json", {})
    default = str(prefs.get("control:engine:default") or "codex").strip().lower()
    agents = _json_file(ROOT / "config" / "agents.json", {})
    enabled = (((agents.get("agents") or {}).get("main") or {}).get("engines") or ["codex", "claude"])
    order: list[str] = []
    for engine in [default, *enabled, "codex", "claude"]:
        engine = str(engine or "").strip().lower()
        if engine in {"codex", "claude"} and engine not in order:
            order.append(engine)
    return order


def _run_codex_sync(prompt: str, model: str = "gpt-5.5", timeout: float = 300.0) -> tuple[int, str, str]:
    with tempfile.NamedTemporaryFile(prefix="youtube-analysis-", suffix=".txt", delete=False) as tmp:
        out_path = tmp.name
    try:
        proc = subprocess.run(
            [
                "codex", "exec",
                "--model", model,
                "--skip-git-repo-check",
                "--dangerously-bypass-approvals-and-sandbox",
                "--sandbox", "read-only",
                "-C", str(ROOT),
                "-o", out_path,
                "-",
            ],
            input=prompt, capture_output=True, text=True, timeout=timeout,
        )
        try:
            text = Path(out_path).read_text(errors="replace").strip()
        except Exception:
            text = ""
        return proc.returncode, text or (proc.stdout or ""), proc.stderr or ""
    except subprocess.TimeoutExpired:
        return 1, "", "Codex CLI Timeout"
    finally:
        try:
            os.remove(out_path)
        except OSError:
            pass


def _run_claude_sync(prompt: str, model: str = "claude-sonnet-4-6", timeout: float = 300.0) -> tuple[int, str, str]:
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    try:
        proc = subprocess.run(
            ["claude", "-p", "--model", model],
            input=prompt, capture_output=True, text=True, timeout=timeout, env=env,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return 1, "", "Claude CLI Timeout"


def _run_analysis_sync(prompt: str, timeout: float = 300.0, *, claude_model: str = "claude-sonnet-4-6") -> tuple[int, str, str, str, str]:
    errors: list[str] = []
    for engine in _enabled_analysis_engines():
        if engine == "codex":
            if not shutil.which("codex"):
                errors.append("codex fehlt")
                continue
            model = "gpt-5.5"
            rc, out, err = _run_codex_sync(prompt, model=model, timeout=timeout)
        elif engine == "claude":
            if not shutil.which("claude"):
                errors.append("claude fehlt")
                continue
            model = claude_model
            rc, out, err = _run_claude_sync(prompt, model=model, timeout=timeout)
        else:
            continue
        if rc == 0 and (out or "").strip():
            return rc, out, err, engine, model
        errors.append(f"{engine}: {(err or out or 'leer')[-240:]}")
    return 1, "", " | ".join(errors)[-800:], "", ""


def _process_dossier(video_id: str, title: str, channel: str, source: str = "player"):
    """Läuft im Hintergrund-Thread: Transkript ziehen, auswerten, ablegen."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        proc = subprocess.run(
            ["bash", str(TRANSCRIBE_SH), url],
            capture_output=True, text=True, timeout=1200,
        )
        transcript = (proc.stdout or "").strip()
        if proc.returncode != 0 or len(transcript) < 200:
            err = (proc.stderr or "")[-300:] or "Transkript zu kurz oder leer"
            _save_dossier_entry(video_id, {"status": "error", "error": f"Transkript fehlgeschlagen: {err}", "ts": time.time()})
            _append_activity("dossier_error", video_id, title=title, channel=channel, source=source, error="transcript_failed")
            return
        prompt = _DOSSIER_PROMPT.format(title=title, channel=channel, transcript=transcript[:24000])
        rc, analysis, stderr, engine_used, model_used = _run_analysis_sync(prompt)
        analysis = (analysis or "").strip()
        if rc != 0 or not analysis:
            _save_dossier_entry(video_id, {"status": "error", "error": f"Auswertung fehlgeschlagen: {(stderr or '')[-200:]}", "ts": time.time()})
            _append_activity("dossier_error", video_id, title=title, channel=channel, source=source, error="analysis_failed")
            return
        created = datetime.now().strftime("%Y-%m-%d %H:%M")
        body = (
            f"---\nvideo_id: {video_id}\ntitle: \"{title}\"\nchannel: \"{channel}\"\n"
            f"url: {url}\nsource: {source}\ncreated: {created}\n---\n\n# {title}\n\n{analysis}\n\n"
            f"## Transkript\n\n{transcript[:80000]}\n"
        )
        DOSSIER_DIR.mkdir(parents=True, exist_ok=True)
        (DOSSIER_DIR / f"{video_id}.md").write_text(body, encoding="utf-8")
        _save_dossier_entry(video_id, {
            "status": "done", "title": title, "channel": channel, "source": source,
            "analysis_engine": engine_used, "analysis_model": model_used,
            "ts": time.time(), "error": "",
        })
        _append_activity(
            "dossier_done", video_id,
            title=title, channel=channel, source=source,
            analysis_engine=engine_used, analysis_model=model_used,
        )
    except Exception as e:
        _save_dossier_entry(video_id, {"status": "error", "error": str(e)[:300], "ts": time.time()})
        _append_activity("dossier_error", video_id, title=title, channel=channel, source=source, error=str(e)[:160])
    finally:
        with _DOSSIER_LOCK:
            _DOSSIER_INFLIGHT.discard(video_id)


def _start_dossier(video_id: str, title: str, channel: str, force: bool = False, source: str = "player") -> dict:
    """Klassifiziert und startet ggf. die Verarbeitung. Gibt den Index-Eintrag zurück."""
    index = _load_dossier_index()
    entry = index.get(video_id) or {}
    if entry.get("status") == "done":
        return entry
    if entry.get("status") == "processing" or video_id in _DOSSIER_INFLIGHT:
        return {"status": "processing", "title": title, "channel": channel}
    if not force:
        if entry.get("status") == "skipped":
            return entry
        kind, reason = _classify_video(title, channel)
        if kind == "skip":
            skipped = {"status": "skipped", "reason": reason, "title": title, "channel": channel, "ts": time.time()}
            _save_dossier_entry(video_id, skipped)
            _append_activity("dossier_skipped", video_id, title=title, channel=channel, reason=reason)
            return skipped
    with _DOSSIER_LOCK:
        _DOSSIER_INFLIGHT.add(video_id)
    _save_dossier_entry(video_id, {"status": "processing", "title": title, "channel": channel, "source": source, "ts": time.time(), "error": "", "reason": ""})
    threading.Thread(target=_process_dossier, args=(video_id, title, channel, source), daemon=True).start()
    return {"status": "processing", "title": title, "channel": channel}


def _read_analysis(video_id: str) -> str:
    """Auswertungs-Teil des Dossiers ohne Transkript."""
    try:
        text = (DOSSIER_DIR / f"{video_id}.md").read_text(encoding="utf-8")
    except Exception:
        return ""
    cut = text.find("## Transkript")
    if cut != -1:
        text = text[:cut]
    # Frontmatter und Titel-H1 abschneiden, die Karte zeigt den Titel selbst
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            text = text[end + 3:]
    lines = [ln for ln in text.strip().splitlines() if not ln.startswith("# ")]
    return "\n".join(lines).strip()


class DossierBody(BaseModel):
    title: str = ""
    channel: str = ""
    force: bool = False


@router.post("/api/youtube/dossier/{video_id}")
def youtube_dossier_start(video_id: str, body: DossierBody):
    vid = video_id.strip()
    if not vid:
        raise HTTPException(status_code=400, detail="video_id fehlt")
    entry = _start_dossier(vid, body.title.strip(), body.channel.strip(), force=body.force)
    return {"video_id": vid, **entry}


@router.get("/api/youtube/dossier/{video_id}")
def youtube_dossier_get(video_id: str):
    vid = video_id.strip()
    entry = _load_dossier_index().get(vid)
    if not entry:
        return {"video_id": vid, "status": "none"}
    out = {"video_id": vid, **entry}
    if entry.get("status") == "done":
        out["analysis"] = _read_analysis(vid)
        _append_activity(
            "analysis_viewed", vid,
            title=entry.get("title") or "", channel=entry.get("channel") or "",
            source=entry.get("source") or "",
        )
    return out


# ── Now Playing: aktuell laufendes Video für den Chat-Kontext ───────────────

class NowPlayingBody(BaseModel):
    video: dict | None = None


@router.post("/api/youtube/now-playing")
def youtube_now_playing(body: NowPlayingBody):
    YT_DATA_DIR.mkdir(parents=True, exist_ok=True)
    video = body.video if isinstance(body.video, dict) and body.video.get("id") else None
    NOW_PLAYING_PATH.write_text(json.dumps({"video": video, "ts": time.time()}, ensure_ascii=False))
    if video:
        _append_activity(
            "watched", str(video["id"]),
            title=str(video.get("title") or ""), channel=str(video.get("channel") or ""),
            channel_id=video.get("channel_id") or "",
        )
        # Auto-Verarbeitung beim Abspielen; Heuristik entscheidet still.
        _start_dossier(str(video["id"]), str(video.get("title") or ""), str(video.get("channel") or ""))
    return {"ok": True}


def get_now_playing(max_age: float = 7200.0) -> dict | None:
    """Aktuell laufendes Video samt Dossier-Status, für Chat-Kontext-Mechanismen."""
    try:
        data = json.loads(NOW_PLAYING_PATH.read_text())
    except Exception:
        return None
    video = data.get("video")
    if not video or time.time() - float(data.get("ts") or 0) > max_age:
        return None
    vid = str(video.get("id") or "")
    entry = _load_dossier_index().get(vid) or {}
    return {
        "video": video,
        "dossier_status": entry.get("status") or "none",
        "dossier_path": str(DOSSIER_DIR / f"{vid}.md") if entry.get("status") == "done" else "",
    }


# ── Merkliste ────────────────────────────────────────────────────────────────
# saved_by: "christian" (gemerkt) oder "klaus" (Empfehlungs-Flag, das spätere
# Automatiken setzen können).

class WatchlistBody(BaseModel):
    id: str
    title: str = ""
    channel: str = ""
    channel_id: str | None = None
    thumbnail: str = ""
    duration: int | None = None
    saved_by: str = "christian"


def _load_watchlist() -> list[dict]:
    try:
        data = json.loads(WATCHLIST_PATH.read_text())
        return data if isinstance(data, list) else []
    except Exception:
        return []


@router.get("/api/youtube/watchlist")
def youtube_watchlist():
    return {"items": _load_watchlist()}


@router.post("/api/youtube/watchlist")
def youtube_watchlist_add(body: WatchlistBody):
    vid = body.id.strip()
    if not vid:
        raise HTTPException(status_code=400, detail="id fehlt")
    items = _load_watchlist()
    if not any(it.get("id") == vid for it in items):
        items.insert(0, {
            "id": vid,
            "title": body.title.strip(),
            "channel": body.channel.strip(),
            "channel_id": body.channel_id,
            "thumbnail": body.thumbnail or f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            "duration": body.duration,
            "saved_by": body.saved_by if body.saved_by in ("christian", "klaus") else "christian",
            "ts": time.time(),
        })
        WATCHLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
        WATCHLIST_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2))
        _append_activity(
            "saved", vid,
            title=body.title.strip(), channel=body.channel.strip(),
            channel_id=body.channel_id or "", saved_by=body.saved_by if body.saved_by in ("christian", "klaus") else "christian",
        )
    return {"items": items}


@router.delete("/api/youtube/watchlist/{video_id}")
def youtube_watchlist_remove(video_id: str):
    items = [it for it in _load_watchlist() if it.get("id") != video_id]
    WATCHLIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    WATCHLIST_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2))
    return {"items": items}


# ── Kuratierung und Radar-Verschmelzung (Stufe 5) ───────────────────────────
# Picks sind Klaus-Markierungen im Feed: video_id -> {reason, source, ts}.
# Quellen: "kuratierung" (billiger Vorab-Check neuer Abo-Videos) und "radar"
# (nächtlicher radar-youtube-Job legt Funde als finds.json ab, der Server
# zieht sie morgens als Dossiers ein). source bleibt generisch, damit später
# Podcasts oder Artikel denselben Weg nehmen können.

PICKS_PATH = YT_DATA_DIR / "picks.json"
CURATE_STATE_PATH = YT_DATA_DIR / "curate_state.json"
RADAR_DATA_DIR = ROOT / "jobs" / "radar-youtube" / "data"
_CURATE_INTERVAL = 6 * 3600
_PICKS_LOCK = threading.Lock()
_CURATE_INFLIGHT = threading.Event()


def _load_picks() -> dict:
    try:
        data = json.loads(PICKS_PATH.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_pick(video_id: str, entry: dict):
    with _PICKS_LOCK:
        picks = _load_picks()
        picks[video_id] = {**picks.get(video_id, {}), **entry}
        YT_DATA_DIR.mkdir(parents=True, exist_ok=True)
        PICKS_PATH.write_text(json.dumps(picks, ensure_ascii=False, indent=2))


def _load_curate_state() -> dict:
    try:
        data = json.loads(CURATE_STATE_PATH.read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_curate_state(state: dict):
    YT_DATA_DIR.mkdir(parents=True, exist_ok=True)
    CURATE_STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2))


_CURATE_PROMPT = """Du bist der persönliche Agent des Nutzers. Der Nutzer arbeitet mit Agent Control (seinem Agent-Betriebssystem) und will weniger, aber besser schauen.

Unten neue Videos aus seinem Abo-Feed, je Zeile: ID | Kanal | Titel. Wähle höchstens {max_picks} Videos aus, die sich für ihn wirklich lohnen (neue Capabilities, Claude/Claude Code, Agent-Architektur, übernehmbare Systeme, Marktbewegungen mit Konsequenz). Reine Nacherzählung, Hype ohne Substanz, Entertainment: nicht auswählen. Null Auswahlen sind völlig okay.

Antworte ausschließlich mit einem JSON-Array, kein anderer Text:
[{{"id": "<ID>", "grund": "<ein Satz auf Deutsch, warum sich das Video für den Nutzer lohnt>"}}]

Videos:
{videos}"""


def _ingest_radar_finds() -> int:
    """Radar-Funde (jobs/radar-youtube/data/*-finds.json) als Picks und Dossiers einziehen."""
    ingested = 0
    for fp in sorted(RADAR_DATA_DIR.glob("*-finds.json")):
        marker = Path(str(fp) + ".done")
        if marker.exists():
            continue
        try:
            entries = json.loads(fp.read_text())
        except Exception:
            marker.write_text("parse-error")
            continue
        if isinstance(entries, list):
            for e in entries:
                if not isinstance(e, dict):
                    continue
                vid = str(e.get("id") or "").strip()
                if not vid:
                    continue
                title = str(e.get("title") or "").strip()
                channel = str(e.get("channel") or "").strip()
                reason = str(e.get("grund") or e.get("reason") or "").strip()
                _save_pick(vid, {"reason": reason, "source": "radar", "title": title, "channel": channel, "ts": time.time()})
                _start_dossier(vid, title, channel, force=True, source="radar")
                ingested += 1
        marker.write_text(datetime.now().isoformat())
    return ingested


def _curate_new_feed_videos() -> int:
    """Billiger Vorab-Check: neue Abo-Videos bewerten, Treffer als Pick markieren."""
    state = _load_curate_state()
    seen = state.get("seen") if isinstance(state.get("seen"), dict) else {}
    picks = _load_picks()
    cutoff = time.time() - 48 * 3600
    candidates = []
    for f in _load_follows():
        items = _safe_feed(f.get("channel_id", "")) or []
        for v in items:
            vid = v.get("id") or ""
            if not vid or vid in seen or vid in picks:
                continue
            if (v.get("timestamp") or 0) < cutoff:
                continue
            kind, _reason = _classify_video(v.get("title") or "", v.get("channel") or "")
            if kind != "content":
                seen[vid] = time.time()
                continue
            candidates.append(v)
    picked = 0
    if candidates:
        candidates = candidates[:40]
        lines = "\n".join(f"{v['id']} | {v.get('channel') or ''} | {v.get('title') or ''}" for v in candidates)
        prompt = _CURATE_PROMPT.format(max_picks=4, videos=lines)
        rc, out, _err, engine_used, model_used = _run_analysis_sync(prompt, timeout=180.0, claude_model="claude-haiku-4-5-20251001")
        by_id = {v["id"]: v for v in candidates}
        if rc == 0 and out.strip():
            try:
                m = re.search(r"\[.*\]", out, re.DOTALL)
                chosen = json.loads(m.group(0)) if m else []
            except Exception:
                chosen = []
            for c in chosen:
                vid = str(c.get("id") or "").strip()
                v = by_id.get(vid)
                if not v:
                    continue
                _save_pick(vid, {
                    "reason": str(c.get("grund") or "").strip(),
                    "source": "kuratierung",
                    "analysis_engine": engine_used,
                    "analysis_model": model_used,
                    "title": v.get("title") or "", "channel": v.get("channel") or "",
                    "ts": time.time(),
                })
                picked += 1
            for v in candidates:
                seen[v["id"]] = time.time()
    # seen-Liste nicht endlos wachsen lassen
    horizon = time.time() - 14 * 24 * 3600
    state["seen"] = {k: ts for k, ts in seen.items() if ts > horizon}
    state["ts"] = time.time()
    _save_curate_state(state)
    return picked


def run_curation_cycle() -> dict:
    """Ein Durchlauf: Radar-Funde einziehen, dann neue Feed-Videos kuratieren."""
    if _CURATE_INFLIGHT.is_set():
        return {"skipped": "läuft bereits"}
    _CURATE_INFLIGHT.set()
    try:
        ingested = _ingest_radar_finds()
        picked = _curate_new_feed_videos()
        return {"radar_ingested": ingested, "picked": picked}
    finally:
        _CURATE_INFLIGHT.clear()


def _curation_loop():
    # kurzer Anlauf, damit der Serverstart nicht sofort RSS- und LLM-Last zieht
    time.sleep(120)
    while True:
        try:
            state = _load_curate_state()
            if time.time() - float(state.get("ts") or 0) >= _CURATE_INTERVAL or any(
                not Path(str(fp) + ".done").exists() for fp in RADAR_DATA_DIR.glob("*-finds.json")
            ):
                run_curation_cycle()
        except Exception:
            pass
        time.sleep(900)


threading.Thread(target=_curation_loop, daemon=True, name="yt-curation").start()


@router.post("/api/youtube/curate")
def youtube_curate():
    if _CURATE_INFLIGHT.is_set():
        return {"started": False, "detail": "Kuratierung läuft bereits"}
    threading.Thread(target=run_curation_cycle, daemon=True).start()
    return {"started": True}


@router.get("/api/youtube/picks")
def youtube_picks():
    return {"picks": _load_picks()}
