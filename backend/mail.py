"""Mail-Fassade — schmaler Wrapper, damit bestehende Aufrufer (server.py,
eingang.py, scripts/) weiter `import mail` schreiben koennen.

Die Mail-Schublade liegt jetzt in `modules/mail/`:
- `modules/mail/core.py`            -- Konten, IMAP, SMTP, Smartfilter
- `modules/mail/providers/resend.py` -- Resend-Versand-Anschluss

Diese Datei hat keine eigene Logik. Sie haengt nur den Repo-Root an
`sys.path`, importiert alle public Symbole aus `modules.mail.core` und
laesst `__getattr__` Zugriffe auf underscore-praefixed Helper (`_decode`,
`_connect_imap`, `_is_blocked`, ...) automatisch durchreichen, damit auch
`scripts/mail-fetch.py` und `scripts/backfill-mentions.py` unveraendert
weiter funktionieren.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Repo-Root sichern, damit `modules.mail.core` und `modules.mail.providers`
# importierbar sind, wenn der Server aus `backend/` heraus startet.
_REPO_ROOT = str(Path(__file__).parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from modules.mail.core import *  # noqa: F401, F403


def __getattr__(name: str):
    """Underscore-praefixed Helper transparent aus dem Kern durchreichen."""
    from modules.mail import core as _core
    try:
        return getattr(_core, name)
    except AttributeError as e:
        raise AttributeError(f"module 'mail' has no attribute {name!r}") from e
