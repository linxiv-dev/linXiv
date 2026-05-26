from __future__ import annotations

import os
import urllib.request
from pathlib import Path

from storage.paths import pdf_dir as _pdf_dir


def _pdf_file(paper_id: int, version: int) -> Path:
    return _pdf_dir() / f"{paper_id}v{version}.pdf"


def pdf_path(paper_id: int, version: int, custom_path: str | None = None) -> str | None:
    """Return local path to PDF if it exists, else None. Checks custom_path first."""
    if custom_path and Path(custom_path).is_file():
        return custom_path
    std = _pdf_file(paper_id, version)
    return str(std) if std.is_file() else None


def download_pdf(paper_id: int, version: int, url: str) -> str | None:
    """Download PDF to managed pdf_dir. Returns local path or None on failure."""
    dest = _pdf_file(paper_id, version)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(url) as resp:
            dest.write_bytes(resp.read())
        return str(dest)
    except Exception as exc:
        print(f"[files] download_pdf failed: {exc}")
        return None


def pdf_storage_mb() -> float:
    """Total size of all managed PDFs in MB."""
    d = _pdf_dir()
    if not d.exists():
        return 0.0
    return sum(
        os.path.getsize(d / f)
        for f in os.listdir(d)
        if f.endswith(".pdf")
    ) / (1024 * 1024)


def delete_pdf(path: str) -> bool:
    """Delete a PDF only if it lives inside the managed pdf_dir. Returns True if deleted."""
    managed = _pdf_dir().resolve()
    target = Path(path).resolve()
    if not target.is_relative_to(managed):
        return False
    target.unlink(missing_ok=True)
    return True


def managed_pdf_dir() -> str:
    """Return the managed pdf_dir as a string. For use by download workers only."""
    return str(_pdf_dir())
