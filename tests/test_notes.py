"""Unit tests for storage/notes.py — Note CRUD and query functions."""

from __future__ import annotations

import pytest

from storage.projects import Project, ensure_projects_db
from storage.notes import (
    Note,
    count_paper_notes,
    count_project_notes,
    get_note,
    get_notes,
    get_project_notes,
    note_counts_by_paper_for_project,
)
from storage.projects import Project

import storage.db as _db


def _sfk(label: str) -> int:
    """Insert or get a PAPER_ROOTS row; return its SOURCE_FK integer."""
    with _db._connect() as conn:
        conn.execute("INSERT OR IGNORE INTO PAPER_ROOTS (SOURCE_ID) VALUES (?)", (label,))
        row = conn.execute("SELECT SOURCE_FK FROM PAPER_ROOTS WHERE SOURCE_ID = ?", (label,)).fetchone()
    return int(row[0])


# ---------------------------------------------------------------------------
# Note.save() — create path
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("tmp_db")
class TestNoteSaveCreate:
    def test_save_assigns_id(self):
        n = Note(source_fk=_sfk("2204.12985"))
        assert n.id is None
        n.save()
        assert isinstance(n.id, int)

    def test_save_sets_created_at(self):
        n = Note(source_fk=_sfk("2204.12985"))
        assert n.created_at is None
        n.save()
        assert n.created_at

    def test_save_sets_updated_at(self):
        n = Note(source_fk=_sfk("2204.12985"))
        n.save()
        assert n.updated_at

    def test_save_persists_fields(self):
        n = Note(source_fk=_sfk("2204.12985"), title="My Title", content="Body text")
        n.save()
        assert n.id
        fetched = get_note(n.id)
        assert fetched
        assert fetched.source_fk == _sfk("2204.12985")
        assert fetched.title == "My Title"
        assert fetched.content == "Body text"

    def test_save_persists_project_id(self):
        p = Project(name="Test Project")
        p.save()
        assert p.id
        with _db._connect() as conn:
            conn.execute("INSERT OR IGNORE INTO PROJECT (PROJECT_FK) VALUES (?)", (p.id,))
        n = Note(source_fk=_sfk("2204.12985"), project_id=p.id)
        n.save()
        assert n.id
        fetched = get_note(n.id)
        assert fetched
        assert fetched.project_id == p.id

    def test_save_null_project_id(self):
        n = Note(source_fk=_sfk("2204.12985"), project_id=None)
        n.save()
        assert n.id
        fetched = get_note(n.id)
        assert fetched
        assert fetched.project_id is None

    def test_save_empty_title_and_content(self):
        n = Note(source_fk=_sfk("2204.12985"))
        n.save()
        assert n.id
        fetched = get_note(n.id)
        assert fetched
        assert fetched.title == ""
        assert fetched.content == ""

    def test_multiple_notes_get_distinct_ids(self):
        sfk = _sfk("2204.12985")
        a = Note(source_fk=sfk)
        b = Note(source_fk=sfk)
        a.save()
        b.save()
        assert a.id != b.id


# ---------------------------------------------------------------------------
# Note.save() — update path
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("tmp_db")
class TestNoteSaveUpdate:
    def test_resave_does_not_create_new_row(self):
        n = Note(source_fk=_sfk("2204.12985"), title="Original")
        n.save()
        original_id = n.id
        n.title = "Updated"
        n.save()
        assert n.id == original_id

    def test_resave_updates_title(self):
        n = Note(source_fk=_sfk("2204.12985"), title="Before")
        n.save()
        n.title = "After"
        n.save()
        assert n.id
        result = get_note(n.id)
        assert result
        assert result.title == "After"

    def test_resave_updates_content(self):
        n = Note(source_fk=_sfk("2204.12985"), content="v1")
        n.save()
        n.content = "v2"
        n.save()
        assert n.id
        result = get_note(n.id)
        assert result
        assert result.content == "v2"

    def test_resave_updates_updated_at(self):
        import time
        n = Note(source_fk=_sfk("2204.12985"))
        n.save()
        first_updated = n.updated_at
        assert first_updated
        time.sleep(0.01)
        n.save()
        assert n.updated_at
        assert n.updated_at >= first_updated

    def test_resave_preserves_created_at(self):
        n = Note(source_fk=_sfk("2204.12985"))
        n.save()
        created = n.created_at
        n.title = "changed"
        n.save()
        assert n.created_at == created


# ---------------------------------------------------------------------------
# Note.delete()
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("tmp_db")
class TestNoteDelete:
    def test_delete_removes_from_db(self):
        n = Note(source_fk=_sfk("2204.12985"))
        n.save()
        assert n.id
        nid = n.id
        n.delete()
        assert get_note(nid) is None

    def test_delete_clears_id(self):
        n = Note(source_fk=_sfk("2204.12985"))
        n.save()
        n.delete()
        assert n.id is None

    def test_delete_unsaved_note_is_noop(self):
        n = Note(source_fk=_sfk("2204.12985"))
        n.delete()  # should not raise
        assert n.id is None

    def test_delete_only_removes_target(self):
        sfk = _sfk("2204.12985")
        a = Note(source_fk=sfk, title="A")
        b = Note(source_fk=sfk, title="B")
        a.save()
        b.save()
        a.delete()
        assert b.id
        assert get_note(b.id)


# ---------------------------------------------------------------------------
# get_note
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("tmp_db")
class TestGetNote:
    def test_returns_none_for_missing_id(self):
        assert get_note(9999) is None

    def test_returns_note_for_valid_id(self):
        n = Note(source_fk=_sfk("2204.12985"), title="T")
        n.save()
        assert n.id
        fetched = get_note(n.id)
        assert fetched
        assert fetched.note_id == n.id
        assert fetched.title == "T"


# ---------------------------------------------------------------------------
# get_notes
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("note_projects")
class TestGetNotes:
    def test_empty_db_returns_empty_list(self):
        assert get_notes(_sfk("2204.12985")) == []

    def test_returns_notes_for_paper(self):
        sfk = _sfk("2204.12985")
        Note(source_fk=sfk, title="A").save()
        Note(source_fk=sfk, title="B").save()
        assert len(get_notes(sfk)) == 2

    def test_isolates_by_paper_id(self):
        sfk_a = _sfk("AAAA")
        sfk_b = _sfk("BBBB")
        Note(source_fk=sfk_a, title="A").save()
        Note(source_fk=sfk_b, title="B").save()
        results = get_notes(sfk_a)
        assert len(results) == 1
        assert results[0].title == "A"

    def test_default_returns_only_null_project_notes(self):
        sfk = _sfk("X")
        Note(source_fk=sfk, project_id=None, title="global").save()
        Note(source_fk=sfk, project_id=1, title="project").save()
        results = get_notes(sfk)  # project_id=None, all_projects=False
        assert len(results) == 1
        assert results[0].title == "global"

    def test_project_id_filter(self):
        sfk = _sfk("X")
        Note(source_fk=sfk, project_id=None, title="global").save()
        Note(source_fk=sfk, project_id=7, title="p7").save()
        Note(source_fk=sfk, project_id=8, title="p8").save()
        results = get_notes(sfk, project_id=7)
        assert len(results) == 1
        assert results[0].title == "p7"

    def test_all_projects_returns_everything(self):
        sfk = _sfk("X")
        Note(source_fk=sfk, project_id=None).save()
        Note(source_fk=sfk, project_id=1).save()
        Note(source_fk=sfk, project_id=2).save()
        assert len(get_notes(sfk, all_projects=True)) == 3

    def test_ordered_by_created_at_asc(self):
        import time
        sfk = _sfk("X")
        for title in ("first", "second", "third"):
            Note(source_fk=sfk, title=title).save()
            time.sleep(0.01)
        results = get_notes(sfk, all_projects=True)
        assert [n.title for n in results] == ["first", "second", "third"]


# ---------------------------------------------------------------------------
# get_project_notes
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("note_projects")
class TestGetProjectNotes:
    def test_empty_returns_empty_list(self):
        assert get_project_notes(99) == []

    def test_returns_notes_for_project(self):
        Note(source_fk=_sfk("A"), project_id=1).save()
        Note(source_fk=_sfk("B"), project_id=1).save()
        Note(source_fk=_sfk("C"), project_id=2).save()
        results = get_project_notes(1)
        assert len(results) == 2
        assert all(n.project_id == 1 for n in results)

    def test_ordered_by_source_fk_then_created_at(self):
        import time
        # Insert "A" first so it gets a smaller SOURCE_FK than "Z"
        sfk_a = _sfk("A")
        sfk_z = _sfk("Z")
        Note(source_fk=sfk_z, project_id=5, title="z1").save()
        time.sleep(0.01)
        Note(source_fk=sfk_a, project_id=5, title="a1").save()
        results = get_project_notes(5)
        assert results[0].source_fk == sfk_a
        assert results[1].source_fk == sfk_z


# ---------------------------------------------------------------------------
# count_project_notes
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("note_projects")
class TestCountProjectNotes:
    def test_zero_for_empty(self):
        assert count_project_notes(1) == 0

    def test_counts_only_target_project(self):
        Note(source_fk=_sfk("A"), project_id=1).save()
        Note(source_fk=_sfk("B"), project_id=1).save()
        Note(source_fk=_sfk("C"), project_id=2).save()
        assert count_project_notes(1) == 2
        assert count_project_notes(2) == 1

    def test_reflects_deletions(self):
        n = Note(source_fk=_sfk("A"), project_id=3)
        n.save()
        assert count_project_notes(3) == 1
        n.delete()
        assert count_project_notes(3) == 0


# ---------------------------------------------------------------------------
# count_paper_notes
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("note_projects")
class TestCountPaperNotes:
    def test_zero_for_empty(self):
        assert count_paper_notes(_sfk("2204.12985")) == 0

    def test_counts_all_notes_for_paper(self):
        sfk = _sfk("X")
        Note(source_fk=sfk, project_id=None).save()
        Note(source_fk=sfk, project_id=1).save()
        Note(source_fk=sfk, project_id=2).save()
        assert count_paper_notes(sfk) == 3

    def test_counts_only_target_project(self):
        sfk = _sfk("X")
        Note(source_fk=sfk, project_id=1).save()
        Note(source_fk=sfk, project_id=2).save()
        assert count_paper_notes(sfk, project_id=1) == 1

    def test_isolates_by_paper_id(self):
        Note(source_fk=_sfk("AAA")).save()
        Note(source_fk=_sfk("BBB")).save()
        assert count_paper_notes(_sfk("AAA")) == 1

    def test_reflects_deletions(self):
        sfk = _sfk("Y")
        n = Note(source_fk=sfk)
        n.save()
        assert count_paper_notes(sfk) == 1
        n.delete()
        assert count_paper_notes(sfk) == 0


# ---------------------------------------------------------------------------
# note_counts_by_paper_for_project
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("tmp_db")
class TestNoteCountsByPaperForProject:
    def test_unknown_project_returns_empty(self):
        ensure_projects_db()
        assert note_counts_by_paper_for_project(99999) == {}

    def test_empty_paper_ids_returns_empty(self):
        ensure_projects_db()
        proj = Project(name="Empty", source_fks=[])
        proj.save()
        assert proj.id
        assert note_counts_by_paper_for_project(proj.id) == {}

    def test_counts_include_zeros_and_order(self):
        ensure_projects_db()
        sfk_a = _sfk("a")
        sfk_b = _sfk("b")
        sfk_c = _sfk("c")
        proj = Project(name="P", source_fks=[sfk_a, sfk_b, sfk_c])
        proj.save()
        assert proj.id
        # Insert a PROJECT row so the FK constraint in NOTE is satisfied
        with _db._connect() as conn:
            conn.execute("INSERT OR IGNORE INTO PROJECT (PROJECT_FK) VALUES (?)", (proj.id,))
        Note(source_fk=sfk_a, project_id=proj.id, title="n1").save()
        Note(source_fk=sfk_a, project_id=proj.id, title="n2").save()
        Note(source_fk=sfk_c, project_id=proj.id, title="n3").save()
        counts = note_counts_by_paper_for_project(proj.id)
        assert list(counts.keys()) == [sfk_a, sfk_b, sfk_c]
        assert counts == {sfk_a: 2, sfk_b: 0, sfk_c: 1}
