# Template installierbar: Installer plus

Stand: 7. Juli 2026. Arbeitsbranch: `werk/template-installer-plus`.

## Kurzstand

Das Template hat jetzt einen echten ersten Installer-Weg plus generische Engine-Erkennung. Der Installer prüft die Mac-Grundlagen, richtet Backend und Frontend ein, führt durch die Engine-Anmeldung und erkennt vorhandene lokale CLI-Engines. Die Laufzeit hängt nicht mehr blind an `codex` oder `claude` im minimalen Server-`PATH`, sondern nutzt eine generische Discovery-Schicht mit Selbstheilung.

Erkannt wurden lokal alle drei Ziel-Engines: Claude, Codex und Hermes. Die konkreten Maschinenpfade wurden nur in der lokal ignorierten Datei `config/engine-runtime.json` geschrieben und werden nicht versioniert.

## Architekturentscheidung

Ich habe den kleinsten tragfähigen Weg gewählt: eine gemeinsame Discovery-Schicht im Backend, ein kleines Installer-CLI darum herum und minimale Runtime-Verdrahtung in den bestehenden Engine-Pfaden. Das ist robuster als drei getrennte Checks in Installer, Server und UI, weil die eigentliche Wahrheit genau an einer Stelle liegt: `backend/engines/discovery.py`.

Die Discovery scannt `PATH` plus die üblichen Mac-Orte: Homebrew, nvm, volta, bun, npm-global, `~/.local/bin`, `~/.claude/local` und lokale Bin-Ordner. Der Installer schreibt die Funde in `config/engine-runtime.json`, aber die Laufzeit vertraut dem File nicht blind. Wenn der dort notierte Pfad später verschwindet, scannt der Server frisch und nutzt den neuen Pfad. Damit ist der nvm- und Node-Update-Fall abgedeckt.

Der Zweitblick auf die Architektur: Die Discovery-Schicht ist richtig platziert, weil sie weder Installer-only noch UI-only ist. Das Risiko liegt jetzt nicht mehr in kaputtem `PATH`, sondern in CLI-spezifischen Headless-Aufrufen. Codex und Claude nutzen die vorhandenen stabilen Pfade, Hermes ist als Oneshot angebunden und kann als nächster Schritt noch tiefer gestreamt werden.

## Geänderte Bereiche

Neu:

- `backend/engines/discovery.py`: generische CLI-Erkennung, Runtime-Manifest, Selbstheilung bei verschobenen Binary-Pfaden.
- `backend/engines/hermes_cli.py`: Hermes als Runtime-Engine-Profil mit Modellen.
- `scripts/engine-detect.py`: Installer- und Wartungsbefehl zum Scannen und Schreiben von `config/engine-runtime.json`.

Geändert:

- `backend/engines/registry.py`: Hermes in die Runtime-Registry aufgenommen, Alias-Logik ergänzt.
- `backend/engines/runtime_policy.py`: Codex, Claude und Hermes lösen ihre Binary-Pfade über die Discovery auf.
- `backend/streaming.py`: Hermes kann als Chat-Engine ausgewählt und per Headless-Oneshot ausgeführt werden.
- `backend/routers/misc.py` und `backend/tools/executors.py`: `/api/engines` und Tool-Ausgabe zeigen installierte Engines als `available`.
- `scripts/install-agent-control.sh`: Installer schreibt nach dem Engine-Setup die erkannten CLI-Engines lokal fest.
- `scripts/engine-setup.sh`: Hermes wird als auswählbare CLI-Engine geprüft.
- `scripts/agent-control-setup.py` und `config/setup-profiles.json`: Hermes ist als Engine-Profil verfügbar.
- `install.sh` und `scripts/install-agent-control.sh`: `--non-interactive` funktioniert als Alias für `--yes`, damit die Smoke-Matrix nicht an einem falschen Flag scheitert.
- `.gitignore`: `config/engine-runtime.json` wird ignoriert, damit keine Maschinenpfade ins Repo kommen.
- `README.md` und `docs/INSTALL.md`: Installationsweg und Engine-Erkennung dokumentiert.

## Verifikation

Ausgeführt und grün:

```bash
python3 -m json.tool config/setup-profiles.json >/dev/null
python3 -m py_compile backend/engines/discovery.py backend/engines/hermes_cli.py backend/engines/registry.py backend/engines/runtime_policy.py backend/routers/misc.py backend/tools/executors.py backend/streaming.py scripts/engine-detect.py scripts/agent-control-setup.py
python3 scripts/engine-detect.py
python3 scripts/engine-detect.py --write
bash scripts/engine-setup.sh hermes --check-only
bash scripts/install-agent-control.sh --dry-run --non-interactive --profile=client-basic --engine=hermes --skip-doctor
bash scripts/install-agent-control.sh --dry-run --non-interactive
```

Die Dry-runs laufen durch. Der volle Installer mit Abhängigkeitsinstallation wurde bewusst nicht als destruktiver Neuinstallationslauf gegen diese bestehende Arbeitskopie gefahren. Die Engine-Erkennung selbst wurde real ausgeführt und hat mindestens eine Engine erkannt, tatsächlich alle drei.

## Offen

Hermes ist jetzt echt angebunden, aber noch nicht auf demselben Streaming-Niveau wie Codex und Claude. Es läuft als Headless-Oneshot: Text kommt gesammelt zurück, nicht Token für Token. Das ist für den ersten installierbaren Stand ausreichend, für ein späteres Produktgefühl aber der nächste saubere Ausbau.

Ein Server-Neustart ist nötig, weil Backend-Code, Engine-Registry, Runtime-Policy und Streaming geändert wurden.
