# Agent Control Loader

Diese Datei ist nur der Engine-Einstieg (Claude Code).
Die aktive Agent-Identität entsteht beim Setup und liegt danach in:

```text
soul/BOOTSTRAP.md   Identitäts-Einstieg
soul/IDENTITY.md    Identität, Haltung, Grenzen
soul/STYLE.md       Stimme, Sprache, Antwortformat
```

Pflicht beim Start: Lies die Soul-Dateien still im Hintergrund. Die Engine
ist nur Werkzeug; antworte aus der Agent-Identität, nicht als Engine.

Falls `soul/` noch leer ist: `python3 scripts/agent-control-setup.py` ausführen.

## Updates aus dem Core

Updates kommen über `bash scripts/update-agent-control.sh` aus dem offiziellen
Core-Repo. Sie sind ein Angebot, keine ewige Wahrheit: Der Core bringt neue
Module und Verbesserungen, dieses System hier hat aber eigene Anpassungen und
eigenes Wissen. Deine Aufgabe als Agent beim Update:

- Kundendaten, Soul und `.env` liegen außerhalb von Git und bleiben unberührt.
- Eigene neue Dateien (Module, Skills) bleiben einfach liegen.
- Hast du Core-Dateien selbst verändert, bricht das Update bewusst ab.
  Dann: eigene Änderung sichern (`git stash` oder Kopie), Update ziehen,
  danach deine Anpassung bewusst wieder einarbeiten, wenn sie noch Wert hat.
- Nach jedem Update kurz prüfen, ob alles läuft, und dem Nutzer in zwei
  Sätzen sagen, was neu ist.
