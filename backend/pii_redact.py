"""PII-Tokenisierung fuer Cloud-LLM-Calls (zunaechst Mail-Entwuerfe).

Ersetzt echte Personendaten durch stabile Platzhalter, BEVOR ein Prompt an ein
Cloud-Modell geht, und stellt sie in der Antwort wieder her. Kein zweites LLM:
reiner Abgleich gegen die eigenen Kontakte (people.db) plus Telefon-, Mail- und
IBAN-Muster. Schnell, deterministisch, genau auf die eigenen Leute zugeschnitten.

    masked, mapping = tokenize(prompt)     # vor dem Cloud-Call
    text = restore(model_output, mapping)  # nach dem Cloud-Call

Christians eigene Identitaeten bleiben unmaskiert, damit der Absender-Kontext im
Entwurf erhalten bleibt. Vornamen bleiben stehen (Anrede natuerlich, gering
identifizierend); Nachname, Firma, Nummer, Mail und IBAN werden maskiert.
"""
from __future__ import annotations

import functools
import re
import sqlite3
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_PEOPLE_DB = _REPO_ROOT / "data" / "people.db"

# Bleiben immer im Klartext: Absender-Kontext, sonst versteht das Modell die
# Aufgabe schlechter. Kleingeschrieben verglichen.
_SELF = {
    
    "owner@example.com", "owner@example.com",
}

_MAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}[ ]?(?:\d{4}[ ]?){4}\d{2}\b")
# Telefon: mind. 9 Ziffern, optional +, Trenner erlaubt. Wortgrenzen verhindern,
# dass mitten aus IDs gerissen wird.
_PHONE_RE = re.compile(r"(?<![\w.])\+?\d[\d /()\-]{7,}\d(?![\w])")


@functools.lru_cache(maxsize=2)
def _gazetteer_cached(_mtime: float) -> tuple[tuple[str, str], ...]:
    """(wert, typ) aus people.db, laengste zuerst. _mtime bricht den Cache bei
    DB-Aenderung. mode=ro, damit nie versehentlich geschrieben wird."""
    items: list[tuple[str, str]] = []
    try:
        con = sqlite3.connect(f"file:{_PEOPLE_DB}?mode=ro", uri=True)
        rows = con.execute(
            "SELECT name, phone, email, billing_email, company FROM people"
        ).fetchall()
        con.close()
    except Exception:
        return ()
    seen: set[str] = set()

    def _add(value: str | None, typ: str, min_len: int) -> None:
        v = (value or "").strip()
        if len(v) < min_len:
            return
        low = v.lower()
        if low in _SELF or low in seen:
            return
        seen.add(low)
        items.append((v, typ))

    for name, phone, email, bemail, company in rows:
        _add(name, "NAME", 3)
        _add(company, "FIRMA", 3)
        # Nachname separat, damit auch "Hallo Herr Mueller" greift.
        if name and len(name.split()) >= 2:
            _add(name.split()[-1], "NAME", 3)
        _add(phone, "TEL", 6)
        _add(email, "MAIL", 5)
        _add(bemail, "MAIL", 5)

    items.sort(key=lambda t: len(t[0]), reverse=True)
    return tuple(items)


def _gazetteer() -> tuple[tuple[str, str], ...]:
    try:
        mt = _PEOPLE_DB.stat().st_mtime
    except OSError:
        mt = 0.0
    return _gazetteer_cached(mt)


def tokenize(text: str) -> tuple[str, dict[str, str]]:
    """Gibt (maskierter_text, mapping) zurueck. mapping: Platzhalter -> Klartext."""
    if not text:
        return text, {}
    mapping: dict[str, str] = {}
    rev: dict[str, str] = {}  # klartext -> platzhalter (stabil pro Wert)
    counters: dict[str, int] = {}

    def _ph(typ: str, value: str) -> str:
        if value.strip().lower() in _SELF:
            return value
        if value in rev:
            return rev[value]
        counters[typ] = counters.get(typ, 0) + 1
        key = f"[[{typ}{counters[typ]}]]"
        mapping[key] = value
        rev[value] = key
        return key

    out = text
    # 1) Bekannte Kontakte (laengste zuerst, sonst bleiben Nachnamen-Reste).
    for val, typ in _gazetteer():
        if val in out:
            out = out.replace(val, _ph(typ, val))
    # 2) Unbekannte Identifikatoren ueber Muster.
    out = _IBAN_RE.sub(lambda m: _ph("IBAN", m.group(0)), out)
    out = _MAIL_RE.sub(lambda m: _ph("MAIL", m.group(0)), out)
    out = _PHONE_RE.sub(lambda m: _ph("TEL", m.group(0)), out)
    return out, mapping


def restore(text: str, mapping: dict[str, str]) -> str:
    """Setzt die Platzhalter wieder auf Klartext. Idempotent, sicher bei leerem map."""
    if not text or not mapping:
        return text
    out = text
    for key, value in mapping.items():
        out = out.replace(key, value)
    return out
