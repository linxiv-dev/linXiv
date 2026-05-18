"""SQL queries for the service layer, matching the schema in storage/config/sql/tables/.

Conventions
-----------
- ``Q`` is a lightweight composable WHERE-clause builder (combine with ``&``, ``|``, ``~``).
- ``_fetch_one``, ``_fetch_all``, and ``_count`` are the catch-all runners; wrapper
  functions build a ``Q`` dynamically and call them — no hardcoded SQL strings for
  simple lookups.
- JOIN queries that span multiple tables are kept as named SQL constants below
  their section header.
- Paper queries use the ``papers`` / ``latest_papers`` views (PAPER JOIN PAPER_META).
- Surrogate-key column names follow the schema exactly (AUTHOR_FK, SOURCE_FK, ...).
"""
from __future__ import annotations

import sqlite3
from typing import Iterable, Optional

from .core import DB_PATH


def _connect(db_path: str | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path or DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# ---------------------------------------------------------------------------
# Query builder
# ---------------------------------------------------------------------------

class Q:
    """Composable SQL WHERE predicate. Combine with &, |, ~."""
    def __init__(self, sql: str, *params) -> None:
        self.sql    = sql
        self.params = params

    def __and__(self, other: Q) -> Q:
        return Q(f"({self.sql} AND {other.sql})", *self.params, *other.params)

    def __or__(self, other: Q) -> Q:
        return Q(f"({self.sql} OR {other.sql})", *self.params, *other.params)

    def __invert__(self) -> Q:
        return Q(f"(NOT {self.sql})", *self.params)


def _in(col: str, vals: list) -> Q:
    """Return a Q for ``col IN (?, ?, …)``. Caller must ensure vals is non-empty."""
    return Q(f"{col} IN ({','.join('?' * len(vals))})", *vals)


# ---------------------------------------------------------------------------
# Catch-all runners
# ---------------------------------------------------------------------------

def _fetch_one(table: str, q: Q) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(
            f"SELECT * FROM {table} WHERE {q.sql}", q.params
        ).fetchone()


def _fetch_all(
    table: str,
    q: Q | None = None,
    order_by: str | None = None,
) -> list[sqlite3.Row]:
    sql = f"SELECT * FROM {table}"
    params: tuple = ()
    if q:
        sql += f" WHERE {q.sql}"
        params = q.params
    if order_by:
        sql += f" ORDER BY {order_by}"
    with _connect() as conn:
        return conn.execute(sql, params).fetchall()


def _count(table: str, q: Q) -> int:
    with _connect() as conn:
        return conn.execute(
            f"SELECT COUNT(*) AS n FROM {table} WHERE {q.sql}", q.params
        ).fetchone()["n"]


# ---------------------------------------------------------------------------
# AUTHOR
# ---------------------------------------------------------------------------

_LIST_AUTHORS_FROM_PAPER_SQL = """
SELECT a.AUTHOR_FK, a.AUTHOR_FULL_NAME, a.AUTHOR_FIRST, a.AUTHOR_LAST, a.AUTHOR_ORCID
FROM AUTHOR a
JOIN PAPER_TO_AUTHOR pta ON pta.AUTHOR_FK = a.AUTHOR_FK
WHERE pta.PAPER_ID = ?
ORDER BY pta.AUTHOR_INDEX
"""

_GET_AUTHOR_PAPERS_SQL = """
SELECT p.PAPER_ID, p.SOURCE_ID, p.VERSION, p.TITLE, p.CATEGORY, p.HAS_PDF, p.SOURCE_FK
FROM PAPER p
JOIN PAPER_TO_AUTHOR pta ON pta.PAPER_ID = p.PAPER_ID
WHERE pta.AUTHOR_FK = ?
ORDER BY pta.AUTHOR_INDEX
"""


def get_author_from_key(author_fk: int) -> Optional[sqlite3.Row]:
    return _fetch_one("AUTHOR", Q("AUTHOR_FK = ?", author_fk))


def list_authors(
    paper_id: int | None = None,
    name: str | None = None,
) -> list[sqlite3.Row]:
    if paper_id:
        with _connect() as conn:
            return conn.execute(_LIST_AUTHORS_FROM_PAPER_SQL, (paper_id,)).fetchall()
    q = Q("AUTHOR_FULL_NAME LIKE ?", f"%{name}%") if name else None
    return _fetch_all("AUTHOR", q, order_by="AUTHOR_LAST, AUTHOR_FIRST")


def get_papers_via_author_fk(author_fk: int) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(_GET_AUTHOR_PAPERS_SQL, (author_fk,)).fetchall()


# ---------------------------------------------------------------------------
# PAPER  (via `papers` / `latest_papers` views — PAPER JOIN PAPER_META)
# ---------------------------------------------------------------------------

def get_paper(paper_id: int) -> Optional[sqlite3.Row]:
    """Fetch a specific paper version by its PAPER_ID."""
    return _fetch_one("papers", Q("paper_id = ?", paper_id))


def get_paper_by_source(source_fk: int, version: int | None = None) -> Optional[sqlite3.Row]:
    """Fetch the latest version of a paper, or a specific version if given."""
    q = Q("source_fk = ?", source_fk)
    if version:
        return _fetch_one("papers", q & Q("version = ?", version))
    return _fetch_one("latest_papers", q)


def list_papers(source_fks: Iterable[int] | None = None) -> list[sqlite3.Row]:
    if not source_fks:
        return _fetch_all("latest_papers", order_by="paper_id")
    fks = list(source_fks)
    if not fks:
        return []
    return _fetch_all("latest_papers", _in("source_fk", fks), order_by="paper_id")


def list_paper_versions(source_fk: int) -> list[sqlite3.Row]:
    return _fetch_all("papers", Q("source_fk = ?", source_fk), order_by="version ASC")


def get_paper_meta(paper_id: int) -> Optional[sqlite3.Row]:
    return _fetch_one("PAPER_META", Q("PAPER_ID = ?", paper_id))



# ---------------------------------------------------------------------------
# TAG
# ---------------------------------------------------------------------------

_TAGS_BY_PAPER_BASE_SQL = """
SELECT DISTINCT t.TAG_FK, t.TAG
FROM TAG t
JOIN PAPER_TO_TAG ptt ON ptt.TAG_FK = t.TAG_FK
"""

_TAGS_BY_PROJECT_BASE_SQL = """
SELECT DISTINCT t.TAG_FK, t.TAG
FROM TAG t
JOIN PROJECT_TO_TAG ptt ON ptt.TAG_FK = t.TAG_FK
"""

# Returns the latest version of every paper that has the tag on any version.
_LIST_PAPERS_BY_TAG_SQL = """
SELECT DISTINCT lp.*
FROM latest_papers lp
JOIN PAPER p ON p.SOURCE_FK = lp.source_fk
JOIN PAPER_TO_TAG ptt ON ptt.PAPER_ID = p.PAPER_ID
WHERE ptt.TAG_FK = ?
ORDER BY lp.paper_id
"""

_LIST_PROJECTS_BY_TAG_SQL = """
SELECT DISTINCT pr.*
FROM PROJECT pr
JOIN PROJECT_TO_TAG ptt ON ptt.PROJECT_FK = pr.PROJECT_FK
WHERE ptt.TAG_FK = ?
ORDER BY pr.PROJECT_FK
"""


def tags_in_rows(rows: list[sqlite3.Row]) -> Q:
    """Return a Q predicate for TAG_FK IN (…). Compose with & / | as needed."""
    return _in("TAG_FK", [row["TAG_FK"] for row in rows if row["TAG_FK"]])


def get_tag(tag_fk: int) -> Optional[sqlite3.Row]:
    return _fetch_one("TAG", Q("TAG_FK = ?", tag_fk))


def list_tags_by_paper(q: Q | None = None) -> list[sqlite3.Row]:
    where = f"WHERE {q.sql} " if q else ""
    with _connect() as conn:
        return conn.execute(
            _TAGS_BY_PAPER_BASE_SQL + where + "ORDER BY t.TAG",
            q.params if q else (),
        ).fetchall()


def list_tags_by_project(q: Q | None = None) -> list[sqlite3.Row]:
    where = f"WHERE {q.sql} " if q else ""
    with _connect() as conn:
        return conn.execute(
            _TAGS_BY_PROJECT_BASE_SQL + where + "ORDER BY t.TAG",
            q.params if q else (),
        ).fetchall()


def list_papers_by_tag(tag_fk: int) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(_LIST_PAPERS_BY_TAG_SQL, (tag_fk,)).fetchall()


def list_projects_by_tag(tag_fk: int) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(_LIST_PROJECTS_BY_TAG_SQL, (tag_fk,)).fetchall()

# ---------------------------------------------------------------------------
# PROJECT
# ---------------------------------------------------------------------------

_LIST_PROJECT_PAPERS_SQL = """
SELECT lp.*
FROM latest_papers lp
JOIN PROJECT_TO_PAPER ptp ON ptp.SOURCE_FK = lp.source_fk
WHERE ptp.PROJECT_FK = ?
ORDER BY lp.paper_id
"""

_LIST_PROJECTS_FOR_PAPER_SQL = """
SELECT pr.PROJECT_FK, pr.NAME, pr.DESCRIPTION, pr.COLOR, pr.STATUS,
       pr.PROJECT_TAGS, pr.CREATED_AT, pr.UPDATED_AT, pr.ARCHIVED_AT
FROM PROJECT pr
JOIN PROJECT_TO_PAPER ptp ON ptp.PROJECT_FK = pr.PROJECT_FK
WHERE ptp.SOURCE_FK = ?
ORDER BY pr.PROJECT_FK
"""


def get_project(project_fk: int) -> Optional[sqlite3.Row]:
    return _fetch_one("PROJECT", Q("PROJECT_FK = ?", project_fk))


def list_projects() -> list[sqlite3.Row]:
    return _fetch_all("PROJECT", order_by="PROJECT_FK")


def list_project_papers(project_fk: int) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(_LIST_PROJECT_PAPERS_SQL, (project_fk,)).fetchall()


_COUNT_ACTIVE_PROJECT_PAPERS_SQL = """
SELECT COUNT(*) FROM PROJECT_TO_PAPER p2p
JOIN PAPER_ROOTS r ON r.SOURCE_FK = p2p.SOURCE_FK
WHERE p2p.PROJECT_FK = ? AND r.STATUS = 'active'
"""


def count_project_papers(project_fk: int) -> int:
    with _connect() as conn:
        row = conn.execute(_COUNT_ACTIVE_PROJECT_PAPERS_SQL, (project_fk,)).fetchone()
    return int(row[0]) if row else 0


def list_projects_for_paper(source_fk: int) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(_LIST_PROJECTS_FOR_PAPER_SQL, (source_fk,)).fetchall()


# ---------------------------------------------------------------------------
# NOTE
# ---------------------------------------------------------------------------

def get_note(note_sk: int) -> Optional[sqlite3.Row]:
    return _fetch_one("NOTE", Q("NOTE_SK = ?", note_sk))


def list_notes(
    source_fk: int | None = None,
    paper_id_fk: int | None = None,
    project_fk: int | None = None,
) -> list[sqlite3.Row]:
    clauses: list[Q] = []
    if source_fk:
        clauses.append(Q("SOURCE_FK = ?", source_fk))
    if paper_id_fk:
        clauses.append(Q("PAPER_ID_FK = ?", paper_id_fk))
    if project_fk:
        clauses.append(Q("PROJECT_FK = ?", project_fk))
    if not clauses:
        return []
    q = clauses[0]
    for c in clauses[1:]:
        q = q & c
    return _fetch_all("NOTE", q, order_by="NOTE_SK")


def count_project_notes(project_fk: int) -> int:
    return _count("NOTE", Q("PROJECT_FK = ?", project_fk))
