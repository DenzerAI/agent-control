"""Voice router: TTS (ElevenLabs) + STT (Groq) core.

Extrahiert aus server.py als erster Schnitt der Modularisierung. KEIN
Verhalten geändert, nur verschoben.

Routen:
- POST /api/transcribe          — Groq Whisper STT
- GET  /api/voices              — kuratierte Stimmen + ElevenLabs-Previews
- POST /api/tts                 — ElevenLabs Synthese (gecacht)
- GET  /api/tts-audio/{key}.mp3 — gecachtes MP3 per GET (iOS PWA Range)
- GET  /api/voice/status        — Voice-Mode konfiguriert?
- GET  /api/voice/signed-url    — signierte ConvAI-WebSocket-URL

Geteilte Helfer, die in server.py BLEIBEN (weil dort noch von anderen,
nicht verschobenen Routen genutzt) und hier neu definiert/late-importiert
werden:
- _get_groq_key / _get_elevenlabs_key / _get_elevenlabs_agent_id:
  triviale os.environ-Getter, hier dupliziert (kein Import nötig).
- AGENTS / _AGENT_NAME_TO_ID: in server.py gebaut; per Late-Import
  innerhalb der Funktionen geholt, um Zirkularität zu vermeiden.
"""

import os
import re as _re
import json
import asyncio
import hashlib
import urllib.request
import urllib.error
from collections import OrderedDict
from pathlib import Path

from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse

from db import get_conversation

router = APIRouter()

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


# ── Key-Getter (triviale os.environ-Reader, in server.py gespiegelt) ──

def _get_groq_key() -> str:
    return os.environ.get("GROQ_API_KEY", "")


def _get_elevenlabs_key() -> str:
    """API-Key aus .env."""
    return os.environ.get("ELEVENLABS_API_KEY", "")


def _get_elevenlabs_agent_id() -> str:
    """ConvAI Agent-ID aus .env."""
    return os.environ.get("ELEVENLABS_AGENT_ID", "")


# ── STT (Groq Whisper) ──

@router.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    import httpx
    api_key = _get_groq_key()
    if not api_key:
        return JSONResponse({"error": "no groq key"}, status_code=400)
    data = await file.read()
    if not data:
        return JSONResponse({"error": "empty file"}, status_code=400)
    ext = Path(file.filename or "audio.webm").suffix or ".webm"
    last_err = "transcription failed"
    async with httpx.AsyncClient(timeout=120) as client:
        for attempt in range(2):
            try:
                resp = await client.post(
                    "https://api.groq.com/openai/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    files={"file": (f"audio{ext}", data, file.content_type or "audio/webm")},
                    data={"model": "whisper-large-v3", "language": "de"},
                )
            except httpx.HTTPError as e:
                last_err = f"network: {e}"
                if attempt == 0:
                    await asyncio.sleep(1.0)
                    continue
                return JSONResponse({"error": last_err}, status_code=502)
            if resp.status_code == 200:
                return JSONResponse({"text": resp.json().get("text", "")})
            if 500 <= resp.status_code < 600 and attempt == 0:
                await asyncio.sleep(1.0)
                continue
            try:
                last_err = resp.json().get("error", {}).get("message", "transcription failed")
            except Exception:
                last_err = f"groq {resp.status_code}"
            return JSONResponse({"error": last_err}, status_code=resp.status_code)
    return JSONResponse({"error": last_err}, status_code=502)


# ── TTS Cache: LRU of rendered MP3 bytes, keyed by (voice_id, text) ──
# Saves ElevenLabs API calls for repeated messages (cron results, replays).
# Mirror auch auf Disk unter data/tts-cache/<hash>.mp3, damit iOS PWA das
# Audio per GET-URL streamen kann (Range-Support, kein Blob-Read auf POST).
_TTS_CACHE: "OrderedDict[str, bytes]" = OrderedDict()
_TTS_CACHE_MAX_ENTRIES = 200
_TTS_CACHE_MAX_BYTES = 50 * 1024 * 1024  # 50 MB
_TTS_CACHE_BYTES = 0
_TTS_DISK_DIR = PROJECT_ROOT / "data" / "tts-cache"
_TTS_DISK_DIR.mkdir(parents=True, exist_ok=True)

def _tts_cache_key(voice_id: str, text: str) -> str:
    return hashlib.sha1(f"{voice_id}::{text}".encode()).hexdigest()

def _tts_disk_path(key: str) -> Path:
    return _TTS_DISK_DIR / f"{key}.mp3"

def _tts_cache_get(key: str):
    if key in _TTS_CACHE:
        _TTS_CACHE.move_to_end(key)
        return _TTS_CACHE[key]
    # Fallback: Disk-Cache rehydratisieren
    p = _tts_disk_path(key)
    if p.exists():
        try:
            data = p.read_bytes()
            if data:
                _TTS_CACHE[key] = data
                global _TTS_CACHE_BYTES
                _TTS_CACHE_BYTES += len(data)
                return data
        except Exception:
            pass
    return None

def _tts_cache_put(key: str, data: bytes):
    global _TTS_CACHE_BYTES
    if key in _TTS_CACHE:
        _TTS_CACHE_BYTES -= len(_TTS_CACHE[key])
        del _TTS_CACHE[key]
    _TTS_CACHE[key] = data
    _TTS_CACHE_BYTES += len(data)
    try:
        _tts_disk_path(key).write_bytes(data)
    except Exception:
        pass
    while (len(_TTS_CACHE) > _TTS_CACHE_MAX_ENTRIES or _TTS_CACHE_BYTES > _TTS_CACHE_MAX_BYTES) and _TTS_CACHE:
        old_key, old = _TTS_CACHE.popitem(last=False)
        _TTS_CACHE_BYTES -= len(old)
        try:
            _tts_disk_path(old_key).unlink(missing_ok=True)
        except Exception:
            pass


def _tts_preprocess(text: str) -> str:
    """Clean text for natural TTS output: expand abbreviations, numbers, fix umlauts."""
    import re

    # ── 1. Markdown zuerst weg, damit nachfolgende Zahl-Regeln nicht über Listenmarker stolpern
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)                       # bold
    text = re.sub(r'\*([^*]+)\*', r'\1', text)                            # italic
    text = re.sub(r'`[^`]+`', '', text)                                   # inline code
    text = re.sub(r'```[\s\S]*?```', '', text)                            # code blocks
    text = re.sub(r'^#+\s+', '', text, flags=re.MULTILINE)                # headings
    text = re.sub(r'^\s*[-*]\s+', '', text, flags=re.MULTILINE)           # bullet list markers
    text = re.sub(r'^\s*\d+\.\s+', '', text, flags=re.MULTILINE)          # numbered list markers
    text = re.sub(r'^\s*\|.*\|\s*$\n?', '', text, flags=re.MULTILINE)     # markdown tables
    text = re.sub(r'^\s*-{3,}\s*$\n?', '', text, flags=re.MULTILINE)      # horizontal rules

    # ── 1b. Emojis und Piktogramme raus (BMP-Symbole + Surrogate-Range über Pictographic-Bereiche)
    text = re.sub(
        r'[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F02F\U0001F100-\U0001F1FF]',
        '', text,
    )
    # ASCII-Smileys :) :( ;) :D :P
    text = re.sub(r'(?<!\w)[:;][-^]?[\)\(DPp/\\](?!\w)', '', text)
    # Aktions-Marker in Sternchen (*lacht*, *seufzt*) — sind durch italic-cleanup oben schon raus, aber falls einzeln stehen
    text = re.sub(r'\*[a-zäöüß ]{2,15}\*', '', text)
    # Fußnoten-Marker [1], [12], [a]
    text = re.sub(r'\[\d{1,3}\]', '', text)
    text = re.sub(r'\[[a-z]\]', '', text)
    # Hashtags und @handles → Inhalt als Wort
    text = re.sub(r'#(\w+)', r'\1', text)
    text = re.sub(r'@(\w+)', r'\1', text)
    # snake_case → Leerzeichen, damit nicht buchstäblich "unterstrich" gesprochen wird
    text = re.sub(r'(\w)_(\w)', r'\1 \2', text)

    # ── 1c. URLs und Dateipfade entschärfen
    text = re.sub(r'https?://\S+', 'Link', text)
    text = re.sub(r'\b[\w./-]+\.(py|ts|tsx|js|jsx|mjs|cjs|md|mdx|json|sh|bash|zsh|html|htm|css|scss|yml|yaml|toml|ini|cfg|conf|env|log|sql|xml|csv|tsv|txt|pdf|png|jpg|jpeg|gif|svg|webp|mp3|mp4|mov|wav|zip|tar|gz)\b', 'einer Datei', text)
    # Standalone-Endungen ohne Pfad (".md", ".png", ".html") → buchstabieren als "Punkt M D"
    _ext_spell = {
        'py': 'P Y', 'ts': 'T S', 'tsx': 'T S X', 'js': 'J S', 'jsx': 'J S X',
        'md': 'M D', 'mdx': 'M D X', 'json': 'J S O N', 'sh': 'S H',
        'html': 'H T M L', 'htm': 'H T M', 'css': 'C S S', 'xml': 'X M L',
        'yml': 'Y M L', 'yaml': 'Y A M L', 'toml': 'T O M L', 'env': 'E N V',
        'log': 'L O G', 'sql': 'S Q L', 'csv': 'C S V', 'tsv': 'T S V', 'txt': 'T X T',
        'pdf': 'P D F', 'png': 'P N G', 'jpg': 'J P G', 'jpeg': 'J P E G',
        'gif': 'G I F', 'svg': 'S V G', 'webp': 'W E B P',
        'mp3': 'M P drei', 'mp4': 'M P vier', 'mov': 'M O V', 'wav': 'W A V',
        'zip': 'Z I P', 'tar': 'T A R', 'gz': 'G Z',
    }
    text = re.sub(
        r'\.(' + '|'.join(_ext_spell.keys()) + r')\b',
        lambda m: ' Punkt ' + _ext_spell[m.group(1).lower()],
        text, flags=re.IGNORECASE,
    )

    # ── 2. Abkürzungen ausschreiben oder buchstabieren
    abbrevs = {
        # Tech / English
        r'\bCmd\b': 'Command', r'\bCtrl\b': 'Control', r'\bAlt\b': 'Alt',
        r'\bFTS\b': 'Volltextsuche', r'\bAPI\b': 'A P I', r'\bURL\b': 'U R L',
        r'\bDB\b': 'Datenbank', r'\bWS\b': 'WebSocket', r'\bTTS\b': 'Text to Speech',
        r'\bSTT\b': 'Speech to Text', r'\bIG\b': 'Instagram', r'\bPR\b': 'Pull Request',
        r'\bCI\b': 'C I', r'\bCD\b': 'C D', r'\bUI\b': 'U I', r'\bUX\b': 'U X',
        r'\bCLI\b': 'Command Line', r'\bSSL\b': 'S S L', r'\bHTTPS\b': 'H T T P S', r'\bHTTP\b': 'H T T P',
        r'\bID\b': 'I D', r'\bFYI\b': 'zur Info', r'\bASAP\b': 'so schnell wie möglich',
        r'\bTBD\b': 'noch offen', r'\bvs\.': 'gegen', r'\bOK\b': 'okay', r'\bOk\b': 'okay',
        # Deutsche Abkürzungen (mit Punkt)
        r'\bggf\.': 'gegebenenfalls',
        r'\bbzw\.': 'beziehungsweise',
        r'\bz\.\s*B\.': 'zum Beispiel',
        r'\bd\.\s*h\.': 'das heißt',
        r'\bu\.\s*a\.': 'unter anderem',
        r'\bu\.\s*U\.': 'unter Umständen',
        r'\bv\.\s*a\.': 'vor allem',
        r'\bs\.\s*o\.': 'siehe oben',
        r'\bs\.\s*u\.': 'siehe unten',
        r'\busw\.': 'und so weiter',
        r'\betc\.': 'und so weiter',
        r'\bca\.': 'circa',
        r'\bevtl\.': 'eventuell',
        r'\binkl\.': 'inklusive',
        r'\bexkl\.': 'exklusive',
        r'\bggü\.': 'gegenüber',
        r'\bNr\.': 'Nummer',
        r'\bMio\.': 'Millionen',
        r'\bMrd\.': 'Milliarden',
        r'\bTsd\.': 'tausend',
        r'\bJh\.': 'Jahrhundert',
    }
    for pat, repl in abbrevs.items():
        text = re.sub(pat, repl, text, flags=re.IGNORECASE)

    # ── 3. Zahlen-Grundbausteine
    _num_words = {
        0: 'null', 1: 'eins', 2: 'zwei', 3: 'drei', 4: 'vier', 5: 'fünf',
        6: 'sechs', 7: 'sieben', 8: 'acht', 9: 'neun', 10: 'zehn',
        11: 'elf', 12: 'zwölf', 13: 'dreizehn', 14: 'vierzehn', 15: 'fünfzehn',
        16: 'sechzehn', 17: 'siebzehn', 18: 'achtzehn', 19: 'neunzehn',
        20: 'zwanzig', 30: 'dreißig', 40: 'vierzig', 50: 'fünfzig',
        60: 'sechzig', 70: 'siebzig', 80: 'achtzig', 90: 'neunzig',
    }
    def _num_to_word(n: int) -> str:
        if n == 0:
            return 'null'
        if n in _num_words:
            return _num_words[n]
        if n < 100:
            ones, tens = n % 10, (n // 10) * 10
            ones_w = _num_words.get(ones, '')
            # "eins" wird in "einundzwanzig" zu "ein"
            if ones == 1:
                ones_w = 'ein'
            return f"{ones_w}und{_num_words.get(tens, '')}"
        if n < 1000:
            h = n // 100
            rest = n % 100
            h_w = 'ein' if h == 1 else _num_words[h]
            r = _num_to_word(rest) if rest else ''
            return f"{h_w}hundert{r}"
        if n < 10000:
            t = n // 1000
            rest = n % 1000
            t_w = 'ein' if t == 1 else _num_words[t]
            r = _num_to_word(rest) if rest else ''
            return f"{t_w}tausend{r}"
        return str(n)

    # Ordinalzahlen 1–31 (flektierte -ten/-sten-Form, passt bei Daten und Aufzählungen)
    _ord_base = {
        1: 'ersten', 2: 'zweiten', 3: 'dritten', 4: 'vierten', 5: 'fünften',
        6: 'sechsten', 7: 'siebten', 8: 'achten', 9: 'neunten', 10: 'zehnten',
        11: 'elften', 12: 'zwölften', 13: 'dreizehnten', 14: 'vierzehnten',
        15: 'fünfzehnten', 16: 'sechzehnten', 17: 'siebzehnten',
        18: 'achtzehnten', 19: 'neunzehnten', 20: 'zwanzigsten',
        21: 'einundzwanzigsten', 22: 'zweiundzwanzigsten', 23: 'dreiundzwanzigsten',
        24: 'vierundzwanzigsten', 25: 'fünfundzwanzigsten', 26: 'sechsundzwanzigsten',
        27: 'siebenundzwanzigsten', 28: 'achtundzwanzigsten', 29: 'neunundzwanzigsten',
        30: 'dreißigsten', 31: 'einunddreißigsten',
    }
    def _ord_to_word(n: int) -> str:
        if n in _ord_base:
            return _ord_base[n]
        # ab 32: Kardinal + -sten (z.B. "zweiunddreißigsten")
        return _num_to_word(n) + 'sten'

    _months = {
        1: 'Januar', 2: 'Februar', 3: 'März', 4: 'April', 5: 'Mai', 6: 'Juni',
        7: 'Juli', 8: 'August', 9: 'September', 10: 'Oktober', 11: 'November', 12: 'Dezember',
    }

    def _year_to_words(y: int) -> str:
        # 1100–1999: "neunzehnhundertneunundachtzig"; 2000–2099: "zweitausend(...)"; sonst Kardinal.
        if 1100 <= y <= 1999:
            h, rest = y // 100, y % 100
            r = _num_to_word(rest) if rest else ''
            return f"{_num_words[h]}hundert{r}"
        if 2000 <= y <= 2099:
            rest = y % 100
            return 'zweitausend' + (_num_to_word(rest) if rest else '')
        return _num_to_word(y) if y < 10000 else str(y)

    # ── 4·prä. Telefonpräfix "+49 30 …" → "plus neunundvierzig …"
    text = re.sub(r'\+(\d{1,3})(?=\s*\d)', lambda m: 'plus ' + _num_to_word(int(m.group(1))) + ' ', text)

    # ── 4·prä. Geldbetrag mit Tausenderpunkt und Dezimalkomma "1.299,99 €" → "tausendzweihundertneunundneunzig Euro neunundneunzig"
    def _money(m):
        whole = int(m.group(1).replace('.', ''))
        cents = int(m.group(2))
        sym = m.group(3)
        cur = {'€': 'Euro', '$': 'Dollar', '£': 'Pfund'}[sym]
        whole_w = _num_to_word(whole) if whole < 10000 else str(whole)
        return f"{whole_w} {cur} {_num_to_word(cents)}" if cents else f"{whole_w} {cur}"
    text = re.sub(r'(\d{1,3}(?:\.\d{3})+),(\d{2})\s*([€$£])', _money, text)

    # ── 4·prä. Großzahlen mit Tausendertrennung "1.000.000" → "eine Million" / "zwei Millionen" etc.
    def _bignum(m):
        n = int(m.group().replace('.', ''))
        if n == 1_000_000: return 'eine Million'
        if n == 1_000_000_000: return 'eine Milliarde'
        if n % 1_000_000_000 == 0:
            return f"{_num_to_word(n // 1_000_000_000)} Milliarden"
        if n % 1_000_000 == 0:
            return f"{_num_to_word(n // 1_000_000)} Millionen"
        if n >= 1_000_000 and n < 1_000_000_000:
            mio = n / 1_000_000
            whole = int(mio)
            frac = round((mio - whole) * 100)
            if frac == 0:
                return f"{_num_to_word(whole)} Millionen"
            frac_w = ' '.join(_num_words[int(d)] for d in f"{frac:02d}".rstrip('0'))
            return f"{_num_to_word(whole)} Komma {frac_w} Millionen"
        if n % 1_000 == 0 and n < 1_000_000:
            return _num_to_word(n // 1_000) + 'tausend' if n // 1_000 > 1 else 'tausend'
        return str(n)
    text = re.sub(r'\b\d{1,3}(?:\.\d{3}){2,}\b', _bignum, text)

    # ── 4a. Vollständige Daten "26.04.2026" → "sechsundzwanzigsten April zweitausendsechsundzwanzig"
    def _date_to_words(m):
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= d <= 31 and 1 <= mo <= 12:
            year_w = _year_to_words(y if y >= 100 else 2000 + y)
            return f"{_ord_to_word(d)} {_months[mo]} {year_w}"
        return m.group()
    text = re.sub(r'\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b', _date_to_words, text)

    # ── 4b. Datum ohne Jahr "26.04." → "sechsundzwanzigsten April"
    def _short_date(m):
        d, mo = int(m.group(1)), int(m.group(2))
        if 1 <= d <= 31 and 1 <= mo <= 12:
            return f"{_ord_to_word(d)} {_months[mo]}"
        return m.group()
    text = re.sub(r'\b(\d{1,2})\.(\d{1,2})\.(?!\d)', _short_date, text)

    # ── 4c. Kalenderwoche "KW 17"
    text = re.sub(r'\bKW\s*(\d{1,2})\b', lambda m: f"Kalenderwoche {_num_to_word(int(m.group(1)))}", text)

    # ── 4d. Versionen "v1.2.3" → "Version eins Punkt zwei Punkt drei"
    def _version(m):
        parts = m.group(1).split('.')
        return 'Version ' + ' Punkt '.join(_num_to_word(int(p)) if p.isdigit() and int(p) < 1000 else p for p in parts)
    text = re.sub(r'\bv(\d+(?:\.\d+){1,3})\b', _version, text)

    # ── 4e. Uhrzeiten: "12:15" → "zwölf Uhr fünfzehn"
    def _time_to_words(m):
        h, mi = int(m.group(1)), int(m.group(2))
        if 0 <= h <= 23 and 0 <= mi <= 59:
            result = _num_to_word(h) + ' Uhr'
            if mi > 0:
                result += ' ' + _num_to_word(mi)
            return result
        return m.group()
    text = re.sub(r'\b(\d{1,2}):(\d{2})\b', _time_to_words, text)

    # ── 4ex. "x" als Multiplikator: "1,5x", "3x schneller" → "... mal" (vor Dezimal-Verarbeitung!)
    text = re.sub(r'(\d)\s*[xX]\b', r'\1 mal', text)

    # ── 4ex2. Uhrzeit-Spannen "14–16 Uhr" → "vierzehn bis sechzehn Uhr" (vor Bereich-Logik)
    def _hour_span(m):
        a, b = int(m.group(1)), int(m.group(2))
        if 0 <= a <= 23 and 0 <= b <= 23:
            return f"{_num_to_word(a)} bis {_num_to_word(b)} Uhr"
        return m.group()
    text = re.sub(r'\b(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*Uhr\b', _hour_span, text)

    # ── 4ex3. Bruchzahlen "1/2", "3/4" → "ein halb", "drei viertel" (vor Slash→oder)
    _fracs = {(1,2):'ein halb',(1,3):'ein drittel',(2,3):'zwei drittel',(1,4):'ein viertel',(3,4):'drei viertel',(1,5):'ein fünftel'}
    def _frac(m):
        a, b = int(m.group(1)), int(m.group(2))
        return _fracs.get((a, b), f"{_num_to_word(a)} durch {_num_to_word(b)}")
    text = re.sub(r'\b(\d{1,2})/(\d{1,2})\b', _frac, text)

    # ── 4ex4. Verhältnis / Sportergebnis "3:2" → "drei zu zwei" (Uhrzeit hat oben schon zugegriffen)
    def _ratio(m):
        a, b = int(m.group(1)), int(m.group(2))
        return f"{_num_to_word(a)} zu {_num_to_word(b)}"
    text = re.sub(r'\b(\d{1,3}):(\d{1,3})\b', _ratio, text)

    # ── 4f. Dezimalzahl-Bereiche: "0.4–0.6" / "0,4 - 0,6" → "... bis ..."
    def _decimal(s: str) -> str:
        s = s.replace(',', '.')
        whole, frac = s.split('.')
        whole_w = _num_to_word(int(whole)) if whole else 'null'
        frac_w = ' '.join(_num_words[int(d)] for d in frac)
        return f"{whole_w} Komma {frac_w}"

    def _range_dec(m):
        return f"{_decimal(m.group(1))} bis {_decimal(m.group(2))}"
    text = re.sub(r'(\d+[.,]\d+)\s*[-–—]\s*(\d+[.,]\d+)', _range_dec, text)

    # ── 4g. Ganzzahl-Bereiche: "5–10" → "fünf bis zehn" (nur klein, nicht jede Strich-Verbindung)
    def _range_int(m):
        a, b = int(m.group(1)), int(m.group(2))
        if 1 <= a <= 999 and 1 <= b <= 999 and a < b:
            return f"{_num_to_word(a)} bis {_num_to_word(b)}"
        return m.group()
    text = re.sub(r'\b(\d{1,3})\s*[–—]\s*(\d{1,3})\b', _range_int, text)

    # ── 4h. Einzelne Dezimalzahlen "0.4" / "0,4"
    text = re.sub(r'\b(\d+[.,]\d+)\b', lambda m: _decimal(m.group(1)), text)

    # ── 4i. Einheiten direkt an der Zahl: "5kg", "2h", "30min", "10MB"
    units = {
        'kg': 'Kilogramm', 'g': 'Gramm', 'mg': 'Milligramm',
        'km': 'Kilometer', 'm': 'Meter', 'cm': 'Zentimeter', 'mm': 'Millimeter',
        'l': 'Liter', 'ml': 'Milliliter',
        'h': 'Stunden', 'min': 'Minuten', 'sek': 'Sekunden', 's': 'Sekunden',
        'MB': 'Megabyte', 'GB': 'Gigabyte', 'KB': 'Kilobyte', 'TB': 'Terabyte',
    }
    def _unit_repl(m):
        n, u = m.group(1), m.group(2)
        return f"{n} {units[u]}"
    # längere Einheiten zuerst, damit "min" nicht von "m" geschluckt wird
    units_pat = '|'.join(sorted(units.keys(), key=len, reverse=True))
    text = re.sub(rf'(\d+)({units_pat})\b', _unit_repl, text)

    # ── 4j. Währungen "5€" / "€5" / "100$"
    currencies = {'€': 'Euro', '$': 'Dollar', '£': 'Pfund'}
    for sym, word in currencies.items():
        text = re.sub(rf'(\d+)\s*{re.escape(sym)}', rf'\1 {word}', text)
        text = re.sub(rf'{re.escape(sym)}\s*(\d+)', rf'\1 {word}', text)

    # ── 4k. Prozent / Grad
    text = re.sub(r'(\d+)\s*%', r'\1 Prozent', text)
    text = re.sub(r'(\d+)\s*°\s*C', r'\1 Grad Celsius', text)
    text = re.sub(r'(\d+)\s*°', r'\1 Grad', text)

    # ── 5. Ordinalzahlen: "am 18. April", "der 5. Platz" → "achtzehnten", "fünften"
    def _ord_repl(m):
        n = int(m.group(1))
        if 1 <= n <= 99:
            return _ord_to_word(n)
        return m.group()
    text = re.sub(r'\b(\d{1,2})\.(?=\s+[A-Za-zÄÖÜäöü])', _ord_repl, text)

    # ── 6. Sonderzeichen aussprechen (nach Zahlenformen, vor Kardinalzahlen)
    text = re.sub(r'\s*≤\s*', ' kleiner gleich ', text)
    text = re.sub(r'\s*≥\s*', ' größer gleich ', text)
    text = re.sub(r'(?<=\w)\s*<\s*(?=\w)', ' kleiner ', text)
    text = re.sub(r'(?<=\w)\s*>\s*(?=\w)', ' größer ', text)
    text = re.sub(r'(?<=\w)\s*\*\s*(?=\w)', ' mal ', text)
    text = re.sub(r'\s*=\s*', ' gleich ', text)
    text = re.sub(r'\s*&\s*', ' und ', text)
    text = re.sub(r'(?<=\w)\s*\+\s*(?=\w)', ' plus ', text)
    text = re.sub(r'(?<=\w)\s*/\s*(?=\w)', ' oder ', text)
    text = re.sub(r'\s*→\s*', ' zu ', text)
    text = re.sub(r'•', ',', text)
    text = re.sub(r'(?<=\s)~\s*(?=\d)', 'circa ', text)
    # übrig gebliebene Gedanken-/Bis-Striche zwischen Wörtern als Pause (Komma)
    text = re.sub(r'\s+[–—]\s+', ', ', text)

    # ── 7. Port-artige Zahlen (4–5 Stellen): ziffernweise
    def _port_to_words(m):
        return '-'.join(_num_words[int(d)] for d in m.group())
    text = re.sub(r'\b[0-9]{4,5}\b', _port_to_words, text)

    # ── 8. Kardinalzahlen 1–999 als Worte
    def _small_num(m):
        n = int(m.group())
        if 1 <= n <= 999:
            return _num_to_word(n)
        return m.group()
    text = re.sub(r'\b[0-9]{1,3}\b', _small_num, text)

    # ── 9. Leerzeilen normalisieren, Mehrfach-Spaces aufräumen
    text = re.sub(r'[ \t]{2,}', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def _tts_chunk_text(text: str, max_len: int = 4500) -> list[str]:
    """Split long text into chunks <= max_len at natural boundaries.
    Order: paragraph breaks → sentence ends → commas → hard cut.
    Returns at least one chunk even for empty input.
    """
    text = text.strip()
    if not text:
        return [""]
    if len(text) <= max_len:
        return [text]

    def split_by(units: list[str]) -> list[str]:
        out: list[str] = []
        cur = ""
        for u in units:
            if not u:
                continue
            if len(cur) + len(u) + 1 <= max_len:
                cur = (cur + " " + u).strip() if cur else u
            else:
                if cur:
                    out.append(cur)
                cur = u
        if cur:
            out.append(cur)
        return out

    # Paragraph split first
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks = split_by(paragraphs)

    # Any chunk still too long → split at sentences
    refined: list[str] = []
    for c in chunks:
        if len(c) <= max_len:
            refined.append(c)
            continue
        sentences = _re.split(r"(?<=[.!?])\s+", c)
        refined.extend(split_by(sentences))

    # Still too long → split at commas
    final: list[str] = []
    for c in refined:
        if len(c) <= max_len:
            final.append(c)
            continue
        parts = [p.strip() for p in c.split(",")]
        sub = split_by(parts)
        # Last resort: hard cut
        for s in sub:
            if len(s) <= max_len:
                final.append(s)
            else:
                for i in range(0, len(s), max_len):
                    final.append(s[i:i + max_len])
    return final or [text[:max_len]]


# Curated voice roster — hand-picked from ElevenLabs catalog.
# The "isDefault" entry wins when the user hasn't picked anything.
_DEFAULT_VOICE_SETTINGS = {"stability": 0.45, "similarity_boost": 0.8, "style": 0.15}

CURATED_VOICES = [
    {"id": "Nee05hJXg2vqAZ6vuQHT", "name": "Tony",       "isDefault": False,
     "settings": {"stability": 0.45, "similarity_boost": 0.8,  "style": 0.15}},
    {"id": "bROdzPH9mj67avuvvCDN", "name": "Dumbledore", "isDefault": False,
     "settings": {"stability": 0.55, "similarity_boost": 0.8,  "style": 0.25}},
    {"id": "1ltn1QwANM1UCyjcNznE", "name": "Picard",     "isDefault": False,
     "settings": {"stability": 0.6,  "similarity_boost": 0.75, "style": 0.2}},
    {"id": "dmWBl97PQtIsiK94gxHf", "name": "Jack",       "isDefault": False,
     "settings": {"stability": 0.4,  "similarity_boost": 0.8,  "style": 0.3}},
    {"id": "MU3b3cEHcofUOdPQJEVC", "name": "Gandalf",    "isDefault": True,
     "settings": {"stability": 0.5,  "similarity_boost": 0.8,  "style": 0.35}},
    {"id": "eJlL5JZa2U1AMBWQqYzV", "name": "WOW-Human",  "isDefault": False,
     "settings": {"stability": 0.5,  "similarity_boost": 0.8,  "style": 0.2}},
    {"id": "vyf8QqKaHIpJdc8YGxMk", "name": "WOW-Zwerg",  "isDefault": False,
     "settings": {"stability": 0.5,  "similarity_boost": 0.8,  "style": 0.2}},
]
_VOICE_BY_ID = {v["id"]: v for v in CURATED_VOICES}


@router.get("/api/voices")
async def list_voices():
    """Return curated voice list, enriched with ElevenLabs preview URLs when available."""
    api_key = _get_elevenlabs_key()
    preview_map: dict = {}
    if api_key:
        try:
            req = urllib.request.Request(
                "https://api.elevenlabs.io/v1/voices",
                headers={"xi-api-key": api_key},
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read())
            preview_map = {v.get("voice_id"): v.get("preview_url") for v in data.get("voices", [])}
        except Exception:
            pass
    voices = [
        {**v, "provider": "elevenlabs", "preview": preview_map.get(v["id"])}
        for v in CURATED_VOICES
    ]
    return JSONResponse({"voices": voices})


def _tts_fetch_chunks(chunks, voice_id, voice_settings, api_key, agent_id, voice_override):
    """Blockierende ElevenLabs-Synthese aller Chunks. Läuft via asyncio.to_thread
    außerhalb des Event-Loops, sonst friert der ganze Server ein und WebSockets
    fliegen per keepalive-ping-timeout raus. Gibt (audio_bytes, None) oder
    (b"", status_code) zurück."""
    from server import AGENTS
    buf = bytearray()
    for chunk_text in chunks:
        payload = json.dumps({
            "text": chunk_text,
            "model_id": "eleven_turbo_v2_5",
            "voice_settings": voice_settings,
        }).encode()
        req = urllib.request.Request(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?optimize_streaming_latency=4&output_format=mp3_22050_32",
            data=payload,
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                while True:
                    data = resp.read(4096)
                    if not data:
                        break
                    buf.extend(data)
        except urllib.error.HTTPError as e:
            # Voice nicht erlaubt / Key-Quota / temporärer ElevenLabs-Fehler.
            # Bei voice-Override auf Klaus' Default zurückfallen, statt 500 zu werfen.
            err_body = ""
            try:
                err_body = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            print(f"[tts] elevenlabs {e.code} voice={voice_id} override={voice_override!r} body={err_body}", flush=True)
            fallback_voice = AGENTS.get(agent_id, AGENTS["main"])["voice"]
            if voice_id != fallback_voice:
                req = urllib.request.Request(
                    f"https://api.elevenlabs.io/v1/text-to-speech/{fallback_voice}/stream?optimize_streaming_latency=4&output_format=mp3_22050_32",
                    data=payload,
                    headers={"xi-api-key": api_key, "Content-Type": "application/json"},
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        while True:
                            data = resp.read(4096)
                            if not data:
                                break
                            buf.extend(data)
                except urllib.error.HTTPError as e2:
                    return b"", e2.code
            else:
                return b"", e.code
    return bytes(buf), None


@router.post("/api/tts")
async def tts(request: Request):
    from server import AGENTS, _AGENT_NAME_TO_ID
    body = await request.json()
    text = _tts_preprocess(body.get("text", "").strip())
    agent = body.get("agent", "klaus")
    # If conversationId is provided, derive agent from conversation
    conv_id = body.get("conversationId", "")
    if conv_id:
        conv = get_conversation(conv_id)
        if conv and conv["agent"]:
            agent_id = conv["agent"]
        else:
            agent_id = _AGENT_NAME_TO_ID.get(agent, agent.lower())
    else:
        agent_id = _AGENT_NAME_TO_ID.get(agent, agent.lower())
    # Voice override from client (per-agent picker in frontend), else agent default
    voice_override = (body.get("voiceId") or "").strip()
    voice_id = voice_override if voice_override else AGENTS.get(agent_id, AGENTS["main"])["voice"]
    if not text:
        return JSONResponse({"error": "no text"}, status_code=400)

    api_key = _get_elevenlabs_key()
    if not api_key:
        return JSONResponse({"error": "no api key"}, status_code=400)

    # Voice settings: client override > per-voice default > global default
    base_settings = dict(_VOICE_BY_ID.get(voice_id, {}).get("settings") or _DEFAULT_VOICE_SETTINGS)
    client_settings = body.get("voiceSettings") or {}
    for k in ("stability", "similarity_boost", "style"):
        v = client_settings.get(k)
        if isinstance(v, (int, float)):
            base_settings[k] = max(0.0, min(1.0, float(v)))
    voice_settings = base_settings

    # Cache key includes settings and full text (hashed) so slider changes and
    # different long-texts with same 5k-prefix don't collide.
    settings_key = f"{voice_settings['stability']:.2f}_{voice_settings['similarity_boost']:.2f}_{voice_settings['style']:.2f}"
    cache_key = _tts_cache_key(f"{voice_id}_{settings_key}", text)
    cached = _tts_cache_get(cache_key)
    if cached is not None:
        return JSONResponse({"url": f"/api/tts-audio/{cache_key}.mp3", "size": len(cached), "cache": "hit"})

    chunks = _tts_chunk_text(text, max_len=4500)

    # Synthese ist ein blockierender urllib-Call (bis 60s). In einen Thread
    # auslagern, damit der Event-Loop frei bleibt und parallele Streams/WS leben.
    audio_bytes, err_code = await asyncio.to_thread(
        _tts_fetch_chunks, chunks, voice_id, voice_settings, api_key, agent_id, voice_override
    )
    if err_code:
        return JSONResponse({"error": f"elevenlabs {err_code}"}, status_code=502)
    if not audio_bytes:
        return JSONResponse({"error": "tts empty"}, status_code=502)
    _tts_cache_put(cache_key, audio_bytes)
    return JSONResponse({"url": f"/api/tts-audio/{cache_key}.mp3", "size": len(audio_bytes), "cache": "miss", "chunks": len(chunks)})


@router.get("/api/tts-audio/{key}.mp3")
async def tts_audio(key: str, request: Request):
    """Serve cached TTS audio via GET so iOS PWA kann per audio.src streamen.
    Range-Support kommt automatisch über FileResponse."""
    # Kein Path-Traversal: key muss hex sein
    if not key or not all(c in "0123456789abcdef" for c in key.lower()) or len(key) > 64:
        return JSONResponse({"error": "bad key"}, status_code=400)
    p = _tts_disk_path(key.lower())
    if not p.exists() or p.stat().st_size == 0:
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(
        path=str(p),
        media_type="audio/mpeg",
        headers={"Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes"},
    )


# ── Voice Mode (ElevenLabs Conversational AI) ──

@router.get("/api/voice/status")
async def voice_status():
    """Report ob Voice-Mode konfiguriert ist (Key + Agent-ID vorhanden)."""
    return JSONResponse({
        "ready": bool(_get_elevenlabs_key() and _get_elevenlabs_agent_id()),
        "hasKey": bool(_get_elevenlabs_key()),
        "hasAgentId": bool(_get_elevenlabs_agent_id()),
    })


# ── Klaus ruft an (proaktiver Voice-Anruf) ──
#
# Ein Anruf entsteht aus einer Quelle (Puls/Briefing/Job/Event), die heute schon
# in den Chat pingt, nur mit zweiter Stufe "wichtig genug zum Anrufen". Statt zu
# posten, broadcastet sie ein `voice.incoming_call`-Event: das Frontend zeigt ein
# pulsierendes Telefon. Christian geht ran oder wischt weg. Geht er ran, startet
# die Voice-Session und zieht das hier hinterlegte Anruf-Briefing als zweite
# Prompt-Schicht (Mid-Conversation-Auftrag), ohne Klaus' Identität zu überschreiben.
#
# Transienter State: nur EIN Anruf liegt an. Wird beim Annehmen konsumiert oder
# beim Wegwischen verworfen.
_pending_call: dict | None = None


def _radar_call_briefing() -> dict | None:
    """Baut ein Anruf-Briefing aus dem heutigen konsolidierten Radar.

    Erster Auslöser zum Testen: Klaus ruft an, um über ein Agenten-Update zu reden.
    Nimmt die erste Story der 'Top-3 für heute', extrahiert Titel + Kernsatz.
    """
    import datetime
    today = datetime.date.today().isoformat()
    path = PROJECT_ROOT / "jobs" / "radar-konsolidiert" / "data" / f"{today}-radar-konsolidiert.md"
    if not path.exists():
        # Fallback: jüngste vorhandene Radar-Datei
        data_dir = PROJECT_ROOT / "jobs" / "radar-konsolidiert" / "data"
        cands = sorted(data_dir.glob("*-radar-konsolidiert.md"), reverse=True) if data_dir.exists() else []
        if not cands:
            return None
        path = cands[0]
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None

    # Top-3-Block: nummerierte, fett-gestartete Zeilen "1. **Titel.** Rest..."
    top = _re.search(r"\*\*Top-3 für heute\.\*\*(.+)", text, _re.S)
    block = top.group(1) if top else text
    first = _re.search(r"\d+\.\s+\*\*(.+?)\*\*\s*(.*)", block)
    if not first:
        return None
    titel = first.group(1).strip().rstrip(".")
    kern = _re.sub(r"\s+", " ", first.group(2).strip())[:400]

    return {
        "trigger": "radar:konsolidiert",
        "teaser": titel,
        "anrufgrund": f"Es gibt ein Agenten-Update, über das wir kurz reden sollten: {titel}.",
        "was_erzaehlen": [kern] if kern else [],
        "gespraechsziel": "Christian kennt das Update und weiss, ob es für Agent Control oder seine Workshops relevant ist.",
        "opener": f"Moin. Ich ruf an wegen einem Ding aus dem Radar heute: {titel}. Haste kurz?",
        "quelle": str(path.relative_to(PROJECT_ROOT)),
    }


@router.post("/api/voice/trigger-call")
async def voice_trigger_call(request: Request):
    """Löst einen eingehenden Klaus-Anruf aus. Body optional; ohne Inhalt wird aus
    dem heutigen Radar ein Briefing gebaut (erster Test-Auslöser).

    Body-Felder (alle optional): teaser, anrufgrund, was_erzaehlen[], gespraechsziel, opener.
    """
    global _pending_call
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    briefing = _radar_call_briefing() or {}
    # Explizite Body-Felder überschreiben die Radar-Defaults.
    for key in ("trigger", "teaser", "anrufgrund", "was_erzaehlen", "gespraechsziel", "opener", "quelle"):
        if body.get(key):
            briefing[key] = body[key]

    if not briefing.get("anrufgrund"):
        return JSONResponse({"error": "kein Anrufgrund (Radar leer und Body leer)"}, status_code=400)

    _pending_call = briefing
    try:
        from streaming import broadcast_incoming_call
        had_clients = await broadcast_incoming_call(briefing)
    except Exception as e:
        return JSONResponse({"error": f"broadcast failed: {e}", "briefing": briefing}, status_code=500)
    return JSONResponse({"ok": True, "hadClients": had_clients, "briefing": briefing})


@router.get("/api/voice/call-briefing")
async def voice_call_briefing():
    """Liefert das aktuell anstehende Anruf-Briefing (ohne es zu konsumieren)."""
    if not _pending_call:
        return JSONResponse({"active": False})
    return JSONResponse({"active": True, "briefing": _pending_call})


@router.post("/api/voice/call-briefing/consume")
async def voice_call_briefing_consume():
    """Liefert das Anruf-Briefing UND verwirft es. Wird beim Annehmen vom
    Session-Start aufgerufen, damit ein normaler Voice-Toggle danach wieder
    ohne Anruf-Schicht startet."""
    global _pending_call
    briefing = _pending_call
    _pending_call = None
    if not briefing:
        return JSONResponse({"active": False})
    return JSONResponse({"active": True, "briefing": briefing})


@router.post("/api/voice/call-briefing/dismiss")
async def voice_call_briefing_dismiss():
    """Verwirft das anstehende Anruf-Briefing (Christian hat weggewischt)."""
    global _pending_call
    _pending_call = None
    return JSONResponse({"ok": True})


@router.get("/api/voice/signed-url")
async def voice_signed_url():
    """Hole signierte WebSocket-URL von ElevenLabs für private Agents.
    Client baut damit eine Conversational-AI-Session auf ohne API-Key client-side."""
    import httpx
    api_key = _get_elevenlabs_key()
    agent_id = _get_elevenlabs_agent_id()
    if not api_key:
        return JSONResponse({"error": "no elevenlabs api key"}, status_code=400)
    if not agent_id:
        return JSONResponse({"error": "no elevenlabs agent id — set ELEVENLABS_AGENT_ID in .env"}, status_code=400)
    url = f"https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id={agent_id}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, headers={"xi-api-key": api_key})
            if resp.status_code != 200:
                return JSONResponse({"error": f"elevenlabs returned {resp.status_code}: {resp.text[:200]}"}, status_code=502)
            data = resp.json()
        return JSONResponse({"signedUrl": data.get("signed_url", ""), "agentId": agent_id})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
