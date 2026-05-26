"""Tests for linxiv_cli — headless CLI for linXiv.

Strategy:
  - Call linxiv_cli.main(argv) directly (no subprocess) so the tmp_db fixture
    applies and real tracebacks are visible.
  - Sources are mocked via monkeypatch on linxiv_cli._SOURCES so no network
    calls are made.
  - capsys captures stdout/stderr; error paths assert SystemExit code != 0 and
    that stderr contains a JSON {"error": ...} object.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

import linxiv_cli
from linxiv_cli import main
from sources.base import PaperMetadata
import service.paper as svc_paper


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ARXIV_ID = "arxiv:2204.12985"
OLD_ARXIV_ID = "hep-th/9901001"


class _MockSource:
    def __init__(self, results=(), fetch_result=None, error=None):
        self._results = list(results)
        self._fetch = fetch_result
        self._error = error

    def search(self, query, max_results):
        if self._error:
            raise self._error
        return self._results[:max_results]

    def fetch_by_id(self, source_id):
        if self._error:
            raise self._error
        if self._fetch is None:
            raise RuntimeError(f"No paper: {source_id}")
        return self._fetch


def _make_meta(source_id=ARXIV_ID, title="Attention Is All You Need", source="arxiv"):
    return PaperMetadata(
        source_id=source_id,
        version=1,
        title=title,
        authors=["Vaswani et al."],
        published=date(2017, 6, 12),
        updated=None,
        summary="A test abstract.",
        source=source,
    )


def _mock_sources(monkeypatch, results=(), fetch=None, error=None):
    src = _MockSource(results, fetch, error)
    monkeypatch.setattr(linxiv_cli, "_SOURCES", {
        "arxiv":    lambda: src,
        "openalex": lambda: src,
        "crossref": lambda: src,
    })
    return src


def _seed(source_id=ARXIV_ID, title="Test Paper", source="arxiv"):
    meta = _make_meta(source_id=source_id, title=title, source=source)
    svc_paper.save_paper_metadata(meta, None)
    return source_id


def _last_err_json(err: str) -> dict:
    for line in reversed(err.strip().splitlines()):
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    raise AssertionError(f"No JSON found in stderr:\n{err!r}")


def _stdout_json(capsys, argv):
    """Clear buffer, run main, return parsed stdout JSON."""
    capsys.readouterr()
    main(argv)
    return json.loads(capsys.readouterr().out)


def _exit_err(capsys, argv):
    """Run main, expect SystemExit != 0, return parsed stderr JSON error."""
    capsys.readouterr()
    with pytest.raises(SystemExit) as exc:
        main(argv)
    assert exc.value.code != 0
    return _last_err_json(capsys.readouterr().err)


# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------

class TestArgValidation:
    def test_valid_new_style_id_passes(self, monkeypatch):
        _mock_sources(monkeypatch, fetch=_make_meta())
        main(["fetch", "2204.12985"])  # must not raise

    def test_valid_versioned_id_passes(self, monkeypatch):
        _mock_sources(monkeypatch, fetch=_make_meta())
        main(["fetch", "2204.12985v2"])

    def test_valid_old_style_id_passes(self, monkeypatch):
        _mock_sources(monkeypatch, fetch=_make_meta(source_id=f"arxiv:{OLD_ARXIV_ID}"))
        main(["fetch", OLD_ARXIV_ID])

    def test_invalid_id_exits_nonzero_with_error_json(self, monkeypatch, capsys):
        _mock_sources(monkeypatch)
        err = _exit_err(capsys, ["fetch", "not-an-id"])
        assert "error" in err

    def test_invalid_id_never_reaches_network(self, monkeypatch):
        calls = []

        class _Spy:
            def search(self, *a, **kw): ...
            def fetch_by_id(self, source_id):
                calls.append(source_id)
                raise AssertionError("should not be called")

        monkeypatch.setattr(linxiv_cli, "_SOURCES", {"arxiv": lambda: _Spy()})
        with pytest.raises(SystemExit):
            main(["fetch", "not-an-id"])
        assert calls == []


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------

class TestSearchCommand:
    def test_returns_json_list(self, monkeypatch, capsys):
        _mock_sources(monkeypatch, results=[_make_meta()])
        data = _stdout_json(capsys, ["search", "attention"])
        assert isinstance(data, list)
        assert len(data) == 1
        assert data[0]["title"] == "Attention Is All You Need"

    def test_max_forwarded_to_source(self, monkeypatch, capsys):
        results = [_make_meta(source_id=f"arxiv:2204.{10000 + i}") for i in range(20)]
        _mock_sources(monkeypatch, results=results)
        data = _stdout_json(capsys, ["search", "q", "--max", "5"])
        assert len(data) == 5

    def test_source_openalex_routes_correctly(self, monkeypatch, capsys):
        _mock_sources(monkeypatch, results=[_make_meta(source_id="openalex:W123", source="openalex")])
        data = _stdout_json(capsys, ["search", "q", "--source", "openalex"])
        assert isinstance(data, list)

    def test_network_error_exits_nonzero_with_error_json(self, monkeypatch, capsys):
        _mock_sources(monkeypatch, error=RuntimeError("network failure"))
        err = _exit_err(capsys, ["search", "attention"])
        assert "error" in err


# ---------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------

class TestFetchCommand:
    def test_arxiv_renders_markdown_template(self, monkeypatch, capsys):
        _mock_sources(monkeypatch, fetch=_make_meta())
        main(["fetch", "2204.12985"])
        out = capsys.readouterr().out
        assert "Attention Is All You Need" in out
        assert ARXIV_ID in out

    def test_arxiv_fetch_persists_paper_to_db(self, monkeypatch):
        _mock_sources(monkeypatch, fetch=_make_meta())
        main(["fetch", "2204.12985"])
        assert svc_paper.get(svc_paper.Paper(source_id=ARXIV_ID)) 

    def test_non_arxiv_source_emits_json(self, monkeypatch, capsys):
        _mock_sources(monkeypatch, fetch=_make_meta(source_id="openalex:W9999", source="openalex"))
        main(["fetch", "W9999", "--source", "openalex"])
        data = json.loads(capsys.readouterr().out)
        assert data["source_id"] == "openalex:W9999"

    def test_network_error_exits_nonzero(self, monkeypatch, capsys):
        _mock_sources(monkeypatch, error=ConnectionError("timeout"))
        err = _exit_err(capsys, ["fetch", "2204.12985"])
        assert "error" in err


# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------

class TestListCommand:
    def test_empty_db_returns_empty_list(self, capsys):
        data = _stdout_json(capsys, ["list"])
        assert data == []

    def test_seeded_paper_appears_in_list(self, capsys):
        _seed()
        data = _stdout_json(capsys, ["list"])
        assert any(p.get("source_id") == ARXIV_ID for p in data)

    def test_limit_restricts_results(self, capsys):
        for i in range(5):
            _seed(source_id=f"arxiv:2204.1000{i}", title=f"Paper {i}")
        data = _stdout_json(capsys, ["list", "--limit", "2"])
        assert len(data) == 2

    def test_offset_skips_results(self, capsys):
        for i in range(4):
            _seed(source_id=f"arxiv:2204.2000{i}", title=f"Paper {i}")
        all_data = _stdout_json(capsys, ["list"])
        offset_data = _stdout_json(capsys, ["list", "--offset", "2"])
        assert len(offset_data) == len(all_data) - 2

    def test_category_filter_excludes_non_matching(self, capsys):
        _seed()  # category is None
        data = _stdout_json(capsys, ["list", "--category", "cs.AI"])
        assert data == []


# ---------------------------------------------------------------------------
# paper get / delete / versions
# ---------------------------------------------------------------------------

class TestPaperGetCommand:
    def test_get_existing_paper(self, capsys):
        _seed()
        data = _stdout_json(capsys, ["paper", "get", ARXIV_ID])
        assert data["source_id"] == ARXIV_ID
        assert data["title"] == "Test Paper"

    def test_get_missing_paper_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["paper", "get", "2000.00001"])
        assert "error" in err


class TestPaperDeleteCommand:
    def test_delete_existing_paper(self, capsys):
        _seed()
        data = _stdout_json(capsys, ["paper", "delete", ARXIV_ID])
        assert data["deleted"] == ARXIV_ID
        assert svc_paper.get(svc_paper.Paper(source_id=ARXIV_ID)) is None

    def test_delete_missing_paper_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["paper", "delete", "2000.00001"])
        assert "error" in err


class TestPaperVersionsCommand:
    def test_versions_returns_source_id_and_latest(self, capsys):
        _seed()
        data = _stdout_json(capsys, ["paper", "versions", ARXIV_ID])
        assert data["source_id"] == ARXIV_ID
        assert data["latest_version"] == 1

    def test_versions_missing_paper_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["paper", "versions", "2000.00001"])
        assert "error" in err


# ---------------------------------------------------------------------------
# tag
# ---------------------------------------------------------------------------

class TestTagCommands:
    def test_create_tag(self, capsys):
        data = _stdout_json(capsys, ["tag", "create", "ml"])
        assert data["label"] == "ml"
        assert data["tag_id"] 

    def test_add_tags_to_paper(self, capsys):
        _seed()
        data = _stdout_json(capsys, ["tag", "add", ARXIV_ID, "ml", "nlp"])
        assert "ml" in data["tags"]
        assert "nlp" in data["tags"]

    def test_add_tags_is_idempotent(self, capsys):
        _seed()
        main(["tag", "add", ARXIV_ID, "ml"])
        data = _stdout_json(capsys, ["tag", "add", ARXIV_ID, "ml"])
        assert data["tags"].count("ml") == 1

    def test_remove_tags_from_paper(self, capsys):
        _seed()
        main(["tag", "add", ARXIV_ID, "ml", "nlp"])
        data = _stdout_json(capsys, ["tag", "remove", ARXIV_ID, "ml"])
        assert "ml" not in data["tags"]
        assert "nlp" in data["tags"]

    def test_list_tags_on_paper(self, capsys):
        _seed()
        main(["tag", "add", ARXIV_ID, "robotics"])
        data = _stdout_json(capsys, ["tag", "list", ARXIV_ID])
        assert "robotics" in data["tags"]

    def test_list_all_tags(self, capsys):
        _seed()
        main(["tag", "add", ARXIV_ID, "cv"])
        data = _stdout_json(capsys, ["tag", "list-all"])
        assert "cv" in data

    def test_delete_tag(self, capsys):
        tag_data = _stdout_json(capsys, ["tag", "create", "temp"])
        result = _stdout_json(capsys, ["tag", "delete", str(tag_data["tag_id"])])
        assert result["deleted_tag_id"] == tag_data["tag_id"]

    def test_add_tag_to_missing_paper_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["tag", "add", "2000.00001", "ml"])
        assert "error" in err


# ---------------------------------------------------------------------------
# project list / get / create / update / delete
# ---------------------------------------------------------------------------

class TestProjectListCommand:
    def test_empty_list(self, capsys):
        assert _stdout_json(capsys, ["project", "list"]) == []

    def test_lists_active_projects(self, capsys):
        main(["project", "create", "My Project"])
        data = _stdout_json(capsys, ["project", "list"])
        assert any(p["name"] == "My Project" for p in data)

    def test_deleted_projects_excluded_by_default(self, capsys):
        create = _stdout_json(capsys, ["project", "create", "ToDelete"])
        main(["project", "delete", str(create["id"])])
        data = _stdout_json(capsys, ["project", "list"])
        assert not any(p["name"] == "ToDelete" for p in data)

    def test_status_filter_shows_deleted(self, capsys):
        create = _stdout_json(capsys, ["project", "create", "ToDelete2"])
        main(["project", "delete", str(create["id"])])
        data = _stdout_json(capsys, ["project", "list", "--status", "deleted"])
        assert any(p["name"] == "ToDelete2" for p in data)


class TestProjectGetCommand:
    def test_get_existing_project(self, capsys):
        create = _stdout_json(capsys, ["project", "create", "Research"])
        data = _stdout_json(capsys, ["project", "get", str(create["id"])])
        assert data["name"] == "Research"

    def test_get_missing_project_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["project", "get", "9999"])
        assert "error" in err


class TestProjectCreateCommand:
    def test_create_returns_id_name_status(self, capsys):
        data = _stdout_json(capsys, ["project", "create", "My Proj"])
        assert data["name"] == "My Proj"
        assert data["id"] 
        assert data["status"] == "active"

    def test_create_with_description(self, capsys):
        create = _stdout_json(capsys, ["project", "create", "Proj", "--description", "About"])
        proj = _stdout_json(capsys, ["project", "get", str(create["id"])])
        assert proj["description"] == "About"


class TestProjectUpdateCommand:
    def _make(self, capsys):
        return _stdout_json(capsys, ["project", "create", "Orig", "--description", "Orig desc"])

    def test_update_name_preserves_description(self, capsys):
        create = self._make(capsys)
        data = _stdout_json(capsys, ["project", "update", str(create["id"]), "--name", "New Name"])
        assert data["name"] == "New Name"
        assert data["description"] == "Orig desc"

    def test_update_description_preserves_name(self, capsys):
        create = self._make(capsys)
        data = _stdout_json(capsys, ["project", "update", str(create["id"]), "--description", "New desc"])
        assert data["name"] == "Orig"
        assert data["description"] == "New desc"

    def test_update_missing_project_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["project", "update", "9999", "--name", "X"])
        assert "error" in err


class TestProjectDeleteCommand:
    def test_delete_project(self, capsys):
        create = _stdout_json(capsys, ["project", "create", "Doomed"])
        result = _stdout_json(capsys, ["project", "delete", str(create["id"])])
        assert result["deleted_project_id"] == create["id"]

    def test_delete_missing_project_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["project", "delete", "9999"])
        assert "error" in err


# ---------------------------------------------------------------------------
# project add-paper / remove-paper
# ---------------------------------------------------------------------------

class TestProjectPaperManagement:
    def _setup(self, capsys):
        _seed()
        return _stdout_json(capsys, ["project", "create", "P1"])["id"]

    def test_add_paper_to_project(self, capsys):
        proj_id = self._setup(capsys)
        result = _stdout_json(capsys, ["project", "add-paper", str(proj_id), ARXIV_ID])
        assert result["project_id"] == proj_id
        assert result["source_id"] == ARXIV_ID

    def test_add_paper_is_idempotent(self, capsys):
        proj_id = self._setup(capsys)
        main(["project", "add-paper", str(proj_id), ARXIV_ID])
        _stdout_json(capsys, ["project", "add-paper", str(proj_id), ARXIV_ID])
        proj = _stdout_json(capsys, ["project", "get", str(proj_id)])
        assert len(proj["source_fks"]) == 1

    def test_remove_paper_from_project(self, capsys):
        proj_id = self._setup(capsys)
        main(["project", "add-paper", str(proj_id), ARXIV_ID])
        result = _stdout_json(capsys, ["project", "remove-paper", str(proj_id), ARXIV_ID])
        assert result["removed"] is True

    def test_add_paper_missing_project_exits_nonzero(self, capsys):
        _seed()
        err = _exit_err(capsys, ["project", "add-paper", "9999", ARXIV_ID])
        assert "error" in err

    def test_add_paper_missing_paper_exits_nonzero(self, capsys):
        create = _stdout_json(capsys, ["project", "create", "P2"])
        err = _exit_err(capsys, ["project", "add-paper", str(create["id"]), "2000.00001"])
        assert "error" in err


# ---------------------------------------------------------------------------
# note create / get / list / delete
# ---------------------------------------------------------------------------

class TestNoteCommands:
    def test_create_note(self, capsys):
        _seed()
        data = _stdout_json(capsys, ["note", "create", ARXIV_ID, "body text", "--title", "My Title"])
        assert data["id"] 
        assert data["title"] == "My Title"

    def test_create_note_missing_paper_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["note", "create", "2000.00001", "body"])
        assert "error" in err

    def test_get_note_by_id(self, capsys):
        _seed()
        create = _stdout_json(capsys, ["note", "create", ARXIV_ID, "body", "--title", "T"])
        data = _stdout_json(capsys, ["note", "get", str(create["id"])])
        assert data["title"] == "T"
        assert data["content"] == "body"

    def test_get_missing_note_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["note", "get", "9999"])
        assert "error" in err

    def test_list_all_notes(self, capsys):
        _seed()
        main(["note", "create", ARXIV_ID, "note 1"])
        main(["note", "create", ARXIV_ID, "note 2"])
        data = _stdout_json(capsys, ["note", "list"])
        assert len(data) >= 2

    def test_list_notes_filtered_by_paper(self, capsys):
        _seed()
        _seed(source_id="arxiv:2204.99999", title="Other")
        main(["note", "create", ARXIV_ID, "for first"])
        main(["note", "create", "arxiv:2204.99999", "for second"])
        data = _stdout_json(capsys, ["note", "list", "--paper-id", ARXIV_ID])
        assert len(data) == 1

    def test_list_notes_filtered_by_project(self, capsys):
        _seed()
        proj = _stdout_json(capsys, ["project", "create", "NoteProject"])
        proj_id = proj["id"]
        main(["note", "create", ARXIV_ID, "proj note", "--project-id", str(proj_id)])
        main(["note", "create", ARXIV_ID, "unscoped note"])
        data = _stdout_json(capsys, ["note", "list", "--project-id", str(proj_id)])
        assert len(data) == 1

    def test_delete_note(self, capsys):
        _seed()
        create = _stdout_json(capsys, ["note", "create", ARXIV_ID, "to delete"])
        result = _stdout_json(capsys, ["note", "delete", str(create["id"])])
        assert result["deleted_note_id"] == create["id"]

    def test_delete_missing_note_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["note", "delete", "9999"])
        assert "error" in err


# ---------------------------------------------------------------------------
# pdf path / download / storage
# ---------------------------------------------------------------------------

class TestPdfCommands:
    def test_pdf_path_returns_null_when_no_file(self, capsys):
        _seed()
        data = _stdout_json(capsys, ["pdf", "path", ARXIV_ID])
        assert data["path"] is None

    def test_pdf_path_missing_paper_exits_nonzero(self, capsys):
        err = _exit_err(capsys, ["pdf", "path", "2000.00001"])
        assert "error" in err

    def test_pdf_download_success(self, monkeypatch, capsys, tmp_path):
        _seed()
        fake_path = str(tmp_path / "paper.pdf")
        monkeypatch.setattr("service.files.download_pdf", lambda *a: fake_path)
        data = _stdout_json(capsys, ["pdf", "download", ARXIV_ID, "http://example.com/paper.pdf"])
        assert data["path"] == fake_path

    def test_pdf_download_none_result_exits_nonzero(self, monkeypatch, capsys):
        _seed()
        monkeypatch.setattr("service.files.download_pdf", lambda *a: None)
        err = _exit_err(capsys, ["pdf", "download", ARXIV_ID, "http://example.com/paper.pdf"])
        assert "error" in err

    def test_pdf_download_exception_exits_nonzero(self, monkeypatch, capsys):
        _seed()

        def _raise(*a):
            raise OSError("disk full")

        monkeypatch.setattr("service.files.download_pdf", _raise)
        err = _exit_err(capsys, ["pdf", "download", ARXIV_ID, "http://example.com/paper.pdf"])
        assert "error" in err

    def test_pdf_storage_reports_mb_and_dir(self, capsys):
        data = _stdout_json(capsys, ["pdf", "storage"])
        assert "storage_mb" in data
        assert "pdf_dir" in data
        assert isinstance(data["storage_mb"], (int, float))


# ---------------------------------------------------------------------------
# project export
# ---------------------------------------------------------------------------

class TestProjectExportCommand:
    def test_export_success_returns_path_and_project_id(self, monkeypatch, capsys, tmp_path):
        fake_out = tmp_path / "my_export.lxproj"
        fake_out.touch()
        monkeypatch.setattr(linxiv_cli.svc_ei, "export_project",
                            lambda fk, dest, include_pdfs=False: fake_out)
        create = _stdout_json(capsys, ["project", "create", "Test Project"])
        proj_id = create["id"]
        data = _stdout_json(capsys, ["project", "export", str(proj_id), str(tmp_path / "out")])
        assert data["project_id"] == proj_id
        assert data["path"] == str(fake_out)

    def test_export_service_exception_exits_nonzero_with_error_json(self, monkeypatch, capsys, tmp_path):
        def _raise(*a, **kw):
            raise ValueError("project not found")
        monkeypatch.setattr(linxiv_cli.svc_ei, "export_project", _raise)
        create = _stdout_json(capsys, ["project", "create", "P"])
        err = _exit_err(capsys, ["project", "export", str(create["id"]), str(tmp_path / "out")])
        assert err["error"] == "project not found"

    def test_export_passes_pdfs_flag_true(self, monkeypatch, capsys, tmp_path):
        calls = []
        fake_out = tmp_path / "export.lxproj"
        fake_out.touch()
        def _spy(fk, dest, include_pdfs=False):
            calls.append(include_pdfs)
            return fake_out
        monkeypatch.setattr(linxiv_cli.svc_ei, "export_project", _spy)
        create = _stdout_json(capsys, ["project", "create", "P"])
        _stdout_json(capsys, ["project", "export", str(create["id"]), str(tmp_path / "out"), "--pdfs"])
        assert calls == [True]

    def test_export_without_pdfs_flag_defaults_to_false(self, monkeypatch, capsys, tmp_path):
        calls = []
        fake_out = tmp_path / "export.lxproj"
        fake_out.touch()
        def _spy(fk, dest, include_pdfs=False):
            calls.append(include_pdfs)
            return fake_out
        monkeypatch.setattr(linxiv_cli.svc_ei, "export_project", _spy)
        create = _stdout_json(capsys, ["project", "create", "P"])
        _stdout_json(capsys, ["project", "export", str(create["id"]), str(tmp_path / "out")])
        assert calls == [False]

    def test_export_passes_dest_as_path(self, monkeypatch, capsys, tmp_path):
        received = []
        fake_out = tmp_path / "export.lxproj"
        fake_out.touch()
        def _spy(fk, dest, include_pdfs=False):
            received.append(dest)
            return fake_out
        monkeypatch.setattr(linxiv_cli.svc_ei, "export_project", _spy)
        create = _stdout_json(capsys, ["project", "create", "P"])
        dest_arg = str(tmp_path / "out")
        _stdout_json(capsys, ["project", "export", str(create["id"]), dest_arg])
        assert received == [Path(dest_arg)]

    def test_export_forwards_project_id_to_service(self, monkeypatch, capsys, tmp_path):
        received = []
        fake_out = tmp_path / "export.lxproj"
        fake_out.touch()
        def _spy(fk, dest, include_pdfs=False):
            received.append(fk)
            return fake_out
        monkeypatch.setattr(linxiv_cli.svc_ei, "export_project", _spy)
        create = _stdout_json(capsys, ["project", "create", "P"])
        proj_id = create["id"]
        _stdout_json(capsys, ["project", "export", str(proj_id), str(tmp_path / "out")])
        assert received == [proj_id]

    def test_export_error_has_tag_prefix_in_stderr(self, monkeypatch, capsys, tmp_path):
        def _raise(*a, **kw):
            raise ValueError("boom")
        monkeypatch.setattr(linxiv_cli.svc_ei, "export_project", _raise)
        create = _stdout_json(capsys, ["project", "create", "P"])
        capsys.readouterr()
        with pytest.raises(SystemExit):
            main(["project", "export", str(create["id"]), str(tmp_path / "out")])
        assert "[export]" in capsys.readouterr().err

    def test_export_error_stdout_is_empty(self, monkeypatch, capsys, tmp_path):
        def _raise(*a, **kw):
            raise ValueError("boom")
        monkeypatch.setattr(linxiv_cli.svc_ei, "export_project", _raise)
        create = _stdout_json(capsys, ["project", "create", "P"])
        capsys.readouterr()
        with pytest.raises(SystemExit):
            main(["project", "export", str(create["id"]), str(tmp_path / "out")])
        out, _ = capsys.readouterr()
        assert out == ""


# ---------------------------------------------------------------------------
# project import — preview
# ---------------------------------------------------------------------------

class TestProjectImportPreviewCommand:
    def test_preview_outputs_all_fields(self, monkeypatch, capsys, tmp_path):
        from service.export_import import ImportPreview
        fake_preview = ImportPreview(
            project_name="Imported",
            description="Desc",
            paper_count=3,
            note_count=1,
            has_pdfs=False,
            format_version=1,
        )
        monkeypatch.setattr(linxiv_cli.svc_ei, "preview_import", lambda p: fake_preview)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        data = _stdout_json(capsys, ["project", "import", str(fake_zip), "--preview"])
        assert data["project_name"] == "Imported"
        assert data["description"] == "Desc"
        assert data["paper_count"] == 3
        assert data["note_count"] == 1
        assert data["has_pdfs"] is False
        assert data["format_version"] == 1

    def test_preview_exception_exits_nonzero_with_error_json(self, monkeypatch, capsys, tmp_path):
        def _raise(p):
            raise ValueError("manifest.json missing")
        monkeypatch.setattr(linxiv_cli.svc_ei, "preview_import", _raise)
        fake_zip = tmp_path / "bad.lxproj"
        fake_zip.touch()
        err = _exit_err(capsys, ["project", "import", str(fake_zip), "--preview"])
        assert err["error"] == "manifest.json missing"

    def test_preview_passes_zip_path_as_path(self, monkeypatch, capsys, tmp_path):
        from service.export_import import ImportPreview
        received = []
        def _spy(p):
            received.append(p)
            return ImportPreview("N", "", 0, 0, False, 1)
        monkeypatch.setattr(linxiv_cli.svc_ei, "preview_import", _spy)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        _stdout_json(capsys, ["project", "import", str(fake_zip), "--preview"])
        assert received == [fake_zip]

    def test_preview_flag_does_not_call_commit_import(self, monkeypatch, capsys, tmp_path):
        from service.export_import import ImportPreview
        commit_calls = []
        monkeypatch.setattr(linxiv_cli.svc_ei, "preview_import",
                            lambda p: ImportPreview("N", "", 0, 0, False, 1))
        monkeypatch.setattr(linxiv_cli.svc_ei, "commit_import",
                            lambda *a, **kw: commit_calls.append(True) or 1)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        _stdout_json(capsys, ["project", "import", str(fake_zip), "--preview"])
        assert commit_calls == []

    def test_preview_with_on_conflict_flag_is_accepted(self, monkeypatch, capsys, tmp_path):
        from service.export_import import ImportPreview
        monkeypatch.setattr(linxiv_cli.svc_ei, "preview_import",
                            lambda p: ImportPreview("N", "", 0, 0, False, 1))
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        data = _stdout_json(capsys, ["project", "import", str(fake_zip), "--preview", "--on-conflict", "overwrite"])
        assert data["project_name"] == "N"

    def test_preview_error_has_tag_prefix_in_stderr(self, monkeypatch, capsys, tmp_path):
        def _raise(p):
            raise ValueError("bad archive")
        monkeypatch.setattr(linxiv_cli.svc_ei, "preview_import", _raise)
        fake_zip = tmp_path / "bad.lxproj"
        fake_zip.touch()
        capsys.readouterr()
        with pytest.raises(SystemExit):
            main(["project", "import", str(fake_zip), "--preview"])
        assert "[import]" in capsys.readouterr().err

    def test_preview_error_stdout_is_empty(self, monkeypatch, capsys, tmp_path):
        def _raise(p):
            raise ValueError("bad archive")
        monkeypatch.setattr(linxiv_cli.svc_ei, "preview_import", _raise)
        fake_zip = tmp_path / "bad.lxproj"
        fake_zip.touch()
        capsys.readouterr()
        with pytest.raises(SystemExit):
            main(["project", "import", str(fake_zip), "--preview"])
        out, _ = capsys.readouterr()
        assert out == ""


# ---------------------------------------------------------------------------
# project import — commit
# ---------------------------------------------------------------------------

class TestProjectImportCommitCommand:
    def test_commit_outputs_project_id(self, monkeypatch, capsys, tmp_path):
        monkeypatch.setattr(linxiv_cli.svc_ei, "commit_import",
                            lambda p, on_conflict="merge": 42)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        data = _stdout_json(capsys, ["project", "import", str(fake_zip)])
        assert data["project_id"] == 42

    def test_commit_default_on_conflict_is_merge(self, monkeypatch, capsys, tmp_path):
        calls = []
        def _spy(p, on_conflict="merge"):
            calls.append(on_conflict)
            return 1
        monkeypatch.setattr(linxiv_cli.svc_ei, "commit_import", _spy)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        _stdout_json(capsys, ["project", "import", str(fake_zip)])
        assert calls == ["merge"]

    def test_commit_on_conflict_overwrite_forwarded(self, monkeypatch, capsys, tmp_path):
        calls = []
        def _spy(p, on_conflict="merge"):
            calls.append(on_conflict)
            return 1
        monkeypatch.setattr(linxiv_cli.svc_ei, "commit_import", _spy)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        _stdout_json(capsys, ["project", "import", str(fake_zip), "--on-conflict", "overwrite"])
        assert calls == ["overwrite"]

    def test_commit_project_import_error_exits_nonzero(self, monkeypatch, capsys, tmp_path):
        def _raise(p, on_conflict="merge"):
            raise linxiv_cli.ProjectImportError("rollback happened")
        monkeypatch.setattr(linxiv_cli.svc_ei, "commit_import", _raise)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        err = _exit_err(capsys, ["project", "import", str(fake_zip)])
        assert err["error"] == "rollback happened"

    def test_commit_generic_exception_exits_nonzero(self, monkeypatch, capsys, tmp_path):
        def _raise(p, on_conflict="merge"):
            raise OSError("disk full")
        monkeypatch.setattr(linxiv_cli.svc_ei, "commit_import", _raise)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        err = _exit_err(capsys, ["project", "import", str(fake_zip)])
        assert err["error"] == "disk full"

    def test_commit_passes_zip_path_as_path(self, monkeypatch, capsys, tmp_path):
        received = []
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        def _spy(p, on_conflict="merge"):
            received.append(p)
            return 1
        monkeypatch.setattr(linxiv_cli.svc_ei, "commit_import", _spy)
        _stdout_json(capsys, ["project", "import", str(fake_zip)])
        assert received == [fake_zip]

    def test_commit_error_has_tag_prefix_in_stderr(self, monkeypatch, capsys, tmp_path):
        def _raise(p, on_conflict="merge"):
            raise OSError("boom")
        monkeypatch.setattr(linxiv_cli.svc_ei, "commit_import", _raise)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        capsys.readouterr()
        with pytest.raises(SystemExit):
            main(["project", "import", str(fake_zip)])
        assert "[import]" in capsys.readouterr().err

    def test_commit_error_stdout_is_empty(self, monkeypatch, capsys, tmp_path):
        def _raise(p, on_conflict="merge"):
            raise OSError("boom")
        monkeypatch.setattr(linxiv_cli.svc_ei, "commit_import", _raise)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        capsys.readouterr()
        with pytest.raises(SystemExit):
            main(["project", "import", str(fake_zip)])
        out, _ = capsys.readouterr()
        assert out == ""

    def test_commit_without_preview_does_not_call_preview_import(self, monkeypatch, capsys, tmp_path):
        preview_calls = []
        monkeypatch.setattr(linxiv_cli.svc_ei, "preview_import",
                            lambda p: preview_calls.append(True))
        monkeypatch.setattr(linxiv_cli.svc_ei, "commit_import",
                            lambda p, on_conflict="merge": 1)
        fake_zip = tmp_path / "archive.lxproj"
        fake_zip.touch()
        _stdout_json(capsys, ["project", "import", str(fake_zip)])
        assert preview_calls == []


# ---------------------------------------------------------------------------
# project export / import — integration round-trip
# ---------------------------------------------------------------------------

class TestProjectExportImportRoundtrip:
    def test_round_trip_creates_new_project_with_papers(self, capsys, tmp_path, monkeypatch):
        import service.export_import as ei
        pdf_dir = tmp_path / "pdfs"
        pdf_dir.mkdir(exist_ok=True)
        monkeypatch.setattr(ei, "pdf_dir", lambda: pdf_dir)

        _seed()
        proj_id = _stdout_json(capsys, ["project", "create", "Round Trip", "--description", "round-trip desc"])["id"]
        main(["project", "add-paper", str(proj_id), ARXIV_ID])

        export_data = _stdout_json(capsys, ["project", "export", str(proj_id), str(tmp_path / "rt_export")])
        assert export_data["path"].endswith(".lxproj")

        import_data = _stdout_json(capsys, ["project", "import", export_data["path"]])
        new_proj_id = import_data["project_id"]
        assert new_proj_id != proj_id

        proj_data = _stdout_json(capsys, ["project", "get", str(new_proj_id)])
        assert proj_data["name"] == "Round Trip"
        assert proj_data["description"] == "round-trip desc"
        assert len(proj_data["source_fks"]) == 1

    def test_round_trip_preview_reflects_source_project(self, capsys, tmp_path, monkeypatch):
        import service.export_import as ei
        pdf_dir = tmp_path / "pdfs"
        pdf_dir.mkdir(exist_ok=True)
        monkeypatch.setattr(ei, "pdf_dir", lambda: pdf_dir)

        _seed()
        proj_id = _stdout_json(capsys, ["project", "create", "Preview Test"])["id"]
        main(["project", "add-paper", str(proj_id), ARXIV_ID])

        export_data = _stdout_json(capsys, ["project", "export", str(proj_id), str(tmp_path / "pv_export")])
        preview = _stdout_json(capsys, ["project", "import", export_data["path"], "--preview"])

        assert preview["project_name"] == "Preview Test"
        assert preview["paper_count"] == 1
        assert preview["has_pdfs"] is False
