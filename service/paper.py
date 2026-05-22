from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime
from typing import TYPE_CHECKING

import storage.db as db
import storage.projects as _proj_storage
from service.models.paper import PaperDetails, PaperDetailsAll
from sources.base import PaperMetadata

if TYPE_CHECKING:
    import arxiv

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Service models — derived from the `papers` view schema
# ---------------------------------------------------------------------------

@dataclass
class Paper:
    """Identifies a single paper — supply exactly one of the three keys.

    source_fk  — PAPER_ROOTS.SOURCE_FK (paper identity, any version)
    paper_id   — PAPER.PAPER_ID        (specific version, PK)
    source_id  — human-readable arxiv ID; pair with version to pin a version
    """
    source_fk:  int | None = None
    paper_id:   int | None = None
    source_id:  str | None = None
    version:    int | None = None  # only meaningful alongside source_id


@dataclass
class Papers:
    """Filter criteria for listing multiple papers."""
    source_fks:  list[int] | None = None
    paper_ids:   list[int] | None = None
    source_ids:  list[str] | None = None
    project_fks: list[int] | None = None
    tags:        list[str] | None = None


# Basic model sent from the GUI when manually adding a paper
@dataclass
class PaperIn:
    title:       str
    published:   date
    source_id:   str | None       = None
    version:     int | None       = None
    authors:     list[str] | None = None
    summary:     str | None       = None
    category:    str | None       = None
    doi:         str | None       = None
    url:         str | None       = None
    tags:        list[str] | None = None
    source:      str | None       = None


@dataclass
class DeletedPaperDetails:
    source_fk:   int
    source_id:   str
    title:       str
    authors:     list[str] | None
    published:   date | None
    deleted_at:  datetime | None
    pdf_path:    str | None
    had_pdf:     bool
    project_fks: list[int]


# ---------------------------------------------------------------------------
# DB lifecycle
# ---------------------------------------------------------------------------

def init_db() -> None:
    db.init_db()


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------

def parse_entry_id(entry_id: str) -> tuple[str, int]:
    return db.parse_entry_id(entry_id)


# ---------------------------------------------------------------------------
# Row → dataclass helpers
# ---------------------------------------------------------------------------

def _row_to_paper_details(row: sqlite3.Row) -> PaperDetails:
    return PaperDetails(
        paper_id=row["paper_id"],
        source_id=row["source_id"],
        version=row["version"],
        title=row["title"],
        summary=row["summary"],
        published=row["published"],
        updated=row["updated"],
        url=row["url"],
        doi=row["doi"],
        category=row["category"],
        categories=row["categories"],
        journal_ref=row["journal_ref"],
        comment=row["comment"],
        authors=row["authors"],
        tags=row["tags"],
        has_pdf=row["has_pdf"],
        pdf_path=row["pdf_path"],
        source=row["source"],
        full_text=row["full_text"],
        downloaded_source=row["downloaded_source"],
        source_fk=row["source_fk"],
    )


# ---------------------------------------------------------------------------
# Dispatch helpers
# ---------------------------------------------------------------------------

def _warn_multi_key(paper: Paper, caller: str) -> None:
    """Warn when more than one identifying key is set on a Paper.

    Each dispatch site has its own priority order; the log includes the
    caller name so readers know which priority was applied.
    """
    keys_set = [
        name
        for name, val in (
            ("paper_id", paper.paper_id),
            ("source_fk", paper.source_fk),
            ("source_id", paper.source_id),
        )
        if val is not None
    ]
    if len(keys_set) > 1:
        _log.warning(
            "%s: multiple keys set %s — resolution order is documented in the function's docstring",
            caller,
            keys_set,
        )


# ---------------------------------------------------------------------------
# Master getter — dispatches on whichever Paper field is populated
# ---------------------------------------------------------------------------

def get(paper: Paper) -> PaperDetails | None:
    """Fetch a single paper version.

    Resolution order:
      paper_id   → exact PAPER row by PK
      source_fk  → latest version for this PAPER_ROOTS row
      source_id  → latest version, or pinned version if Paper.version is set
    """
    _warn_multi_key(paper, "paper.get")
    if paper.paper_id is not None:
        if paper.version is not None:
            _log.debug("paper.get: dispatching on paper_id=%r (version=%r ignored)", paper.paper_id, paper.version)
        else:
            _log.debug("paper.get: dispatching on paper_id=%r", paper.paper_id)
        row = db.get_paper_by_id(paper.paper_id)
    elif paper.source_fk is not None:
        if paper.version is not None:
            _log.debug("paper.get: dispatching on source_fk=%r (version=%r ignored)", paper.source_fk, paper.version)
        else:
            _log.debug("paper.get: dispatching on source_fk=%r", paper.source_fk)
        row = db.get_paper_by_source_fk(paper.source_fk)
    elif paper.source_id is not None:
        _log.debug("paper.get: dispatching on source_id=%r version=%r", paper.source_id, paper.version)
        row = db.get_paper(paper.source_id, paper.version)
    else:
        _log.debug("paper.get: no key set, returning None")
        return None
    if row is None:
        return None
    return _row_to_paper_details(row)


def get_all(paper: Paper) -> PaperDetailsAll | None:
    """Fetch all stored versions of a paper, display fields from the latest.

    Resolution order (differs from get()):
      source_id  → all versions for this paper ID
      paper_id   → resolve source_id via the PAPER row, then fetch all versions
      source_fk  → resolve source_id via PAPER_ROOTS, then fetch all versions
    """
    _warn_multi_key(paper, "paper.get_all")
    if paper.source_id is not None:
        _log.debug("paper.get_all: dispatching on source_id=%r (all versions)", paper.source_id)
        source_id = paper.source_id
    elif paper.paper_id is not None:
        _log.debug("paper.get_all: dispatching on paper_id=%r", paper.paper_id)
        row = db.get_paper_by_id(paper.paper_id)
        if row is None:
            return None
        source_id = row["source_id"]
    elif paper.source_fk is not None:
        _log.debug("paper.get_all: dispatching on source_fk=%r", paper.source_fk)
        row = db.get_paper_by_source_fk(paper.source_fk)
        if row is None:
            return None
        source_id = row["source_id"]
    else:
        _log.debug("paper.get_all: no key set, returning None")
        return None

    rows = db.get_all_versions(source_id)
    if not rows:
        return None

    latest = rows[-1]
    versions = [_row_to_paper_details(r) for r in rows]

    return PaperDetailsAll(
        source_id=source_id,
        latest_version=latest["version"],
        title=latest["title"],
        authors=latest["authors"],
        summary=latest["summary"],
        published=rows[0]["published"],
        updated=latest["updated"],
        doi=latest["doi"],
        url=latest["url"],
        category=latest["category"],
        categories=latest["categories"],
        journal_ref=latest["journal_ref"],
        comment=latest["comment"],
        tags=latest["tags"],
        source=latest["source"],
        versions=versions,
    )


def get_many(papers: Papers) -> list[PaperDetails]:
    """Fetch multiple papers matching any combination of Papers filter fields."""
    rows = db.list_papers(latest_only=True)
    results: list[PaperDetails] = []
    for row in rows:
        if papers.paper_ids and row["paper_id"] not in papers.paper_ids:
            continue
        if papers.source_ids and row["source_id"] not in papers.source_ids:
            continue
        if papers.tags:
            row_tags = row["tags"] or []
            if not any(t in row_tags for t in papers.tags):
                continue
        results.append(_row_to_paper_details(row))

    if papers.source_fks:
        fk_set = set(papers.source_fks)
        fk_results: list[PaperDetails] = []
        for detail in results:
            root = db.get_paper_root(detail.source_id)
            if root and root["SOURCE_FK"] in fk_set:
                fk_results.append(detail)
        results = fk_results

    return results


# ---------------------------------------------------------------------------
# Master upsert — inserts or updates based on whether the paper already exists
# ---------------------------------------------------------------------------

def upsert(paper: PaperIn, tags: list[str] | None = None) -> tuple[str, int]:
    """Insert a new paper or update an existing one.

    Existence is determined by source_id + version when both are present,
    or source_id alone (updating latest) when version is omitted.
    Returns (source_id, version).
    """
    meta = PaperMetadata(
        source_id=paper.source_id or "",
        version=paper.version or 1,
        title=paper.title,
        authors=paper.authors or [],
        published=paper.published,
        updated=None,
        summary=paper.summary or "",
        category=paper.category,
        categories=None,
        doi=paper.doi,
        journal_ref=None,
        comment=None,
        url=paper.url,
        tags=paper.tags,
        source=paper.source,
    )
    return db.save_paper_metadata(meta, tags)


# ---------------------------------------------------------------------------
# Low-level reads (used internally and by specific callsites)
# ---------------------------------------------------------------------------

def get_paper(source_id: str, version: int | None = None) -> sqlite3.Row | None:
    return db.get_paper(source_id, version)

def get_paper_details(paper: Paper) -> PaperDetails | None:
    return get(paper)

def get_paper_details_all(paper: Paper) -> PaperDetailsAll | None:
    return get_all(paper)

def get_all_versions(source_id: str) -> list[sqlite3.Row]:
    return db.get_all_versions(source_id)

def get_paper_root(source_id: str) -> sqlite3.Row | None:
    """Return the PAPER_ROOTS row for a given source_id."""
    return db.get_paper_root(source_id)


def ensure_paper_root(source_id: str) -> int:
    """Insert PAPER_ROOTS row if absent. Returns SOURCE_FK."""
    return db.ensure_paper_root(source_id)


def get_source_id(source_fk: int) -> str | None:
    """Return SOURCE_ID (text paper ID) for a given SOURCE_FK, or None."""
    return db.get_source_id(source_fk)


# ---------------------------------------------------------------------------
# Multi-paper reads
# ---------------------------------------------------------------------------

def list_papers(
    latest_only: bool = True,
    limit: int | None = None,
    offset: int = 0,
) -> list[sqlite3.Row]:
    return db.list_papers(latest_only=latest_only, limit=limit, offset=offset)

def list_paper_details(
    latest_only: bool = True,
    limit: int | None = None,
    offset: int = 0,
) -> list[PaperDetails]:
    rows = db.list_papers(latest_only=latest_only, limit=limit, offset=offset)
    return [_row_to_paper_details(r) for r in rows]

def sfks_to_source_ids(source_fks: list[int]) -> list[str]:
    return [sid for sfk in source_fks if (sid := db.get_source_id(sfk))]

def get_papers(papers: Papers) -> list[PaperDetails]:
    return get_many(papers)

def get_graph_data() -> tuple[list[dict], list[dict]]:
    return db.get_graph_data()

def get_categories() -> list[str]:
    return db.get_categories()

def get_papers_by_tag(label: str) -> list[PaperDetails]:
    """Return all latest papers whose tags include the given label (case-insensitive)."""
    rows = db.get_papers_by_json_tag(label)
    return [_row_to_paper_details(r) for r in rows]


# ---------------------------------------------------------------------------
# Write / mutate
# ---------------------------------------------------------------------------

def save_paper(paper: arxiv.Result, tags: list[str] | None = None) -> tuple[str, int]:
    return db.save_paper(paper, tags)

def save_papers(papers: list[arxiv.Result], tags: list[str] | None = None) -> list[tuple[str, int]]:
    return db.save_papers(papers, tags)

def save_paper_metadata(meta: PaperMetadata, tags: list[str] | None = None) -> tuple[str, int]:
    return db.save_paper_metadata(meta, tags)

def save_papers_metadata(metas: list[PaperMetadata], tags: list[str] | None = None) -> list[tuple[str, int]]:
    return db.save_papers_metadata(metas, tags)

def repair_paper(source_fk: int, meta: PaperMetadata) -> None:
    """Re-write a paper's metadata in-place, migrating SOURCE_ID if paper_id changes."""
    db.repair_paper(source_fk, meta)

# ---------------------------------------------------------------------------
# Soft / hard delete helpers
# ---------------------------------------------------------------------------

def _resolve_source_id(paper: Paper) -> str | None:
    """Resolve a Paper to its text source_id.

    Resolution order:
      source_id  → returned directly (no DB roundtrip)
      source_fk  → looked up via PAPER_ROOTS
      paper_id   → looked up via PAPER, then source_id extracted

    Called by delete, restore, and hard_delete. _warn_multi_key must be
    called by each of those callers before delegating here.
    """
    if paper.source_id is not None:
        _log.debug("paper._resolve_source_id: using source_id=%r directly", paper.source_id)
        return paper.source_id
    if paper.source_fk is not None:
        _log.debug("paper._resolve_source_id: looking up source_fk=%r", paper.source_fk)
        return db.get_source_id(paper.source_fk)
    if paper.paper_id is not None:
        _log.debug("paper._resolve_source_id: looking up paper_id=%r", paper.paper_id)
        row = db.get_paper_by_id(paper.paper_id)
        return row["source_id"] if row else None
    _log.debug("paper._resolve_source_id: no key set, returning None")
    return None


def set_has_pdf_by_source(source_id: str, has: bool) -> None:
    """Set has_pdf flag for all versions of a paper by source_id."""
    db.set_has_pdf_all_versions(source_id, has)


def delete(paper: Paper) -> str | None:
    """Soft-delete a paper. Returns the stored pdf_path (or None) for caller reference.

    Resolution order: see _resolve_source_id.
    """
    _warn_multi_key(paper, "paper.delete")
    source_id = _resolve_source_id(paper)
    if source_id is None:
        return None
    return db.soft_delete_paper(source_id)


def restore(paper: Paper) -> tuple[str | None, list[int]]:
    """Restore a soft-deleted paper.

    Precondition: paper must currently be in soft-deleted state; calling this
    on an active paper is a silent no-op (restore_paper is idempotent).

    Returns (pdf_path, project_fks) where:
      pdf_path    — the stored pdf path (may not exist on disk anymore)
      project_fks — the projects this paper belongs to

    Resolution order: see _resolve_source_id.
    """
    _warn_multi_key(paper, "paper.restore")
    source_id = _resolve_source_id(paper)
    if source_id is None:
        return None, []
    # SOURCE_FK is an immutable PK column — reading it in a separate connection
    # before the restore write is safe; no TOCTOU risk on an immutable value.
    root = db.get_paper_root(source_id)
    pdf_path = db.restore_paper(source_id)
    project_fks: list[int] = []
    if root:
        project_fks = _proj_storage.get_paper_project_fks(root["SOURCE_FK"])
    else:
        _log.warning(
            "paper.restore: no PAPER_ROOTS row found for source_id=%r after successful resolve; "
            "project_fks will be empty",
            source_id,
        )
    return pdf_path, project_fks


def hard_delete(paper: Paper) -> None:
    """Permanently remove a paper from the database.

    Resolution order: see _resolve_source_id.
    """
    _warn_multi_key(paper, "paper.hard_delete")
    source_id = _resolve_source_id(paper)
    if source_id is None:
        return
    db.hard_delete_paper(source_id)


def list_deleted() -> list[DeletedPaperDetails]:
    """Return all soft-deleted papers."""
    rows = db.list_deleted_papers()
    result: list[DeletedPaperDetails] = []
    for row in rows:
        source_fk = int(row["source_fk"])
        project_fks = _proj_storage.get_paper_project_fks(source_fk)
        authors = row["authors"]
        if isinstance(authors, str):
            try:
                authors = json.loads(authors)
            except Exception:
                authors = [authors]
        result.append(DeletedPaperDetails(
            source_fk=source_fk,
            source_id=str(row["source_id"]),
            title=str(row["title"]),
            authors=authors,
            published=row["published"],
            deleted_at=row["deleted_at"],
            pdf_path=row["pdf_path"],
            had_pdf=bool(row["had_pdf"]),
            project_fks=project_fks,
        ))
    return result


def is_paper_deleted(source_id: str) -> bool:
    """Return True if the paper exists in soft-deleted state."""
    return db.is_paper_deleted(source_id)


# ---------------------------------------------------------------------------
# PDF management
# ---------------------------------------------------------------------------

def set_has_pdf(source_id: str, version: int, has: bool) -> None:
    db.set_has_pdf(source_id, version, has)

def set_pdf_path(source_id: str, path: str) -> None:
    db.set_pdf_path(source_id, path)


# ---------------------------------------------------------------------------
# Full-text / FTS (papers_fts virtual table)
# ---------------------------------------------------------------------------

def set_full_text(source_id: str, version: int, full_text: str) -> None:
    db.set_full_text(full_text=full_text, paper_id=None, source_id=source_id, version=version)

def search_full_text(query: str, limit: int = 20) -> list[sqlite3.Row]:
    return db.search_full_text(query, limit)

def search_full_text_details(query: str, limit: int = 20) -> list[PaperDetails]:
    return [_row_to_paper_details(r) for r in db.search_full_text(query, limit)]


# ---------------------------------------------------------------------------
# Tag associations on papers (PAPER_TO_TAG)
# ---------------------------------------------------------------------------

def add_paper_tags(source_id: str, tags: list[str]) -> list[str]:
    return db.add_paper_tags(source_id, tags)

def remove_paper_tags(source_id: str, tags: list[str]) -> list[str]:
    return db.remove_paper_tags(source_id, tags)
