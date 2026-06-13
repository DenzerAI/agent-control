---
name: server-restart
description: Agent-Server sicher neu starten
category: Integrationen / Automation
triggers:
- 'Christian fragt nach: Agent-Server sicher neu starten'
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

# Server-Restart

Der FastAPI-Server läuft unter launchd (`com.klaus.agent`), Logs unter `~/agent/logs/server.log` und `~/agent/logs/server.err.log`.

## Primary path: Christian tippt im Composer

Wenn Code geändert wurde und der Server neu muss, **rufst du NIE selbst** `restart-server.sh` auf. Stattdessen beendest du deine Antwort mit einer Frage, die exakt das Muster matcht, das der Composer-Detektor erkennt:

> "Server neu starten?"

oder leicht variiert mit Wörtern wie `restart`, `neustart`, `neu starten`. Wichtig: **Fragezeichen am Ende** und einer dieser Begriffe im letzten Satz. Der Frontend-Detektor in `frontend/src/components/ChatPane.tsx` (`detectRestartPrompt`) ersetzt dann den Confirm-Haken im Composer durch einen Restart-Button (`RotateCw`-Icon).

Christian tippt den, Frontend feuert `POST /api/restart-safe` (macht `os._exit(0)`), launchd startet neu, das Frontend pollt `/api/system-status` bis HTTP 200 und meldet "Server ist wieder da." Komplett ohne AppleScript-Dialog, komplett remote nutzbar.

Auf Mobile genauso: der Restart-Button ersetzt den Confirm-Haken in der Composer-Mitte (RotateCw statt Check).

## Wenn du selbst restarten musst (Notfall)

Nur wenn Christian explizit sagt "mach den Restart selbst" oder bei reinen Wartungs-Skripten ohne UI-Session:

```bash
bash /Users/klaus/agent/scripts/restart-server.sh
```

Dieses Skript hat eine Restart-Policy (Default: gesperrt). Wenn du es nicht ausführen kannst, **frag Christian per Composer-Pille**, statt das `osascript`-Dialog-Skript `restart-control.sh allow` anzuwerfen — das öffnet einen Dialog nur lokal auf dem iMac, was bei Remote-Sessions Bildschirmfreigabe nötig macht und entsprechend Quatsch ist.

Policy-Status prüfen ist ok:

```bash
bash /Users/klaus/agent/scripts/restart-control.sh status
```

## Session-Koordination (Pflicht)

Vor jedem Restart wird `/api/active-streams` geprüft. Wenn andere Claude-Streams laufen, bricht das Skript mit exit 2 ab und listet die `convId`s auf. Beim Composer-Button bekommt Christian den Block-Detail im Chat-Fehler. Parallele Sessions sind real — Christian arbeitet regelmäßig mit mehreren Claude-Instanzen gleichzeitig, ein blinder Kickstart kappt fremden Streams mitten im Satz die Pipe.

Vorgehen bei Block:

1. Schau dir die Liste der aktiven `convId`s an.
2. **Nur dein eigener Stream drin**: bei Bash-Aufruf `--force` anhängen.
3. **Andere `convId`s dabei:** nicht forcen. Kurz bei Christian nachfragen oder 10–30 Sekunden warten und nochmal prüfen.

### Auto-Resume paralleler Sessions (Composer-Restart)

Beim Restart über den Composer-Button stupst das auslösende Frontend die anderen
Sessions automatisch wieder an, damit Christian nicht mehr in jede Session
einzeln "wir sind wieder da" tippen muss:

1. **Vor** dem Kickstart snapshottet `handleRestart` `/api/active-streams` und merkt
   sich alle `convId`s außer der eigenen (die eigene führt das auslösende Pane selbst fort).
2. Sobald `/api/system-status` wieder 200 liefert, meldet es diese convIds an
   `POST /api/restart-broadcast`.
3. Das Backend (`streaming.broadcast_server_back`) schickt ein WS-Event `server.back`
   mit der convId-Liste an alle Clients. Jede betroffene Pane greift ihre eigene convId
   ab und sendet "Server ist wieder da." — der Faden läuft dort weiter.

Grenze: zuverlässig erwischt werden nur Sessions, die beim Restart **wirklich am
Streamen** waren. Ein stilles, idle offenes Pane taucht in `/api/active-streams`
nicht auf und wird nicht angestoßen. Busy-Panes (eigener noch laufender Stream)
bleiben unangetastet, ein modul-globales Dedupe verhindert Doppelsenden bei
gleicher convId in zwei Panes.

## Was beim Restart aus der Chat-Session passiert

Dein `claude`-Subprocess läuft innerhalb von Uvicorn. Der Restart kappt die stdout-Pipe, deine gerade streamende Antwort geht verloren. **Für dich selbst okay** — das Backend invalidiert nach Restart alle Claude-Session-IDs und baut beim nächsten Send aus der DB frischen Kontext. Christian kann weiterschreiben, der Thread bleibt nutzbar. Für andere Sessions gilt dasselbe, aber nur wenn sie vorher wissen, dass es passiert — deshalb die Koordination oben.

## Tabus

- **Nie ungefragt selbst** `restart-server.sh` aufrufen, wenn Christian remote ist. Frag im Chat mit "Server neu starten?" — der Composer-Button ist da.
- **Nie:** `restart-control.sh allow` aus einer Klaus-Antwort heraus. Öffnet einen lokalen Dialog und blockiert Remote.
- **Nie:** `pkill -9 -f uvicorn`, `kill $(lsof -ti :8890)`. Umgeht launchd und den Stream-Check.
- **Sparsam:** Ein Restart pro Arbeitsblock, nicht nach jeder Änderung. Sag Christian vorher was kommt, damit er nicht mitten im Tippen die UI verliert.
