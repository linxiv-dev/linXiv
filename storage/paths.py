from __future__ import annotations

from pathlib import Path

from config import data_dir


def db_path() -> Path:
    return data_dir() / "papers.db"


def pdf_dir() -> Path:
    return data_dir() / "pdfs"


# Legacy PDF location — only used for migration
def old_pdf_dir() -> Path:
    return data_dir() / "gui" / "pdfs"
