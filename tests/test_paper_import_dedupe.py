"""Tests for the adopt-existing-paper-root dedupe path in service.paper.import_pdf.

The dedupe path activates when PDF metadata enrichment matches an upstream
identity (``arxiv:<id>`` or ``doi:<doi>``) that already exists in PAPER_ROOTS.
Instead of creating a new ``local:<sha>`` root, the import adopts the
pre-existing identity.

These tests mock the resolver (``sources.pdf_metadata.resolve_pdf_metadata``)
so they don't depend on real PDFs — the focus is the service-layer
adopt/rollback behavior, not metadata extraction.
"""
from __future__ import annotations

import datetime
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import storage.db as db
import service.paper as paper_svc
from service.paper import pdf_on_disk_name
from sources.base import PaperMetadata


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _seed_paper(source_id: str, version: int = 1, title: str = "Seeded Paper") -> None:
    """Insert a PAPER_ROOTS + PAPER row directly via the metadata path so the
    source_id is stored verbatim (matching what import_pdf with adopt produces).
    """
    meta = PaperMetadata(
        source_id=source_id,
        version=version,
        title=title,
        authors=["Alice"],
        published=datetime.date(2024, 1, 15),
        summary="",
        source="arxiv" if source_id.startswith("arxiv:") else "crossref",
    )
    db.save_paper_metadata(meta)


def _mock_resolver(meta: PaperMetadata, external: tuple[str, int] | None):
    """Return a patch context that makes resolve_pdf_metadata return (meta, external)."""
    return patch(
        "service.paper.resolve_pdf_metadata",
        return_value=(meta, external),
    )


# ---------------------------------------------------------------------------
# Adopt against an existing arxiv root
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("tmp_db")
class TestAdoptExistingArxivRoot:
    def test_same_version_dedupes_to_one_root(self):
        _seed_paper("arxiv:2204.12985", version=1)

        local_meta = PaperMetadata(
            source_id="local:abc123",
            version=1,
            title="Same Paper",
            authors=["Alice"],
            published=datetime.date(2024, 1, 15),
            summary="",
            source="pdf",
        )
        with _mock_resolver(local_meta, ("arxiv:2204.12985", 1)):
            paper_svc.import_pdf(b"fake pdf bytes")

        # The arxiv root remains the single root; no local:* root was created.
        assert db.get_paper_root("arxiv:2204.12985") is not None
        assert db.get_paper_root("local:abc123") is None
        # The arxiv v1 row was preserved and now points to the imported PDF.
        row = db.get_paper("arxiv:2204.12985", 1)
        assert row is not None
        assert row["pdf_path"] is not None

    def test_new_version_inserted_under_existing_root(self):
        _seed_paper("arxiv:2204.12985", version=1)

        local_meta = PaperMetadata(
            source_id="local:def456",
            version=1,
            title="Newer Revision",
            authors=["Alice"],
            published=datetime.date(2025, 6, 1),
            summary="",
            source="pdf",
        )
        # Resolver claims this PDF is arxiv:2204.12985 v2.
        with _mock_resolver(local_meta, ("arxiv:2204.12985", 2)):
            paper_svc.import_pdf(b"fake v2 bytes")

        # Same root, two versions under it.
        assert db.get_paper_root("arxiv:2204.12985") is not None
        assert db.get_paper_root("local:def456") is None
        versions = sorted(r["version"] for r in db.get_all_versions("arxiv:2204.12985"))
        assert versions == [1, 2]
        # v2 carries the new PDF; v1 untouched.
        v2 = db.get_paper("arxiv:2204.12985", 2)
        assert v2 is not None
        assert v2["pdf_path"] is not None


# ---------------------------------------------------------------------------
# Adopt against an existing DOI root (mirror of arxiv path)
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("tmp_db")
class TestAdoptExistingDoiRoot:
    def test_dedupes_to_existing_doi_root(self):
        _seed_paper("doi:10.1234/journal.xyz", version=1)

        local_meta = PaperMetadata(
            source_id="local:ghi789",
            version=1,
            title="DOI-only paper",
            authors=["Bob"],
            published=datetime.date(2024, 3, 1),
            summary="",
            source="pdf",
        )
        with _mock_resolver(local_meta, ("doi:10.1234/journal.xyz", 1)):
            paper_svc.import_pdf(b"fake doi pdf")

        assert db.get_paper_root("doi:10.1234/journal.xyz") is not None
        assert db.get_paper_root("local:ghi789") is None
        # Mirror the arxiv-path assertions: single version, PDF attached.
        versions = sorted(r["version"] for r in db.get_all_versions("doi:10.1234/journal.xyz"))
        assert versions == [1]
        row = db.get_paper("doi:10.1234/journal.xyz", 1)
        assert row is not None
        assert row["pdf_path"] is not None


# ---------------------------------------------------------------------------
# No enrichment → fall back to local:<sha> root
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("tmp_db")
class TestNoEnrichmentFallsBackToLocal:
    def test_creates_local_root_when_external_is_none(self):
        local_meta = PaperMetadata(
            source_id="local:jkl012",
            version=1,
            title="Unrecognized Paper",
            authors=[],
            published=datetime.date(2024, 5, 5),
            summary="",
            source="pdf",
        )
        # external=None means resolver couldn't enrich.
        with _mock_resolver(local_meta, None):
            paper_svc.import_pdf(b"unknown pdf bytes")

        assert db.get_paper_root("local:jkl012") is not None
        # Tighten: the version row was actually created and the PDF wired up.
        row = db.get_paper("local:jkl012", 1)
        assert row is not None
        assert row["pdf_path"] is not None
        assert row["has_pdf"] == 1


# ---------------------------------------------------------------------------
# Rollback safety: adopting a pre-existing root must not hard-delete it
# when a downstream step fails.
# ---------------------------------------------------------------------------

@pytest.mark.usefixtures("tmp_db")
class TestRollbackPreservesAdoptedRoot:
    def test_failure_after_adopt_leaves_existing_root_intact(self, monkeypatch):
        _seed_paper("arxiv:2204.12985", version=1)

        local_meta = PaperMetadata(
            source_id="local:mno345",
            version=1,
            title="Failing Import",
            authors=["Alice"],
            published=datetime.date(2024, 1, 15),
            summary="",
            source="pdf",
        )

        # Force the import to fail after the DB save, during the on-disk PDF step.
        def boom(*_a, **_kw):
            raise RuntimeError("simulated disk failure")
        monkeypatch.setattr("service.paper.set_pdf_path", boom)

        pdf_dir = paper_svc._pdf_dir()
        orphan_v2 = pdf_dir / pdf_on_disk_name("arxiv:2204.12985", 2)

        with _mock_resolver(local_meta, ("arxiv:2204.12985", 2)):
            with pytest.raises(RuntimeError, match="simulated disk failure"):
                paper_svc.import_pdf(b"will fail")

        # Pre-existing arxiv root must still be there -- failure of an adoption
        # import must NOT hard-delete the user's existing paper.
        assert db.get_paper_root("arxiv:2204.12985") is not None
        # No local:<sha> root was created either.
        assert db.get_paper_root("local:mno345") is None
        # The v2 PDF file we briefly wrote before set_pdf_path raised should
        # also be unlinked (the wrote_final_path cleanup branch).
        assert not orphan_v2.exists()

    def test_existing_pdf_on_disk_is_not_clobbered(self):
        # Seed an arxiv root + version, then write a sentinel PDF at the
        # canonical path the import would target. The adopt-import must
        # preserve those bytes.
        _seed_paper("arxiv:2204.12985", version=1)
        pdf_dir = paper_svc._pdf_dir()
        target = pdf_dir / pdf_on_disk_name("arxiv:2204.12985", 1)
        target.write_bytes(b"ORIGINAL USER PDF")

        local_meta = PaperMetadata(
            source_id="local:sentinel",
            version=1,
            title="Same Paper",
            authors=["Alice"],
            published=datetime.date(2024, 1, 15),
            summary="",
            source="pdf",
        )
        with _mock_resolver(local_meta, ("arxiv:2204.12985", 1)):
            paper_svc.import_pdf(b"DIFFERENT INCOMING BYTES")

        # User's existing PDF on disk is preserved.
        assert target.read_bytes() == b"ORIGINAL USER PDF"
        # And no temp file was left behind.
        assert not any(p.name.startswith("_upload_") for p in pdf_dir.iterdir())

    def test_failure_after_adopt_into_deleted_root_re_softdeletes(self, monkeypatch):
        # Seed + soft-delete so we have a trashed arxiv root.
        _seed_paper("arxiv:2204.12985", version=1)
        db.soft_delete_paper("arxiv:2204.12985")
        # Sanity: the root exists with STATUS='deleted'.
        assert db.is_paper_deleted("arxiv:2204.12985") is True

        local_meta = PaperMetadata(
            source_id="local:pqr678",
            version=1,
            title="Failing Import",
            authors=["Alice"],
            published=datetime.date(2024, 1, 15),
            summary="",
            source="pdf",
        )

        def boom(*_a, **_kw):
            raise RuntimeError("simulated disk failure")
        monkeypatch.setattr("service.paper.set_pdf_path", boom)

        pdf_dir = paper_svc._pdf_dir()
        canonical = pdf_dir / pdf_on_disk_name("arxiv:2204.12985", 1)

        with _mock_resolver(local_meta, ("arxiv:2204.12985", 1)):
            with pytest.raises(RuntimeError, match="simulated disk failure"):
                paper_svc.import_pdf(b"will fail")

        # The auto-restore that save_paper_metadata triggered should have been
        # undone by the rollback -- the root is back in the trash.
        assert db.is_paper_deleted("arxiv:2204.12985") is True
        # The file briefly written at the canonical path must also be cleaned up.
        # PDF_PATH on the existing v1 row was NULL (the prior soft-delete
        # cleared it), so the re-soft-delete itself doesn't unlink anything --
        # the wrote_final_path file-cleanup branch is what removes the orphan.
        assert not canonical.exists()

    def test_failure_after_adopt_into_deleted_root_new_version_cleans_orphan_file(
        self, monkeypatch
    ):
        # Variant of the above where the import targets a NEW version under the
        # deleted root. The rollback must both re-soft-delete AND unlink the
        # orphan PDF file so we don't leak storage.
        _seed_paper("arxiv:2204.12985", version=1)
        db.soft_delete_paper("arxiv:2204.12985")
        assert db.is_paper_deleted("arxiv:2204.12985") is True

        local_meta = PaperMetadata(
            source_id="local:stu901",
            version=1,
            title="New version, will fail",
            authors=["Alice"],
            published=datetime.date(2024, 6, 1),
            summary="",
            source="pdf",
        )

        # Fail after the file write so the v2 PDF actually lands on disk
        # before rollback runs (matches the orphan scenario the reviewer flagged).
        def boom(*_a, **_kw):
            raise RuntimeError("simulated post-write failure")
        monkeypatch.setattr("service.paper.set_pdf_path", boom)

        pdf_dir = paper_svc._pdf_dir()
        orphan_path = pdf_dir / pdf_on_disk_name("arxiv:2204.12985", 2)

        with _mock_resolver(local_meta, ("arxiv:2204.12985", 2)):
            with pytest.raises(RuntimeError, match="simulated post-write failure"):
                paper_svc.import_pdf(b"v2 bytes that will land then fail")

        # Root is back in the trash.
        assert db.is_paper_deleted("arxiv:2204.12985") is True
        # And the v2 PDF that briefly landed has been unlinked.
        assert not orphan_path.exists()
