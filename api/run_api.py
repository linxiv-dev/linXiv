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
import uvicorn


def run() -> None:
    # reload=True requires the source tree — disabled in frozen PyInstaller builds
    reload = not getattr(sys, "frozen", False)
    uvicorn.run("api.app:app", host="127.0.0.1", port=8000, reload=reload)


if __name__ == "__main__":
    run()
