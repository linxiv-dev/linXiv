from __future__ import annotations

import sqlite3
from pathlib import Path

_SQL_DIR = Path(__file__).resolve().parent / "sql"
_TABLES_DIR = _SQL_DIR / "tables"
_VIEWS_DIR = _SQL_DIR / "views"

# Apply in dependency order (FK-safe). Versioned rows: ``PAPER`` + ``PAPER_META``; root id in ``paper_roots``.
_TABLE_DDL_ORDER: tuple[str, ...] = (
    "AUTHOR.sql",
    "TAG.sql",
    "PROJECT.sql",
    "PAPER_ROOTS.sql",
    "PAPER.sql",
    "PAPER_META.sql",
    "PAPER_TO_AUTHOR.sql",
    "PAPER_TO_TAG.sql",
    "PROJECT_TO_PAPER.sql",
    "PROJECT_TO_TAG.sql",
    "NOTE.sql",
    "papers_fts.sql",
    "DB_VERSION.sql",
)

DB_PATH = str(Path(__file__).resolve().parent.parent.parent / "papers.db")


def _ordered_table_paths() -> list[Path]:
    paths: list[Path] = []
    for name in _TABLE_DDL_ORDER:
        p = _TABLES_DIR / name
        if p.is_file():
            paths.append(p)
    return paths


def _apply_views(conn: sqlite3.Connection) -> None:
    if not _VIEWS_DIR.is_dir():
        return
    candidates = sorted(_VIEWS_DIR.glob("*.sql")) + sorted(_VIEWS_DIR.glob("*.SQL"))
    for path in candidates:
        script = path.read_text(encoding="utf-8").strip()
        if script:
            conn.executescript(script)


def _apply_indices(conn: sqlite3.Connection) -> None:
    path = _SQL_DIR / "INDICIES.SQL"
    if not path.is_file():
        return
    script = path.read_text(encoding="utf-8").strip()
    if script:
        conn.executescript(script)


def _migrate_paper_roots_soft_delete(conn: sqlite3.Connection) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(PAPER_ROOTS)")}
    if "STATUS" not in cols:
        conn.execute(
            "ALTER TABLE PAPER_ROOTS ADD COLUMN STATUS TEXT NOT NULL DEFAULT 'active'"
        )
    if "DELETED_AT" not in cols:
        conn.execute("ALTER TABLE PAPER_ROOTS ADD COLUMN DELETED_AT TIMESTAMP")


def apply_sql_schema(conn: sqlite3.Connection) -> None:
    """Create bundled tables (and optional views/indexes) from ``sql/tables``."""
    conn.execute("PRAGMA foreign_keys = ON")
    for path in _ordered_table_paths():
        script = path.read_text(encoding="utf-8").strip()
        if script:
            conn.executescript(script)
    _migrate_paper_roots_soft_delete(conn)
    _apply_views(conn)
    _apply_indices(conn)


def init_db(db_path: str | None = None) -> None:
    """Standalone initializer: open ``papers.db`` (or ``db_path``) and apply SQL."""
    path = db_path if db_path else DB_PATH
    conn = sqlite3.connect(path)
    try:
        apply_sql_schema(conn)
    finally:
        conn.close()
