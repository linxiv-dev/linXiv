"""SQL queries for the service layer, matching the schema in storage/config/sql/tables/.

Conventions
-----------
- One ``*_SQL`` constant per query (parameterized with ``?`` placeholders).
- Thin Python wrappers that open a connection via ``_connect()`` and return
  ``sqlite3.Row`` objects (or lists of them).
- Surrogate-key column names follow the schema exactly (AUTHOR_SK, PAPER_SK, ...).

Schema gaps flagged inline as ``# SCHEMA-GAP``.
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
# AUTHOR
# ---------------------------------------------------------------------------

GET_AUTHOR_SQL = """
SELECT AUTHOR_SK, AUTHOR_FULL_NAME, AUTHOR_FIRST, AUTHOR_LAST, AUTHOR_ORCID
FROM AUTHOR
WHERE AUTHOR_SK = ?
"""

LIST_AUTHORS_SQL = """
SELECT AUTHOR_SK, AUTHOR_FULL_NAME, AUTHOR_FIRST, AUTHOR_LAST, AUTHOR_ORCID
FROM AUTHOR
ORDER BY AUTHOR_LAST, AUTHOR_FIRST
"""

LIST_AUTHORS_BY_NAME_SQL = """
SELECT AUTHOR_SK, AUTHOR_FULL_NAME, AUTHOR_FIRST, AUTHOR_LAST, AUTHOR_ORCID
FROM AUTHOR
WHERE AUTHOR_FULL_NAME LIKE ?
ORDER BY AUTHOR_LAST, AUTHOR_FIRST
"""

LIST_AUTHORS_BY_PAPER_SQL = """
SELECT a.AUTHOR_SK, a.AUTHOR_FULL_NAME, a.AUTHOR_FIRST, a.AUTHOR_LAST, a.AUTHOR_ORCID
FROM AUTHOR a
JOIN PAPER_TO_AUTHOR pta ON pta.AUTHOR_SK = a.AUTHOR_SK
WHERE pta.PAPER_SK = ?
ORDER BY pta.AUTHOR_INDEX
"""

GET_AUTHOR_PAPERS_SQL = """
SELECT p.PAPER_SK, p.DOI, p.VERSION, p.TITLE, p.TOPIC_PRIMARY_SK,
       p.CONTENT_SK, p.PRIMARY_AUTHOR_SK
FROM PAPER p
JOIN PAPER_TO_AUTHOR pta ON pta.PAPER_SK = p.PAPER_SK
WHERE pta.AUTHOR_SK = ?
ORDER BY pta.AUTHOR_INDEX
"""


def get_author(author_sk: int) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(GET_AUTHOR_SQL, (author_sk,)).fetchone()


def list_authors(
    paper_sk: int | None = None,
    name: str | None = None,
) -> list[sqlite3.Row]:
    with _connect() as conn:
        if paper_sk is not None:
            return conn.execute(LIST_AUTHORS_BY_PAPER_SQL, (paper_sk,)).fetchall()
        if name is not None:
            return conn.execute(LIST_AUTHORS_BY_NAME_SQL, (f"%{name}%",)).fetchall()
        return conn.execute(LIST_AUTHORS_SQL).fetchall()


def get_author_papers(author_sk: int) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(GET_AUTHOR_PAPERS_SQL, (author_sk,)).fetchall()


# ---------------------------------------------------------------------------
# PAPER
# ---------------------------------------------------------------------------

GET_PAPER_SQL = """
SELECT PAPER_SK, DOI, VERSION, TITLE, TOPIC_PRIMARY_SK,
       CONTENT_SK, PRIMARY_AUTHOR_SK
FROM PAPER
WHERE PAPER_SK = ?
"""

GET_PAPER_BY_VERSION_SQL = """
SELECT PAPER_SK, DOI, VERSION, TITLE, TOPIC_PRIMARY_SK,
       CONTENT_SK, PRIMARY_AUTHOR_SK
FROM PAPER
WHERE PAPER_SK = ? AND VERSION = ?
"""

GET_PAPER_WITH_META_SQL = """
SELECT p.PAPER_SK, p.DOI, p.VERSION, p.TITLE, p.TOPIC_PRIMARY_SK,
       p.CONTENT_SK, p.PRIMARY_AUTHOR_SK,
       m.PAPER_META_SK, m.URL, m.PUBLISHED_DATE, m.UPDATE_DATE,
       m.JOURNAL_REF, m.USER_COMMENT, m.SUMMARY
FROM PAPER p
LEFT JOIN PAPER_META m ON m.PAPER_SK = p.PAPER_SK
WHERE p.PAPER_SK = ?
"""

LIST_PAPERS_SQL = """
SELECT PAPER_SK, DOI, VERSION, TITLE, TOPIC_PRIMARY_SK,
       CONTENT_SK, PRIMARY_AUTHOR_SK
FROM PAPER
ORDER BY PAPER_SK
"""

LIST_PAPER_VERSIONS_SQL = """
SELECT PAPER_SK, DOI, VERSION, TITLE, TOPIC_PRIMARY_SK,
       CONTENT_SK, PRIMARY_AUTHOR_SK
FROM PAPER
WHERE PAPER_SK = ?
ORDER BY VERSION ASC
"""

GET_PAPER_META_SQL = """
SELECT PAPER_META_SK, PAPER_SK, URL, PUBLISHED_DATE, UPDATE_DATE,
       JOURNAL_REF, USER_COMMENT, SUMMARY
FROM PAPER_META
WHERE PAPER_SK = ?
"""

GET_PAPER_CONTENT_SQL = """
SELECT CONTENT_SK, PAPER_SK, CONTENT_TEXT, CONTENT_FILE
FROM CONTENT
WHERE PAPER_SK = ?
"""


def get_paper(paper_sk: int, version: int | None = None) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        if version is None:
            return conn.execute(GET_PAPER_SQL, (paper_sk,)).fetchone()
        return conn.execute(GET_PAPER_BY_VERSION_SQL, (paper_sk, version)).fetchone()


def get_paper_with_meta(paper_sk: int) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(GET_PAPER_WITH_META_SQL, (paper_sk,)).fetchone()


def list_papers(paper_sks: Iterable[int] | None = None) -> list[sqlite3.Row]:
    with _connect() as conn:
        if paper_sks is None:
            return conn.execute(LIST_PAPERS_SQL).fetchall()
        sks = list(paper_sks)
        if not sks:
            return []
        placeholders = ",".join("?" * len(sks))
        return conn.execute(
            f"""
            SELECT PAPER_SK, DOI, VERSION, TITLE, TOPIC_PRIMARY_SK,
                   CONTENT_SK, PRIMARY_AUTHOR_SK
            FROM PAPER
            WHERE PAPER_SK IN ({placeholders})
            ORDER BY PAPER_SK
            """,
            sks,
        ).fetchall()


def list_paper_versions(paper_sk: int) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(LIST_PAPER_VERSIONS_SQL, (paper_sk,)).fetchall()


def get_paper_meta(paper_sk: int) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(GET_PAPER_META_SQL, (paper_sk,)).fetchone()


def get_paper_content(paper_sk: int) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(GET_PAPER_CONTENT_SQL, (paper_sk,)).fetchone()


# ---------------------------------------------------------------------------
# TOPIC  (papers' analog to "tags")
# ---------------------------------------------------------------------------

GET_TOPIC_SQL = """
SELECT TOPIC_SK, TOPIC FROM TOPIC WHERE TOPIC_SK = ?
"""

LIST_TOPICS_SQL = """
SELECT TOPIC_SK, TOPIC FROM TOPIC ORDER BY TOPIC
"""

LIST_TOPICS_BY_PAPER_SQL = """
SELECT t.TOPIC_SK, t.TOPIC
FROM TOPIC t
JOIN PAPER_TO_TOPIC ptt ON ptt.TOPIC_SK = t.TOPIC_SK
WHERE ptt.PAPER_SK = ?
ORDER BY t.TOPIC
"""

LIST_TOPICS_BY_PROJECT_SQL = """
SELECT t.TOPIC_SK, t.TOPIC
FROM TOPIC t
JOIN PROJECT_TO_TOPIC ptt ON ptt.TOPIC_SK = t.TOPIC_SK
WHERE ptt.PROJECT_SK = ?
ORDER BY t.TOPIC
"""

LIST_PAPERS_BY_TOPIC_SQL = """
SELECT p.PAPER_SK, p.DOI, p.VERSION, p.TITLE, p.TOPIC_PRIMARY_SK,
       p.CONTENT_SK, p.PRIMARY_AUTHOR_SK
FROM PAPER p
JOIN PAPER_TO_TOPIC ptt ON ptt.PAPER_SK = p.PAPER_SK
WHERE ptt.TOPIC_SK = ?
ORDER BY p.PAPER_SK
"""


def get_topic(topic_sk: int) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(GET_TOPIC_SQL, (topic_sk,)).fetchone()


def list_topics(
    paper_sk: int | None = None,
    project_sk: int | None = None,
) -> list[sqlite3.Row]:
    with _connect() as conn:
        if paper_sk is not None:
            return conn.execute(LIST_TOPICS_BY_PAPER_SQL, (paper_sk,)).fetchall()
        if project_sk is not None:
            return conn.execute(LIST_TOPICS_BY_PROJECT_SQL, (project_sk,)).fetchall()
        return conn.execute(LIST_TOPICS_SQL).fetchall()


def list_papers_by_topic(topic_sk: int) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(LIST_PAPERS_BY_TOPIC_SQL, (topic_sk,)).fetchall()


# ---------------------------------------------------------------------------
# PROJECT
# ---------------------------------------------------------------------------
# SCHEMA-GAP: PROJECT only stores PROJECT_SK. Service layer expects name,
# description, color, status, created_at, updated_at, archived_at, tags.
# Queries below cover what the schema supports today; extend once columns land.

GET_PROJECT_SQL = """
SELECT PROJECT_SK FROM PROJECT WHERE PROJECT_SK = ?
"""

LIST_PROJECTS_SQL = """
SELECT PROJECT_SK FROM PROJECT ORDER BY PROJECT_SK
"""

LIST_PROJECT_PAPERS_SQL = """
SELECT p.PAPER_SK, p.DOI, p.VERSION, p.TITLE, p.TOPIC_PRIMARY_SK,
       p.CONTENT_SK, p.PRIMARY_AUTHOR_SK
FROM PAPER p
JOIN PROJECT_TO_PAPER ptp ON ptp.PAPER_SK = p.PAPER_SK
WHERE ptp.PROJECT_SK = ?
ORDER BY p.PAPER_SK
"""

COUNT_PROJECT_PAPERS_SQL = """
SELECT COUNT(*) AS n FROM PROJECT_TO_PAPER WHERE PROJECT_SK = ?
"""

LIST_PROJECTS_FOR_PAPER_SQL = """
SELECT pr.PROJECT_SK
FROM PROJECT pr
JOIN PROJECT_TO_PAPER ptp ON ptp.PROJECT_SK = pr.PROJECT_SK
WHERE ptp.PAPER_SK = ?
ORDER BY pr.PROJECT_SK
"""


def get_project(project_sk: int) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(GET_PROJECT_SQL, (project_sk,)).fetchone()


def list_projects() -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(LIST_PROJECTS_SQL).fetchall()


def list_project_papers(project_sk: int) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(LIST_PROJECT_PAPERS_SQL, (project_sk,)).fetchall()


def count_project_papers(project_sk: int) -> int:
    with _connect() as conn:
        return conn.execute(COUNT_PROJECT_PAPERS_SQL, (project_sk,)).fetchone()["n"]


def list_projects_for_paper(paper_sk: int) -> list[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(LIST_PROJECTS_FOR_PAPER_SQL, (paper_sk,)).fetchall()


# ---------------------------------------------------------------------------
# NOTES
# ---------------------------------------------------------------------------
# SCHEMA-GAP: NOTES only has (NOTE_SK, PAPER_SK, PROJECT_SK, NOTE). Service
# layer expects title, content, created_at, updated_at. Queries return what's
# present; extend once columns land.

GET_NOTE_SQL = """
SELECT NOTE_SK, PAPER_SK, PROJECT_SK, NOTE
FROM NOTES
WHERE NOTE_SK = ?
"""

LIST_NOTES_BY_PAPER_SQL = """
SELECT NOTE_SK, PAPER_SK, PROJECT_SK, NOTE
FROM NOTES
WHERE PAPER_SK = ?
ORDER BY NOTE_SK
"""

LIST_NOTES_BY_PAPER_AND_PROJECT_SQL = """
SELECT NOTE_SK, PAPER_SK, PROJECT_SK, NOTE
FROM NOTES
WHERE PAPER_SK = ? AND PROJECT_SK = ?
ORDER BY NOTE_SK
"""

LIST_NOTES_BY_PROJECT_SQL = """
SELECT NOTE_SK, PAPER_SK, PROJECT_SK, NOTE
FROM NOTES
WHERE PROJECT_SK = ?
ORDER BY NOTE_SK
"""

COUNT_PROJECT_NOTES_SQL = """
SELECT COUNT(*) AS n FROM NOTES WHERE PROJECT_SK = ?
"""


def get_note(note_sk: int) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        return conn.execute(GET_NOTE_SQL, (note_sk,)).fetchone()


def list_notes(
    paper_sk: int | None = None,
    project_sk: int | None = None,
) -> list[sqlite3.Row]:
    with _connect() as conn:
        if paper_sk is not None and project_sk is not None:
            return conn.execute(
                LIST_NOTES_BY_PAPER_AND_PROJECT_SQL, (paper_sk, project_sk)
            ).fetchall()
        if paper_sk is not None:
            return conn.execute(LIST_NOTES_BY_PAPER_SQL, (paper_sk,)).fetchall()
        if project_sk is not None:
            return conn.execute(LIST_NOTES_BY_PROJECT_SQL, (project_sk,)).fetchall()
        return []


def count_project_notes(project_sk: int) -> int:
    with _connect() as conn:
        return conn.execute(COUNT_PROJECT_NOTES_SQL, (project_sk,)).fetchone()["n"]
