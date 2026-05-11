"""Shared fixtures — each test gets a fresh, isolated SQLite DB."""
from __future__ import annotations

import importlib
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from storage.config.core import apply_sql_schema


@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    """Redirect every storage call to a fresh temp DB; make init helpers no-ops."""
    db_file = str(tmp_path / "test.db")

    conn = sqlite3.connect(db_file, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    apply_sql_schema(conn)
    conn.close()

    def _fake_connect(db_path: str = db_file) -> sqlite3.Connection:
        c = sqlite3.connect(db_file, detect_types=sqlite3.PARSE_DECLTYPES)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys = ON")
        return c

    for mod_name in ["storage.db", "storage.projects", "storage.notes", "storage.tags", "storage.authors"]:
        mod = importlib.import_module(mod_name)
        if hasattr(mod, "_connect"):
            monkeypatch.setattr(mod, "_connect", _fake_connect)

    monkeypatch.setattr("service.paper.init_db", lambda: None)
    monkeypatch.setattr("service.project.ensure_projects_db", lambda: None)
    monkeypatch.setattr("service.note.ensure_notes_db", lambda: None)

    pdf_dir = tmp_path / "pdfs"
    pdf_dir.mkdir()
    monkeypatch.setattr("service.files._pdf_dir", lambda: pdf_dir)

    yield db_file


@pytest.fixture()
def note_projects(tmp_db):
    """Pre-create 10 projects so test_notes.py FK constraints are satisfied."""
    from storage.projects import Project
    for i in range(10):
        p = Project(name=f"Dummy {i + 1}")
        p.save()
    return tmp_db
