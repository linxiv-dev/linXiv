import os
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent


def data_dir() -> Path:
    """Runtime data dir: DB, PDFs, user settings.
    In production Tauri sets LINXIV_DATA_DIR to the OS app data directory.
    In development falls back to the project root (existing behaviour).
    """
    d = os.environ.get("LINXIV_DATA_DIR")
    if d:
        return Path(d)
    return _PROJECT_ROOT


def resources_dir() -> Path:
    """Read-only bundled resources: SQL schemas, graph assets, format templates.
    In a PyInstaller frozen build these are extracted to sys._MEIPASS.
    In development they live at the project root.
    """
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return _PROJECT_ROOT


# .env file location — used by load_dotenv in api/app.py for development.
# In production Tauri injects env vars directly; this path just needs to exist.
ENV_PATH = data_dir() / ".env"
