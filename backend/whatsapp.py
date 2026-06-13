"""WhatsApp-Fassade — schmaler Wrapper, damit `server.py` weiter
`from whatsapp import ...` schreiben kann.

Die WhatsApp-Schublade liegt jetzt in `modules/whatsapp/`:
- `modules/whatsapp/core.py` -- Routen, DB-Helper, Summary/Classify-Worker
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = str(Path(__file__).parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from modules.whatsapp.core import *  # noqa: F401, F403


def __getattr__(name: str):
    from modules.whatsapp import core as _core
    try:
        return getattr(_core, name)
    except AttributeError as e:
        raise AttributeError(f"module 'whatsapp' has no attribute {name!r}") from e
