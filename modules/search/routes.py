"""Routes-Shim fuer den Module-Loader.

Der Loader (`backend/module_loader.py`) erwartet pro aktiviertem Modul
eine `routes.py` mit `router: APIRouter`. Search exportiert seinen Router
aus `core.py`; diese Datei reicht ihn an den Loader durch.
"""
from .core import router

__all__ = ["router"]
