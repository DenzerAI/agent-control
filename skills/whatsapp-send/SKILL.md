---
name: whatsapp-send
description: WhatsApp-Nachrichten senden
category: Integrationen / Automation
triggers:
- 'der Nutzer fragt nach: WhatsApp-Nachrichten senden'
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

# whatsapp-send

Aus jedem beliebigen Chat heraus WhatsApp-Nachrichten an des Nutzers Kontakte schicken. Kontakt per Name finden, dann Text senden.

## Wann dieser Skill greift

der Nutzer sagt zum Beispiel:

- "Schick Jasper per WhatsApp: …"
- "Sag Paul über WhatsApp, dass …"
- "WhatsApp an Mama: …"

Der Skill funktioniert in **jedem** Chat, nicht nur wenn gerade die WhatsApp-Sektion offen ist. Der Agent findet den Kontakt anhand des Namens in der WhatsApp-DB und ruft den Send-Endpoint auf.

## Endpoints (Backend auf `http://127.0.0.1:8890`)

| Zweck | Endpoint |
|---|---|
| Kontakt per Name finden | `GET /api/whatsapp/find-contact?name=<Name>` |
| Letzte aktive Chats | `GET /api/whatsapp/recent-chats?limit=10` |
| Nachricht senden | `POST /api/whatsapp/send` mit JSON `{"chat_id": "...", "text": "...", "approval": "explicit_user_request"}` |
| Letzte Learning-Log-Läufe | `GET /api/workflows/runs?workflow_key=whatsapp.send` |

Alle `/api/*` Endpoints laufen lokal, aber mit Backend-Auth. Für Shell-Calls zuerst `.env` laden und `Authorization: Bearer $AGENT_TOKEN` setzen. Bei `unauthorized`: Auth klären, niemals auf die WhatsApp-Bridge ausweichen.

## Ablauf

**1. Kontakt finden**

```bash
curl -sG "http://127.0.0.1:8890/api/whatsapp/find-contact" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  --data-urlencode "name=Jasper"
```

Antwort:

```json
{
  "query": "Jasper",
  "matches": [
    {"chat_id": "4915...@c.us", "name": "Jasper", "is_group": false, "last_ts": 1740..., "unread": 0}
  ]
}
```

**Regeln für die Auswahl:**

- Genau ein Match → direkt senden.
- Mehrere Matches → der Nutzer kurz fragen ("Ich sehe zwei Jaspers in deinen Chats, welcher?") und die Kandidaten mit letzter Aktivität zeigen. Nie raten.
- Kein Match → der Nutzer das sagen, nicht raten und nicht senden. Vorschlag: "Schreib mir die Nummer oder öffne den Chat einmal, dann find ich ihn."

**2. Senden**

```bash
curl -s -X POST "http://127.0.0.1:8890/api/whatsapp/send" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -d '{"chat_id":"4915...@c.us","text":"Hallo Jasper, …","approval":"explicit_user_request"}'
```

Bei Erfolg antwortet die Bridge mit `{"ok": true, ...}`.

Der Backend-Send legt automatisch eine Learning-Log-Akte an:

- `workflow_key = whatsapp.send`
- Input: Empfänger, Text, Route, optionale Freigabe
- Steps: Start, Empfänger, Backend Send, Send Ergebnis, Post Run Check
- Review: prüft Pflichtfelder, Backend-Route, Bridge-Ergebnis und Message-ID

Der Run ist in der InfoPane unter `Automation → Learning Log` sichtbar. Der Prüfer ändert die gesendete Nachricht nicht; er schreibt nur Audit, Risiko und mögliche Skill-Verbesserung in die Laufakte.

## Absolute Tabus

- **Nie unbeaufsichtigt senden.** Nur wenn der Nutzer in dieser Nachricht explizit dazu auffordert ("schick ihm das", "sag ihr"). Nicht proaktiv, nicht aus einem Cron, nicht als Interpretation einer allgemeinen Bitte.
- **Text vorher zeigen** wenn er länger ist als ein Satz oder wenn der Nutzer ihn nicht wörtlich diktiert hat. Eine kurze Bestätigung reicht ("Schick ich so ab: '…'"), dann senden.
- **Keine Annahmen bei Mehrdeutigkeit.** Lieber einmal nachfragen als den falschen Jasper anschreiben.
- **Bridge-Direktcall verboten.** Port 8891 (rohe WA-Bridge) ist kein Test-Endpunkt — was dort reingeht, geht sofort echt raus. Senden immer nur über `/api/whatsapp/send` mit Backend-Auth. Bei `unauthorized`-Fehler: Auth klären, nicht umgehen.
- **Kein Test-Send an echte Kontakte.** Wenn ein Send-Test nötig ist, ausschließlich an des Nutzers eigene Nummer (+49 170 0000000). Vor jedem curl-Send den Empfänger zweimal lesen.

## Gruppen

`is_group: true` im Match bedeutet: das ist eine Gruppe, nicht eine einzelne Person. Wenn der Nutzer nicht explizit eine Gruppe meint, ist das wahrscheinlich der falsche Match. Nochmal nachfragen.

## Nach dem Senden

Kurz bestätigen, Format frei: "Abgeschickt." oder "Geht raus an Jasper." Kein separater Bericht, kein Nachbeten des Textes.

Wenn der Send-Endpoint ein `workflow_review_status` ungleich `ok` zurückgibt, kurz sagen, dass der Send erfolgt ist, aber die Nachprüfung eine Warnung hat. Nicht automatisch noch einmal senden.

## Drafts schreiben

Wenn der Nutzer "mach mal eine Draft für WhatsApp an X" sagt, gilt:

- **Fence ist `wa-draft`**, nicht `draft`. Der Renderer setzt den Quote-Balken dann auf WhatsApp-Grün.
- **Keine Begrüßung.** Kein "Moin Jasper", "Hi Marco", "Hallo X" am Anfang. WhatsApp ist ein fortlaufender Chat, der Nutzer schreibt da nicht jedes Mal "Hallo". Ausnahme: er sagt explizit "mit Begrüßung" oder "schreib ihn an" (also Erstkontakt). Im Zweifel ohne.
- **Ein Absatz.** Möglichst alles in einem durchgeschriebenen Absatz. Nur trennen, wenn echt zwei Gedanken — zwischen Body und Gruß kein eigener Absatz.
- **Keine Em-/En-/Bindestriche** als Stilmittel im Fließtext. Komma, Punkt oder neuer Satz. Auch nicht "—", "–", " - ".
- **Klingt wie der Nutzer.** Umgangssprachlich, leicht hingeworfen, nicht zu poliert. Lieber ein bisschen unrund als gestelzt-perfekt. Siehe `feedback_whatsapp_style.md` in Memory.
- **Keine Meta-Phrasen.** Nicht "Kurze Rückmeldung", "Wollte mich melden wegen". Direkt rein.
- **Keine harten Zeilenumbrüche** im Fließtext. WhatsApp bricht selbst um.

Beispiel:

```wa-draft
Hab kurz reingeschaut, passt soweit. Die zwei Slots am Donnerstag mach ich auf, dann sehen wir weiter.
```

Nicht so:

```
Moin Jasper,

hab kurz reingeschaut — passt soweit. Die zwei Slots am Donnerstag mach ich auf,
dann sehen wir weiter.

Gruß
der Nutzer
```
