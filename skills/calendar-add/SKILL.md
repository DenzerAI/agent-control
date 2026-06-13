---
name: calendar-add
description: Termin anlegen, ändern oder löschen
category: Integrationen / Automation
triggers:
- 'der Nutzer fragt nach: Termin anlegen, ändern oder löschen'
inputs:
- User request
- Relevant local files, APIs or context named in the skill
outputs:
- Completed task, edited artifact or concrete recommendation according to the skill
permissions:
- Read relevant local files and context
- Edit or create files only when the user task or skill workflow requires it
- Call local tools or APIs named in the skill when needed
risks:
- Wrong trigger or stale context can produce bad work
- External sends, deploys, deletes or purchases need the explicit approvals defined by the skill and bootstrap rules
owner: klaus
status: active
---

# calendar-add

Termine aus dem Chat anlegen, ändern oder löschen. der Nutzer sagt z.B. "trag Mittwoch 14 Uhr Friseur ein" oder "lösch den Friseur-Termin", und der Eintrag landet im lokalen Kalender (`calendar_events` in `chat.db`, bzw. `pt_appointments` in `people.db` für Personal Training) und ist sofort im Fokus und in der Agent-UI sichtbar.

**Eine Wahrheit:** Normale Termine werden über `/api/calendar` in `data/chat.db` (`calendar_events`) angelegt. Kein direkter Google-Write, kein zweiter Kalenderpfad. Google-IDs bleiben nur Referenzen für alte oder importierte Einträge.

## Wann dieser Skill greift

der Nutzer formuliert Termine in Sprache, etwa:

- "trag Mittwoch 14 Uhr Friseur ein"
- "morgen 10 Uhr Vor-Ort-Termin Jens GmbH, dauert 90 Minuten"
- "AI Beratung mit Schmidt am Freitag 11 Uhr"
- "trag Nick Samstag 10 ein, eine Stunde PT"
- "EMS mit Maria morgen 18 Uhr"
- "lösch den Friseur-Termin"
- "verschieb den Friseur auf Donnerstag 15 Uhr"

Das funktioniert in **jedem** Chat, nicht nur wenn der Kalender offen ist.

## Datenmodell

| Kalender | Kategorie | Wofür |
|---|---|---|
| Klaus | `klaus` | Default, alles Sonstige |
| Privat | `privat` | Privates (Friseur, Arzt, Familie) |
| FCH | `fch` | Studio-Termine |
| AI Workshop | `ai-workshop` | Workshop-Slots, Vor-Ort, Webinare |
| AI Agent | `ai-agent` | Custom-Agent-Projekte, Builds, Kundengespräche zum Bau |
| AI Beratung | `ai-beratung` | Beratungs-Gespräche, Strategie-Calls |
| Beispielkunde | `gecko` | Beispielkunde-Termine |
| Admin | `admin` | Buchhaltung, Rechnungen, Belege, Behörden, Bank, Versicherungen |
| PT | `ptdesk` (Legacy-Name, Anzeige "PT") | Personal Training, 60min Default, EMS-Variante 30min |

PT lebt seit Mai 2026 im lokalen Kalender (Tabelle `pt_appointments` in `people.db`), nicht mehr in einem separaten PT-Desk. Der Anlage-Workflow ist zweistufig (siehe **Ablauf — PT-Termin anlegen** unten), weil PT-Slots zusätzlich zur Person verknüpft werden müssen.

## Endpoints (Backend auf `http://127.0.0.1:8890`)

| Zweck | Endpoint |
|---|---|
| Termine im Zeitraum lesen | `GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` |
| Termin anlegen | `POST /api/calendar` mit JSON |
| Termin ändern | `PATCH /api/calendar/{id}` mit Teil-JSON |
| Termin löschen | `DELETE /api/calendar/{id}` |

Auth: Bearer-Token aus `~/agent/.env` (`AGENT_TOKEN=...`). In jedem Curl als `-H "Authorization: Bearer $TOKEN"` mitgeben. Beispiel:

```bash
TOKEN=$(grep '^AGENT_TOKEN=' ~/agent/.env | cut -d= -f2)
```

## Ablauf — Anlegen

**0. Name immer in `people.db` prüfen (Pflicht).** Steckt im Termin ein Eigenname ("Maria Muster anrufen", "Termin mit Meyer"), zuerst in `data/people.db` matchen, bevor der Titel geschrieben wird. Den Namen NIE phonetisch raten. Schreibweise aus der DB übernehmen, nicht aus dem gesprochenen Wort.

```bash
sqlite3 -header -column data/people.db "SELECT id,name,company FROM people WHERE name LIKE '%Vorname%' OR name LIKE '%Nachname%';"
```

Auch ähnliche Schreibweisen mitsuchen (Meier/Meyer, Petersen/Pedersen, c/k, einfach/doppelt). Genau ein klarer Treffer: dessen Schreibweise nehmen. Mehrere oder keiner: kurz nachfragen statt raten. Voller Hintergrund: `brain/LEARNINGS.md`, Regel „Namen immer in DB prüfen".

**1. Kategorie wählen.** Aus dem Wortlaut ableiten. Privates → `privat`. AI-Beratung → `ai-beratung`. Wenn nicht eindeutig: `klaus` als Default.

**2. Datum und Uhrzeit auflösen.** Relative Angaben ("morgen", "Mittwoch", "in zwei Wochen") immer mit dem aktuellen Datum-Kontext aus dem System auflösen, nie raten. Format: `YYYY-MM-DDTHH:MM:00`.

**3. Dauer raten oder erfragen.** Default 60 Minuten. Bei "kurz" 30, bei "Workshop" 180. Wenn unklar und wichtig, kurz nachfragen.

**4. Direkt ausführen.** der Nutzer will bei Kalender-Add keine Preview und kein Warten. Wenn Titel, Datum und Uhrzeit klar sind, POST sofort absetzen. Nur bei echter Unklarheit oder Konflikt kurz fragen.

```bash
curl -s -X POST "http://127.0.0.1:8890/api/calendar" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "startIso": "2026-05-13T14:00:00",
    "title": "Friseur",
    "durationMin": 60,
    "category": "privat",
    "notes": ""
  }'
```

**5. Kurz bestätigen.** Ein Satz: "Steht im Privat-Kalender, Mittwoch 14 Uhr." Nicht den ganzen JSON zurückspiegeln.

## Ablauf — Verschieben oder Löschen

**1. Termin finden.** GET über den passenden Zeitraum, im Titel nach des Nutzers Wort suchen.

**2. Bei mehreren Treffern nachfragen.** "Ich seh zwei Friseur-Termine, der am Mittwoch oder Donnerstag?" Nicht raten.

**3. Preview zeigen.** Beim Verschieben kurz `Friseur: Mi 14:00 → Do 15:00, passt das so?`, beim Löschen `Friseur am Mi 14:00 löschen, sicher?`. Auf Bestätigung warten.

**4. PATCH oder DELETE auf die `id`.**

```bash
curl -s -X PATCH "http://127.0.0.1:8890/api/calendar/<id>" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"startIso": "2026-05-14T15:00:00"}'

curl -s -X DELETE "http://127.0.0.1:8890/api/calendar/<id>" \
  -H "Authorization: Bearer $TOKEN"
```

## Ablauf — PT-Termin anlegen

PT-Termine (Personal Training, EMS) brauchen zwei Schritte, weil sie zusätzlich zur `pt_appointments`-Tabelle und zur Person verlinkt werden.

**1. Person in `people.db` finden.** Aus des Nutzers Wort den Namen lesen und in `data/people.db` matchen (genau wie find-contact). Bei mehreren Treffern fragen.

**2. Trainingsdauer ableiten.** Default `personal_training` mit 60 Minuten. Wenn der Nutzer "EMS" sagt oder der Titel "EMS" enthält: `ems` mit 30 Minuten. Bei "30 Minuten" oder "kurz" ohne EMS-Hinweis kurz nachfragen.

**3. Direkt anlegen.** Wenn Person, Datum, Uhrzeit und Trainingstyp klar sind, keine Preview zeigen. Erst Kalendereintrag mit Person anlegen, dann Convert zu PT:

```bash
TOKEN=$(grep '^AGENT_TOKEN=' ~/agent/.env | cut -d= -f2)

# 1. Kalender-Slot anlegen mit personId
EVENT_ID=$(curl -s -X POST "http://127.0.0.1:8890/api/calendar" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "startIso": "2026-05-23T10:00:00",
    "title": "Nick Merkel",
    "durationMin": 60,
    "category": "ptdesk",
    "personId": 20
  }' | jq -r .id)

# 2. In pt_appointments umwandeln
curl -s -X POST "http://127.0.0.1:8890/api/calendar/$EVENT_ID/convert-to-pt" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "personId": 20,
    "trainingType": "personal_training",
    "startIso": "2026-05-23T10:00:00",
    "title": "Nick Merkel",
    "durationMin": 60
  }'
```

`trainingType` ist `personal_training` (Default) oder `ems`. Der Convert-Schritt löscht den ursprünglichen Kalender-Slot und legt eine `pt_appointments`-Zeile an, die im Fokus und im PT-View erscheint.

**4. Kurz bestätigen.** "Steht Samstag 10 Uhr als PT-Termin." Nicht den ganzen JSON spiegeln.

## Wiederholungen

`rrule` kann `daily`, `weekly`, `monthly` sein. `rruleUntil` als `YYYY-MM-DD` optional. Beispiel "jeden Montag 9 Uhr bis Ende des Jahres":

```json
{
  "startIso": "2026-05-18T09:00:00",
  "title": "Wochenstart",
  "durationMin": 30,
  "category": "klaus",
  "rrule": "weekly",
  "rruleUntil": "2026-12-31"
}
```

## Tabus

- **Nie raten** bei unklarer Kategorie, Datum oder Person. Lieber einmal kurz fragen.
- **Keine Add-Preview** bei klaren Terminen. Direkt eintragen und danach kurz bestätigen.
- **Keine Marketing-Striche** im Titel oder den Notes (Em-/En-Dashes). Komma, Punkt oder neuer Satz.
- **Nicht in Fokus-Aufgaben schreiben** wenn der Eintrag ein Termin ist. Termine gehören in den Kalender, nicht in den Fokus.
