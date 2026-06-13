"""Lexware-Fassade — schmaler Wrapper, damit alter `import lexware as _lex`
weiter funktioniert. Provider liegt jetzt unter
`modules/lexware/providers/lexoffice.py`, Routen + Finance-Cache unter
`modules/lexware/core.py`.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = str(Path(__file__).parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from modules.lexware.providers.lexoffice import *  # noqa: F401, F403


def __getattr__(name: str):
    from modules.lexware.providers import lexoffice as _prov
    try:
        return getattr(_prov, name)
    except AttributeError as e:
        raise AttributeError(f"module 'lexware' has no attribute {name!r}") from e
