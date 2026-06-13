"""Klaus-Channel — proaktiver Faden, Klaus-spezifisch.

Re-exportiert die Library aus core.py, damit Importer via
`modules.klaus_channel` zugreifen (server.py, db.py, pulses.py).
"""
from .core import *  # noqa: F401,F403
from . import core  # ermöglicht `from modules import klaus_channel; klaus_channel.post(...)`
