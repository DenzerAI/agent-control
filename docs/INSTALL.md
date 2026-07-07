# Agent Control — Installation & Update

Kurzanleitung fuer eine frische Instanz auf einem Mac. Alle Befehle laufen im Terminal.

## Voraussetzungen

- macOS mit Terminal
- `git`, `python3`, `node` (der Installer kann fehlende Tools via Homebrew nachziehen: `--install-tools`)
- Eine lokale Engine-CLI oder ein API-Profil. Direkt erkannt werden `claude`, `codex` und `hermes`.

## 1. Installieren

Einfachster Weg:

```bash
curl -fsSL https://raw.githubusercontent.com/DenzerAI/agent-control/main/install.sh | bash
```

Der Installer fragt Profil, Name, Engine und Start ab.
Er fuehrt Schritt fuer Schritt durch das Setup und zeigt im Doctor klar, was bereit ist und was optional spaeter verbunden werden kann.

Auf einem nackten Mac erledigt der One-Click-Installer ausserdem:

- **Engine-CLI erkennen und anmelden:** Bei `codex`, `claude` oder `gemini` wird die passende CLI per `npm install -g` nachgezogen, der Login-Status geprueft und der Login-Flow gestartet (OAuth oeffnet den Browser, der Login wird vom Nutzer bestaetigt). `hermes` wird als vorhandene CLI erkannt und als Runtime-Engine angebunden; die Provider-Einrichtung bleibt in Hermes selbst. Bei den `*-api`-Engines laeuft es ueber den API-Key in `.env`.
- **Engine-Pfade selbstheilend festhalten:** Der Installer scannt `PATH` plus uebliche Mac-Orte wie Homebrew, nvm, volta, bun, npm-global und `~/.local/bin`. Gefundene Engines werden lokal in `config/engine-runtime.json` notiert. Wenn ein Pfad spaeter verschwindet, scannt der Server neu statt dauerhaft an einem alten Pfad zu haengen.
- **Autostart nach Reboot:** ein launchd-LaunchAgent startet Agent Control beim Login und haelt es am Leben.
- **Globaler Befehl `agent-control`:** startet den Server bei Bedarf und oeffnet die UI.

Einzeln abschaltbar mit `--no-engine-setup`, `--no-cli`, `--no-autostart`.

Manueller Weg:

```bash
git clone https://github.com/DenzerAI/agent-control.git
cd agent-control
bash scripts/install-agent-control.sh --profile=client-basic --engine=codex --name=Mila
```

Das richtet eine neutrale Instanz ein, installiert Abhaengigkeiten, baut das Frontend und legt die Config an.

`--profile` steuert, welche Reiter sichtbar sind:

- `client-basic` — Chat, Personen, Kalender, Suche (Standard fuer Kunden)
- `client-demo` — wie basic, mit Demo-Daten zum Zeigen
- `core` — nur Chat und Suche

## 2. Selbstcheck mit Reparatur

```bash
agent-control doctor
```

Prueft, ob alles korrekt sitzt, und behebt einfache Probleme selbst: fehlende oder zerschossene venv neu anlegen, Python-Pakete nachziehen, Frontend bauen falls `dist` fehlt, den Autostart-Dienst neu laden. Was Nutzer-Aktion braucht (Engine-Login, API-Key), wird klar als Hinweis ausgegeben. Ohne globalen Befehl: `bash scripts/doctor.sh`.

## 3. Starten und oeffnen

```bash
agent-control
```

Startet den Server bei Bedarf und oeffnet die UI im Browser. Weitere Unterbefehle: `agent-control start|restart|stop|status|update|doctor`. Ohne globalen Befehl: `bash scripts/start.sh`.

Der Server laeuft lokal, Chat ist im Browser und am Handy erreichbar. Nach einem Reboot startet die Instanz dank launchd von selbst.
Chatten geht sofort, wenn die gewaehlte Engine angemeldet ist. Mail, WhatsApp, Kalender und weitere APIs bleiben bewusst optionale Anschluesse.

Engine-Erkennung erneut ausfuehren:

```bash
python3 scripts/engine-detect.py --write
```

## 4. Aktualisieren

Wenn es eine neue Version gibt, ein einziger Befehl:

```bash
agent-control update
```

Ohne globalen Befehl: `bash scripts/update-agent-control.sh`.

Das holt den neuesten Code von GitHub, baut die Abhaengigkeiten neu und prueft die Instanz.

**Wichtig:** Deine Daten (Gespraeche, Kontakte, Gedaechtnis, Einstellungen) liegen lokal und ausserhalb von Git. Ein Update erneuert nur den Code und fasst diese Daten nie an. Danach den Server neu starten:

```bash
bash scripts/restart-server.sh
```

## Fernwartung

Ist die Instanz per Tailscale im privaten Netz, koennen Updates und Pflege aus der Ferne laufen, ohne dass Daten durch fremde Clouds gehen.
