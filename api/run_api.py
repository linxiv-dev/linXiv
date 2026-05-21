"""
HTTP JSON API for linXiv → http://127.0.0.1:8000

- OpenAPI: http://127.0.0.1:8000/docs
- External frontends call ``/api/...`` on this origin.

CORS: set env ``CORS_ORIGINS`` to a comma-separated list of frontend origins, e.g.
``http://localhost:5173``. If unset, all origins are allowed (no credentials).

Run with venv:
    python -m api
"""

from __future__ import annotations

import sys
from pathlib import Path
import uvicorn

_PROJECT_ROOT = Path(__file__).resolve().parent.parent


def run() -> None:
    # reload=True requires the source tree — disabled in frozen PyInstaller builds
    reload = not getattr(sys, "frozen", False)
    uvicorn.run(
        "api.app:app",
        host="127.0.0.1",
        port=8000,
        reload=reload,
        reload_dirs=[str(_PROJECT_ROOT)] if reload else None,
    )


if __name__ == "__main__":
    run()
