from __future__ import annotations

import datetime
from dataclasses import dataclass
from typing import Optional

from .db import _connect
from .config.queries import (
    get_note as _get_note_row,
    list_notes as _list_notes,
    count_notes as _count_notes,
    count_project_notes as _count_project_notes,
)
from service.models.note import NoteDetails


# ── DB schema ─────────────────────────────────────────────────────────────────

def _notes_table_exists() -> bool:
    with _connect() as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='NOTE'"
        ).fetchone()
    return row


def ensure_notes_db() -> None:
    if not _notes_table_exists():
        raise RuntimeError("NOTE table not found — run apply_sql_schema first")


# ── Data model ────────────────────────────────────────────────────────────────

@dataclass
class Note:
    source_fk:   int
    project_id:  Optional[int]               = None
    paper_id_fk: Optional[int]               = None  # pins note to a specific paper version
    title:       str                          = ""
    content:     str                          = ""
    id:          Optional[int]               = None
    created_at:  Optional[datetime.datetime] = None
    updated_at:  Optional[datetime.datetime] = None

    @classmethod
    def from_row(cls, row) -> Note:
        return cls(
            id          = row["NOTE_SK"],
            source_fk   = row["SOURCE_FK"],
            paper_id_fk = row["PAPER_ID_FK"],
            project_id  = row["PROJECT_FK"],
            title       = row["TITLE"] or "",
            content     = row["NOTE"] or "",
            created_at  = row["CREATED_AT"],
            updated_at  = row["UPDATED_AT"],
        )

    def to_details(self) -> NoteDetails:
        return NoteDetails(
            note_id     = self.id,
            source_fk   = self.source_fk,
            paper_id_fk = self.paper_id_fk,
            project_id  = self.project_id,
            title       = self.title,
            content     = self.content,
            created_at  = self.created_at,
            updated_at  = self.updated_at,
        )

    def save(self) -> None:
        now = datetime.datetime.now(datetime.timezone.utc)
        if self.id is None:
            with _connect() as conn:
                cur = conn.execute(
                    """
                    INSERT INTO NOTE
                        (SOURCE_FK, PAPER_ID_FK, PROJECT_FK, TITLE, NOTE, CREATED_AT, UPDATED_AT)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (self.source_fk, self.paper_id_fk, self.project_id,
                     self.title, self.content, now, now),
                )
                self.id = cur.lastrowid
            self.created_at = now
            self.updated_at = now
        else:
            with _connect() as conn:
                cur = conn.execute(
                    "UPDATE NOTE SET TITLE = ?, NOTE = ?, UPDATED_AT = ? WHERE NOTE_SK = ?",
                    (self.title, self.content, now, self.id),
                )
                if cur.rowcount == 0:
                    raise ValueError(f"Note with id={self.id} does not exist")
            self.updated_at = now

    def delete(self) -> None:
        if self.id is None:
            return
        if delete_note(self.id):
            self.id = None


# ── Queries ───────────────────────────────────────────────────────────────────

def get_note(note_id: int) -> Optional[NoteDetails]:
    row = _get_note_row(note_id)
    return Note.from_row(row).to_details() if row else None


def create_note(
    source_fk: int,
    paper_id_fk: Optional[int],
    project_id: Optional[int],
    title: str,
    content: str,
) -> int:
    """Insert a new note row. Returns NOTE_SK."""
    now = datetime.datetime.now(datetime.timezone.utc)
    with _connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO NOTE
                (SOURCE_FK, PAPER_ID_FK, PROJECT_FK, TITLE, NOTE, CREATED_AT, UPDATED_AT)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (source_fk, paper_id_fk, project_id, title, content, now, now),
        )
        note_id = cur.lastrowid
    if note_id is None:
        raise RuntimeError("INSERT returned no lastrowid")
    return note_id


def patch_note(note_id: int, title: Optional[str], content: Optional[str]) -> bool:
    """Partial update via COALESCE: None args leave the column unchanged.
    Returns False if the row was not found.
    """
    now = datetime.datetime.now(datetime.timezone.utc)
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE NOTE SET TITLE=COALESCE(?,TITLE), NOTE=COALESCE(?,NOTE), UPDATED_AT=? WHERE NOTE_SK=?",
            (title, content, now, note_id),
        )
        return cur.rowcount > 0


def delete_note(note_id: int) -> bool:
    """Hard-delete a single note row. Returns False if the row did not exist."""
    with _connect() as conn:
        cur = conn.execute("DELETE FROM NOTE WHERE NOTE_SK = ?", (note_id,))
        return cur.rowcount > 0


def get_notes(
    source_fk: int,
    project_id: Optional[int] = None,
    *,
    all_projects: bool = False,
) -> list[NoteDetails]:
    if all_projects:
        rows = _list_notes(source_fk=source_fk)
    elif project_id is None:
        rows = _list_notes(source_fk=source_fk, project_unscoped=True)
    else:
        rows = _list_notes(source_fk=source_fk, project_fk=project_id)
    return [Note.from_row(row).to_details() for row in rows]


def get_project_notes(project_id: int) -> list[NoteDetails]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM NOTE WHERE PROJECT_FK = ? ORDER BY SOURCE_FK ASC, CREATED_AT ASC",
            (project_id,),
        ).fetchall()
    return [Note.from_row(row).to_details() for row in rows]


def count_project_notes(project_id: int) -> int:
    return _count_project_notes(project_id)


def count_paper_notes(source_fk: int, project_id: Optional[int] = None) -> int:
    return _count_notes(source_fk, project_fk=project_id)


def list_all_notes() -> list[NoteDetails]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM NOTE ORDER BY CREATED_AT ASC"
        ).fetchall()
    return [Note.from_row(row).to_details() for row in rows]


def get_notes_by_paper_id(paper_id: int) -> list[NoteDetails]:
    rows = _list_notes(paper_id_fk=paper_id)
    return [Note.from_row(row).to_details() for row in rows]


def note_counts_by_paper_for_project(project_id: int) -> dict[int, int]:
    """
    Return note counts keyed by SOURCE_FK for each paper in the project.
    Papers with no notes appear with count 0. Missing project_id yields empty dict.
    """
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT pp.SOURCE_FK AS source_fk, COALESCE(n.cnt, 0) AS note_count
            FROM PROJECT_TO_PAPER pp
            JOIN PAPER_ROOTS r ON r.SOURCE_FK = pp.SOURCE_FK
            LEFT JOIN (
                SELECT SOURCE_FK, COUNT(*) AS cnt
                FROM NOTE
                WHERE PROJECT_FK = ?
                GROUP BY SOURCE_FK
            ) AS n ON n.SOURCE_FK = pp.SOURCE_FK
            WHERE pp.PROJECT_FK = ? AND r.STATUS = 'active'
            ORDER BY pp.PROJECT_TO_PAPER_FK
            """,
            (project_id, project_id),
        ).fetchall()
    return {int(row["source_fk"]): int(row["note_count"]) for row in rows}
