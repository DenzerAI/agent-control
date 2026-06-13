"""Google-Calendar-Fassade — schmaler Wrapper, damit alter
`from google_calendar import GoogleCalendar, has_credentials` weiter
funktioniert. Provider liegt jetzt unter
`modules/calendar/providers/google.py`.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = str(Path(__file__).parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from modules.calendar.providers.google import *  # noqa: F401, F403
