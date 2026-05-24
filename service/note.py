from __future__ import annotations

from dataclasses import dataclass

from service.models.note import NoteDetails
from storage.notes import (
    get_note as _get_note,
    get_notes as _get_notes,
    get_notes_by_paper_id as _get_notes_by_paper_id,
    get_project_notes as _get_project_notes,
    list_all_notes as _list_all_notes,
    count_paper_notes as _count_paper_notes,
    count_project_notes as _count_project_notes,
    ensure_notes_db as _ensure_notes_db,
    create_note as _create_note,
    patch_note as _patch_note,
    delete_note as _delete_note,
)


# Service-layer dataclasses mirror storage FK field names (e.g. source_fk) where the name
# is already idiomatic. The exception is paper_id (not paper_id_fk) because PAPER.PAPER_ID
# and the FK referencing it have different names in the schema; using paper_id here matches
# the logical concept rather than the FK column name.

@dataclass
class Note:
    note_id: int | None = None  # NOTE_SK — PK for get/delete operations


@dataclass
class Notes:
    source_fk:    int | None = None
    paper_id:     int | None = None
    project_fk:   int | None = None
    all_projects: bool = False


@dataclass
class NoteIn:
    source_fk:  int
    title:       str
    content:     str
    paper_id:    int | None = None
    project_fk:  int | None = None


@dataclass
class NoteUpdateIn:
    note_id: int
    title:   str | None = None
    content: str | None = None

    def __post_init__(self) -> None:
        if self.title is None and self.content is None:
            raise ValueError("at least one of title or content must be provided")


# ---------------------------------------------------------------------------
# Master functions
# ---------------------------------------------------------------------------

def get(note: Note) -> NoteDetails | None:
    """Fetch a single note by note_id. Returns None if not found or if note_id is not set."""
    if note.note_id is None:
        return None
    return _get_note(note.note_id)


def list_all() -> list[NoteDetails]:
    """Return every note in the database, ordered by creation time."""
    return _list_all_notes()


def get_many(notes: Notes) -> list[NoteDetails]:
    """Fetch notes by the given filter. Valid combinations:
    source_fk (+ optional project_fk / all_projects), paper_id alone, or project_fk alone.
    Raises ValueError if no key is set or if paper_id is combined with source_fk/project_fk.
    Use list_all() to fetch every note without a filter.
    """
    if notes.paper_id is not None and (notes.source_fk is not None or notes.project_fk is not None):
        raise ValueError("paper_id cannot be combined with source_fk or project_fk")
    if notes.all_projects and notes.project_fk is not None:
        raise ValueError("all_projects=True cannot be combined with a specific project_fk")
    if notes.all_projects and notes.paper_id is not None:
        raise ValueError("all_projects=True cannot be combined with paper_id")
    if notes.source_fk is not None:
        return _get_notes(
            notes.source_fk,
            project_id   = notes.project_fk,
            all_projects = notes.all_projects,
        )
    elif notes.paper_id is not None:
        return _get_notes_by_paper_id(notes.paper_id)
    elif notes.project_fk is not None:
        return _get_project_notes(notes.project_fk)
    raise ValueError("at least one filter field must be set on Notes")


def create(note: NoteIn) -> int:
    """Insert a new note. Returns NOTE_SK."""
    return _create_note(
        source_fk=note.source_fk,
        paper_id_fk=note.paper_id,
        project_id=note.project_fk,
        title=note.title,
        content=note.content,
    )


def delete(note: Note) -> bool:
    """Delete a note by note_id. Returns False if not found or note_id is not set."""
    if note.note_id is None:
        return False
    return _delete_note(note.note_id)


def update(note: NoteUpdateIn) -> bool:
    """Partial update. Returns False if not found."""
    return _patch_note(note.note_id, note.title, note.content)


# ---------------------------------------------------------------------------
# Low-level reads
# ---------------------------------------------------------------------------

def count_paper_notes(source_fk: int, project_id: int | None = None) -> int:
    return _count_paper_notes(source_fk, project_id)


def count_project_notes(project_id: int) -> int:
    return _count_project_notes(project_id)


def ensure_notes_db() -> None:
    _ensure_notes_db()
