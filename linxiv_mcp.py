"""MCP server exposing linXiv tools to Claude and other MCP clients."""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Literal, Optional

from mcp.server.fastmcp import FastMCP  # pyright: ignore[reportMissingImports]

import service.paper as svc_paper
import service.tag as svc_tag
import service.project as svc_project
import service.note as svc_note
import service.files as svc_files
import service.export_import as svc_ei
from service.paper import Paper
from service.tag import Tag, TagIn
from service.project import Project as _SvcProjectFilter, Projects as _SvcProjects, ProjectIn
from service.note import Note as _SvcNote, Notes as _SvcNotes, NoteIn, NoteUpdateIn
from service.models.project import ProjectDetails, Status as _SvcStatus
from service.models.note import NoteDetails
from storage.notes import ensure_notes_db as _ensure_notes_db
from storage.projects import (
    ensure_projects_db,
    get_project as _storage_get_project,
)
from sources.arxiv_source import ArxivSource
from sources.crossref_source import CrossRefSource
from sources.openalex_source import OpenAlexSource


mcp = FastMCP("linxiv")

_SOURCES = {
    "arxiv":    ArxivSource,
    "crossref": CrossRefSource,
    "openalex": OpenAlexSource,
}

svc_paper.init_db()
ensure_projects_db()
_ensure_notes_db()


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

def _note_to_dict(n: NoteDetails) -> dict:
    return {
        "id":          n.note_id,
        "source_fk":   n.source_fk,
        "paper_id_fk": n.paper_id_fk,
        "project_id":  n.project_id,
        "title":       n.title,
        "content":     n.content,
        "created_at":  n.created_at.isoformat() if n.created_at else None,
        "updated_at":  n.updated_at.isoformat() if n.updated_at else None,
    }


def _project_details_to_dict(p: ProjectDetails) -> dict:
    return {
        "id":           p.id,
        "name":         p.name,
        "description":  p.description,
        "color":        p.color,
        "project_tags": p.project_tags,
        "source_fks":   p.source_fks,
        "paper_count":  len(p.source_fks),
        "status":       p.status.value,
        "created_at":   p.created_at.isoformat() if p.created_at else None,
        "updated_at":   p.updated_at.isoformat() if p.updated_at else None,
        "archived_at":  p.archived_at.isoformat() if p.archived_at else None,
    }


def _resolve_source(source: str):
    cls = _SOURCES.get(source)
    if cls is None:
        raise ValueError(f"Unknown source {source!r}. Use 'arxiv', 'crossref', or 'openalex'.")
    return cls


# ── Paper tools ───────────────────────────────────────────────────────────────

@mcp.tool()
def search_papers(query: str, source: str = "arxiv", max_results: int = 10) -> list[dict]:
    """Search for academic papers by keyword.

    Args:
        query: Search query string (e.g. "transformer attention mechanism").
        source: Data source — "arxiv", "crossref", or "openalex".
        max_results: Maximum number of results to return (default 10).
    """
    return [r.model_dump(mode="json") for r in _resolve_source(source)().search(query, max_results=max_results)]


@mcp.tool()
def fetch_paper(paper_id: str, source: str = "arxiv") -> dict:
    """Fetch full metadata for a paper by ID and save it to the local database.

    Args:
        paper_id: arXiv style (e.g. "2204.12985"), CrossRef DOI, or OpenAlex ID (e.g. "W3123456789").
        source: Data source — "arxiv", "crossref", or "openalex".
    """
    meta = _resolve_source(source)().fetch_by_id(paper_id)
    svc_paper.save_paper_metadata(meta)
    return meta.model_dump(mode="json")


@mcp.tool()
def list_papers(limit: Optional[int] = None, offset: int = 0, category: Optional[str] = None) -> list[dict]:
    """List papers stored in the local database.

    Args:
        limit: Maximum number of papers to return (default: all).
        offset: Number of papers to skip for pagination.
        category: Filter by arXiv primary category (e.g. "cs.LG").
    """
    papers = svc_paper.list_paper_details(limit=None, offset=0)
    results = [p.to_dict() for p in papers]
    if category:
        results = [p for p in results if p.get("category") == category]
    results = results[offset:]
    if limit is not None:
        results = results[:limit]
    return results


@mcp.tool()
def get_paper(paper_id: str) -> Optional[dict]:
    """Get full metadata for a single paper from the local database.

    Args:
        paper_id: The paper ID (e.g. "arxiv:2204.12985" or "2204.12985").
    """
    paper = svc_paper.get(Paper(source_id=paper_id))
    return paper.to_dict() if paper else None


@mcp.tool()
def delete_paper(paper_id: str) -> dict:
    """Soft-delete a paper from the local database.

    The paper is moved to trash and can be restored. Use paper_id in the
    format returned by list_papers or get_paper (e.g. "arxiv:2204.12985").

    Args:
        paper_id: The paper source ID to delete.
    """
    if svc_paper.get(Paper(source_id=paper_id)) is None:
        raise ValueError(f"Paper {paper_id!r} not found in database.")
    svc_paper.delete(Paper(source_id=paper_id))
    return {"deleted": paper_id}


@mcp.tool()
def get_paper_versions(paper_id: str) -> Optional[dict]:
    """Get all stored versions of a paper.

    Args:
        paper_id: The paper source ID (e.g. "arxiv:2204.12985").
    """
    all_ver = svc_paper.get_all(Paper(source_id=paper_id))
    if all_ver is None:
        return None
    return dataclasses.asdict(all_ver, dict_factory=lambda items: {
        k: v.isoformat() if hasattr(v, "isoformat") else v
        for k, v in items
    })


@mcp.tool()
def search_full_text(query: str, limit: int = 20) -> list[dict]:
    """Full-text search over downloaded TeX source content.

    Only papers whose TeX source has been downloaded will appear.

    Args:
        query: SQLite FTS5 query string.
        limit: Maximum number of results (default 20).
    """
    try:
        return [p.to_dict() for p in svc_paper.search_full_text_details(query, limit=limit)]
    except Exception as exc:
        print(f"[mcp] search_full_text error for query {query!r}: {exc}")
        return []


# ── Tag tools ─────────────────────────────────────────────────────────────────

@mcp.tool()
def list_all_tags() -> list[str]:
    """List all tags in the database."""
    return svc_tag.list_all_tags()


@mcp.tool()
def get_paper_tags(paper_id: str) -> dict:
    """Get all tags applied to a specific paper.

    Args:
        paper_id: The paper source ID (e.g. "arxiv:2204.12985").
    """
    tags = svc_tag.get_paper_tags(paper_id)
    return {"paper_id": paper_id, "tags": tags}


@mcp.tool()
def add_tags_to_paper(paper_id: str, tags: list[str]) -> dict:
    """Add one or more tags to a paper.

    Args:
        paper_id: The paper source ID (e.g. "arxiv:2204.12985").
        tags: List of tag labels to add.
    """
    paper = svc_paper.get(Paper(source_id=paper_id))
    if paper is None:
        raise ValueError(f"Paper {paper_id!r} not found in database.")
    updated = svc_tag.add_paper_tags(paper_id, tags)
    return {"paper_id": paper_id, "tags": updated}


@mcp.tool()
def remove_tags_from_paper(paper_id: str, tags: list[str]) -> dict:
    """Remove one or more tags from a paper.

    Args:
        paper_id: The paper source ID (e.g. "arxiv:2204.12985").
        tags: List of tag labels to remove.
    """
    paper = svc_paper.get(Paper(source_id=paper_id))
    if paper is None:
        raise ValueError(f"Paper {paper_id!r} not found in database.")
    updated = svc_tag.remove_paper_tags(paper_id, tags)
    return {"paper_id": paper_id, "tags": updated}


@mcp.tool()
def create_tag(label: str) -> dict:
    """Create a new tag (or return its ID if it already exists).

    Args:
        label: Tag label text.
    """
    tag_id = svc_tag.upsert(TagIn(label=label))
    if tag_id is None or tag_id < 0:
        raise RuntimeError(f"Failed to create or locate tag {label!r}.")
    return {"tag_id": tag_id, "label": label}


@mcp.tool()
def delete_tag(tag_id: int) -> dict:
    """Delete a tag by its ID.

    Args:
        tag_id: Numeric tag ID (from create_tag or list_all_tags).
    """
    if svc_tag.get(Tag(tag_id=tag_id)) is None:
        raise ValueError(f"Tag {tag_id} not found.")
    svc_tag.delete(Tag(tag_id=tag_id))
    return {"deleted": tag_id}


# ── Project tools ─────────────────────────────────────────────────────────────

@mcp.tool()
def list_projects(status: Optional[str] = None) -> list[dict]:
    """List research projects.

    Args:
        status: Filter by status — "active", "archived", or "deleted".
                Defaults to all non-deleted projects.
    """
    if status is not None:
        try:
            status_enum = _SvcStatus(status)
        except ValueError:
            raise ValueError(f"Invalid status {status!r}. Use 'active', 'archived', or 'deleted'.")
        projects = svc_project.get_many(_SvcProjects(status=status_enum))
    else:
        all_projects = svc_project.get_many(_SvcProjects())
        projects = [p for p in all_projects if p.status != _SvcStatus.DELETED]
    return [_project_details_to_dict(p) for p in projects]


@mcp.tool()
def get_project(project_id: int) -> Optional[dict]:
    """Get full details for a project.

    Args:
        project_id: Numeric project ID.
    """
    details = svc_project.get(_SvcProjectFilter(project_fk=project_id))
    return _project_details_to_dict(details) if details else None


@mcp.tool()
def create_project(name: str, description: str = "") -> dict:
    """Create a new research project.

    Args:
        name: Project name.
        description: Optional description.
    """
    fk = svc_project.create(ProjectIn(name=name, description=description))
    details = svc_project.get(_SvcProjectFilter(project_fk=fk))
    return _project_details_to_dict(details) if details else {"id": fk, "name": name}


@mcp.tool()
def update_project(
    project_id: int,
    name: Optional[str] = None,
    description: Optional[str] = None,
) -> dict:
    """Update a project's name or description.

    Args:
        project_id: Numeric project ID.
        name: New name (omit to leave unchanged).
        description: New description (omit to leave unchanged).
    """
    details = svc_project.get(_SvcProjectFilter(project_fk=project_id))
    if details is None:
        raise ValueError(f"Project {project_id} not found.")
    svc_project.update(project_id, name=name, description=description)
    updated = svc_project.get(_SvcProjectFilter(project_fk=project_id))
    return _project_details_to_dict(updated) if updated else {}


@mcp.tool()
def delete_project(project_id: int) -> dict:
    """Soft-delete a project (moves it to trash).

    Args:
        project_id: Numeric project ID.
    """
    details = svc_project.get(_SvcProjectFilter(project_fk=project_id))
    if details is None:
        raise ValueError(f"Project {project_id} not found.")
    svc_project.delete(_SvcProjectFilter(project_fk=project_id))
    return {"deleted": project_id}


@mcp.tool()
def add_paper_to_project(project_id: int, paper_id: str) -> dict:
    """Add a paper to an existing project.

    Args:
        project_id: Numeric project ID.
        paper_id: Paper ID to add (e.g. "arxiv:2204.12985").
    """
    p = _storage_get_project(project_id)
    if p is None:
        raise ValueError(f"Project {project_id} not found.")
    root = svc_paper.get_paper_root(paper_id)
    if root is None:
        raise ValueError(f"Paper {paper_id!r} not found in database.")
    p.add_paper(int(root["SOURCE_FK"]))
    return {"project_id": p.id, "paper_id": paper_id, "paper_count": p.paper_count}


@mcp.tool()
def remove_paper_from_project(project_id: int, paper_id: str) -> dict:
    """Remove a paper from a project.

    Args:
        project_id: Numeric project ID.
        paper_id: Paper ID to remove.
    """
    p = _storage_get_project(project_id)
    if p is None:
        raise ValueError(f"Project {project_id} not found.")
    root = svc_paper.get_paper_root(paper_id)
    if root is None:
        raise ValueError(f"Paper {paper_id!r} not found in database.")
    p.remove_paper(int(root["SOURCE_FK"]))
    return {"project_id": p.id, "paper_id": paper_id, "paper_count": p.paper_count}


@mcp.tool()
def export_project(project_id: int, dest: str, include_pdfs: bool = False) -> dict:
    """Export a project to a .lxproj archive file.

    Args:
        project_id: Numeric project ID.
        dest: Destination file path (.lxproj extension added automatically if absent).
        include_pdfs: Include bundled PDFs in the archive (default False).
    """
    details = svc_project.get(_SvcProjectFilter(project_fk=project_id))
    if details is None:
        raise ValueError(f"Project {project_id} not found.")
    out = svc_ei.export_project(project_id, Path(dest), include_pdfs=include_pdfs)
    return {"path": str(out), "project_id": project_id}


@mcp.tool()
def import_project(
    zip_path: str,
    on_conflict: Literal["merge", "overwrite"] = "merge",
    preview: bool = False,
) -> dict:
    """Import a project from a .lxproj archive file.

    Args:
        zip_path: Path to the .lxproj archive.
        on_conflict: How to handle papers that already exist — "merge" or "overwrite".
        preview: If True, return a summary without modifying the database.
    """
    path = Path(zip_path)
    if preview:
        result = svc_ei.preview_import(path)
        return dataclasses.asdict(result)
    fk = svc_ei.commit_import(path, on_conflict=on_conflict)
    return {"project_id": fk}


# ── Note tools ────────────────────────────────────────────────────────────────

@mcp.tool()
def create_note(
    paper_id: str,
    content: str,
    title: str = "",
    project_id: Optional[int] = None,
) -> dict:
    """Create a note attached to a paper, optionally scoped to a project.

    The paper must be in the local database (run fetch_paper first).

    Args:
        paper_id: Paper ID the note is attached to.
        content: Body text of the note.
        title: Optional note title.
        project_id: Associate the note with a specific project.
    """
    root = svc_paper.get_paper_root(paper_id)
    if root is None:
        raise ValueError(f"Paper {paper_id!r} not found. Run fetch_paper first.")
    source_fk = int(root["SOURCE_FK"])
    note_id = svc_note.create(NoteIn(source_fk=source_fk, project_fk=project_id, title=title, content=content))
    created = svc_note.get(_SvcNote(note_id=note_id))
    return _note_to_dict(created) if created else {"id": note_id, "source_fk": source_fk, "project_id": project_id, "title": title}


@mcp.tool()
def get_note(note_id: int) -> Optional[dict]:
    """Get a single note by its ID.

    Args:
        note_id: Numeric note ID.
    """
    details = svc_note.get(_SvcNote(note_id=note_id))
    return _note_to_dict(details) if details else None


@mcp.tool()
def list_notes(
    paper_id: Optional[str] = None,
    project_id: Optional[int] = None,
) -> list[dict]:
    """List notes, optionally filtered by paper or project.

    Omit both arguments to return all notes.

    Args:
        paper_id: Filter by paper source ID (e.g. "arxiv:2204.12985").
        project_id: Filter by project ID.
    """
    if paper_id is None and project_id is None:
        notes = svc_note.list_all()
    else:
        source_fk: Optional[int] = None
        if paper_id is not None:
            root = svc_paper.get_paper_root(paper_id)
            if root is None:
                raise ValueError(f"Paper {paper_id!r} not found in database.")
            source_fk = int(root["SOURCE_FK"])
        # all_projects=True returns every note for the paper regardless of project scope;
        # when project_id is also given, project_fk narrows the results as expected.
        notes = svc_note.get_many(_SvcNotes(
            source_fk=source_fk,
            project_fk=project_id,
            all_projects=paper_id is not None and project_id is None,
        ))
    return [_note_to_dict(n) for n in notes]


@mcp.tool()
def update_note(
    note_id: int,
    title: Optional[str] = None,
    content: Optional[str] = None,
) -> dict:
    """Update a note's title and/or content.

    At least one of title or content must be provided.

    Args:
        note_id: Numeric note ID.
        title: New title (omit to leave unchanged).
        content: New content (omit to leave unchanged).
    """
    ok = svc_note.update(NoteUpdateIn(note_id=note_id, title=title, content=content))
    if not ok:
        raise ValueError(f"Note {note_id} not found.")
    updated = svc_note.get(_SvcNote(note_id=note_id))
    return _note_to_dict(updated) if updated else {}


@mcp.tool()
def delete_note(note_id: int) -> dict:
    """Delete a note by its ID.

    Args:
        note_id: Numeric note ID.
    """
    details = svc_note.get(_SvcNote(note_id=note_id))
    if details is None:
        raise ValueError(f"Note {note_id} not found.")
    svc_note.delete(_SvcNote(note_id=note_id))
    return {"deleted": note_id}


@mcp.tool()
def get_notes_for_paper(paper_id: str, project_id: Optional[int] = None) -> list[dict]:
    """Retrieve notes attached to a paper.

    Args:
        paper_id: Paper ID to look up notes for.
        project_id: Scope to a specific project (None returns all notes for the paper).
    """
    root = svc_paper.get_paper_root(paper_id)
    if root is None:
        raise ValueError(f"Paper {paper_id!r} not found in database.")
    return [_note_to_dict(n) for n in svc_note.get_many(_SvcNotes(
        source_fk=int(root["SOURCE_FK"]),
        project_fk=project_id,
        all_projects=project_id is None,
    ))]


@mcp.tool()
def get_notes_for_project(project_id: int) -> list[dict]:
    """Retrieve all notes scoped to a project, across all its papers.

    Args:
        project_id: Numeric project ID.
    """
    return [_note_to_dict(n) for n in svc_note.get_many(_SvcNotes(project_fk=project_id))]


# ── PDF tools ─────────────────────────────────────────────────────────────────

@mcp.tool()
def get_pdf_path(paper_id: str, version: Optional[int] = None) -> dict:
    """Get the local filesystem path for a paper's PDF, if downloaded.

    Args:
        paper_id: The paper source ID (e.g. "arxiv:2204.12985").
        version: Specific version number (defaults to latest).
    """
    paper = svc_paper.get(Paper(source_id=paper_id, version=version))
    if paper is None:
        raise ValueError(f"Paper {paper_id!r} not found in database.")
    ver = paper.version
    path = svc_files.pdf_path(paper.source_id, ver, paper.pdf_path)
    return {"paper_id": paper_id, "version": ver, "path": path}


@mcp.tool()
def download_pdf(paper_id: str, url: str, version: Optional[int] = None) -> dict:
    """Download a PDF for a paper and save it to the managed PDF directory.

    Args:
        paper_id: The paper source ID (e.g. "arxiv:2204.12985").
        url: Direct URL to the PDF file.
        version: Specific version number (defaults to latest).
    """
    paper = svc_paper.get(Paper(source_id=paper_id, version=version))
    if paper is None:
        raise ValueError(f"Paper {paper_id!r} not found in database.")
    ver = paper.version
    path = svc_files.download_pdf(paper.source_id, ver, url)
    svc_paper.mark_pdf_saved(paper.source_id, path, ver)
    return {"paper_id": paper_id, "version": ver, "path": path}


@mcp.tool()
def get_pdf_storage() -> dict:
    """Report total PDF storage usage for all managed PDFs.

    Returns storage in megabytes and the path to the PDF directory.
    """
    mb = svc_files.pdf_storage_mb()
    return {"storage_mb": round(mb, 3), "pdf_dir": svc_files.managed_pdf_dir()}


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
