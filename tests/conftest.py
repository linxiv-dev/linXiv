"""Shared fixtures for the test suite."""
import pytest
import sys
import os

# Make sure the project root is on the path so db/projects can be imported.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture()
def tmp_db(tmp_path, monkeypatch):
    """
    Redirect all DB calls to a fresh temporary SQLite file for the duration of
    a test.

    Both db._connect and projects._connect (which is the same function object
    imported into projects via `from db import _connect`) need to be patched so
    that every call in either module ends up at the temp DB.
    """
    import storage.db as db
    import storage.projects as projects
    import storage.notes as notes

    db_file = str(tmp_path / "test.db")

    real_connect = db._connect

    def patched_connect(db_path=None):
        del db_path
        return real_connect(db_file)

    monkeypatch.setattr(db, "_connect", patched_connect)
    monkeypatch.setattr(projects, "_connect", patched_connect)
    monkeypatch.setattr(notes, "_connect", patched_connect)

    # Initialise the schema in the temp DB.
    db.init_db()            # creates PAPER_ROOTS, LIBRARY_NOTE, PROJECT, etc.
    projects.init_projects_db()  # creates projects + project_papers

    return db_file


@pytest.fixture()
def note_projects(tmp_db):
    """Extend tmp_db with 10 pre-created projects so notes.project_id FK
    constraints are satisfied when tests use hard-coded project IDs 1-10."""
    import sqlite3
    from storage.projects import Project
    for i in range(10):
        p = Project(name=f"Dummy {i + 1}")
        p.save()
        # LIBRARY_NOTE.PROJECT_FK references PROJECT(PROJECT_FK) (new schema table)
        with sqlite3.connect(tmp_db) as conn:
            conn.execute("INSERT OR IGNORE INTO PROJECT (PROJECT_FK) VALUES (?)", (p.id,))
    return tmp_db
