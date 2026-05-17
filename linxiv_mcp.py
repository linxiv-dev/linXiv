"""MCP server exposing linXiv tools to Claude and other MCP clients."""

from __future__ import annotations

from typing import Optional

from mcp.server.fastmcp import FastMCP  # pyright: ignore[reportMissingImports]

import service.paper as svc_paper
from service.paper import Paper
from storage.notes import Note, ensure_notes_db, get_notes, get_project_notes
from storage.projects import (
    Project, Status, Q,
    ensure_projects_db, filter_projects, get_project,
)
from sources.arxiv_source import ArxivSource
from sources.openalex_source import OpenAlexSource

from AI_tools import PaperContent, tag


mcp = FastMCP("linxiv")

_SOURCES = {
    "arxiv":    ArxivSource,
    "openalex": OpenAlexSource,
}

svc_paper.init_db()
ensure_projects_db()
ensure_notes_db()


# ── Paper tools ───────────────────────────────────────────────────────────────

@mcp.tool()
def search_papers(query: str, source: str = "arxiv", max_results: int = 10) -> list[dict]:
    """Search for academic papers by keyword.

    Args:
        query: Search query string (e.g. "transformer attention mechanism").
        source: Data source — "arxiv" or "openalex".
        max_results: Maximum number of results to return (default 10).
    """
    cls = _SOURCES.get(source)
    if cls is None:
        raise ValueError(f"Unknown source {source!r}. Use 'arxiv' or 'openalex'.")
    return [r.model_dump(mode="json") for r in cls().search(query, max_results=max_results)]


@mcp.tool()
def fetch_paper(paper_id: str, source: str = "arxiv") -> dict:
    """Fetch full metadata for a paper by ID and save it to the local database.

    Args:
        paper_id: arXiv style (e.g. "2204.12985") or OpenAlex style (e.g. "W3123456789").
        source: Data source — "arxiv" or "openalex".
    """
    cls = _SOURCES.get(source)
    if cls is None:
        raise ValueError(f"Unknown source {source!r}. Use 'arxiv' or 'openalex'.")
    meta = cls().fetch_by_id(paper_id)
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
    papers = svc_paper.list_paper_details(limit=limit, offset=offset)
    results = [p.to_dict() for p in papers]
    if category:
        results = [p for p in results if p.get("category") == category]
    return results


@mcp.tool()
def get_paper(paper_id: str) -> Optional[dict]:
    """Get full metadata for a single paper from the local database.

    Args:
        paper_id: The paper ID (e.g. "2204.12985").
    """
    paper = svc_paper.get(Paper(source_id=paper_id))
    return paper.to_dict() if paper is not None else None


@mcp.tool()
def search_full_text(query: str, limit: int = 20) -> list[dict]:
    """Full-text search over downloaded TeX source content.

    Only papers whose TeX source has been downloaded will appear.

    Args:
        query: SQLite FTS5 query string.
        limit: Maximum number of results (default 20).
    """
    return [p.to_dict() for p in svc_paper.search_full_text_details(query, limit=limit)]


@mcp.tool()
def tag_paper(paper_id: str) -> dict:
    """Generate AI tags for a paper using Google Gemini.

    The paper must already be in the local database (run fetch_paper first).

    Args:
        paper_id: The paper ID to tag (e.g. "2204.12985").
    """

    paper = svc_paper.get(Paper(source_id=paper_id))
    if paper is None:
        raise ValueError(f"Paper {paper_id!r} not found. Run fetch_paper first.")
    content = PaperContent(
        abstract=paper.summary or "",
        full_text=paper.full_text,
    )
    return {"paper_id": paper_id, "tags": tag(content)}


# ── Project tools ─────────────────────────────────────────────────────────────

@mcp.tool()
def list_projects(status: Optional[str] = None) -> list[dict]:
    """List research projects.

    Args:
        status: Filter by status — "active", "archived", or "deleted".
                Defaults to all non-deleted projects.
    """
    if status:
        projects = filter_projects(Q("status = ?", Status(status)))
    else:
        projects = filter_projects(~Q("status = ?", Status.DELETED))
    return [
        {
            "id": p.id,
            "name": p.name,
            "description": p.description,
            "status": p.status.value,
            "paper_count": p.paper_count,
            "source_fks": p.source_fks,
        }
        for p in projects
    ]


@mcp.tool()
def create_project(name: str, description: str = "") -> dict:
    """Create a new research project.

    Args:
        name: Project name.
        description: Optional description.
    """
    p = Project(name=name, description=description)
    p.save()
    return {"id": p.id, "name": p.name, "status": p.status.value}


@mcp.tool()
def add_paper_to_project(project_id: int, paper_id: str) -> dict:
    """Add a paper to an existing project.

    Args:
        project_id: Numeric project ID.
        paper_id: Paper ID to add (e.g. "2204.12985").
    """
    p = get_project(project_id)
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
    p = get_project(project_id)
    if p is None:
        raise ValueError(f"Project {project_id} not found.")
    root = svc_paper.get_paper_root(paper_id)
    if root is None:
        raise ValueError(f"Paper {paper_id!r} not found in database.")
    p.remove_paper(int(root["SOURCE_FK"]))
    return {"project_id": p.id, "paper_id": paper_id, "paper_count": p.paper_count}


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
    note = Note(source_fk=int(root["SOURCE_FK"]), project_id=project_id, title=title, content=content)
    note.save()
    return {"id": note.id, "source_fk": note.source_fk, "project_id": note.project_id, "title": note.title}


@mcp.tool()
def get_notes_for_paper(paper_id: str, project_id: Optional[int] = None) -> list[dict]:
    """Retrieve notes attached to a paper.

    Args:
        paper_id: Paper ID to look up notes for.
        project_id: Scope to a specific project (None returns unscoped notes).
    """
    root = svc_paper.get_paper_root(paper_id)
    if root is None:
        return []
    return [
        {
            "id": n.note_id,
            "source_fk": n.source_fk,
            "project_id": n.project_id,
            "title": n.title,
            "content": n.content,
            "created_at": n.created_at.isoformat() if n.created_at else None,
        }
        for n in get_notes(int(root["SOURCE_FK"]), project_id=project_id)
    ]


@mcp.tool()
def get_notes_for_project(project_id: int) -> list[dict]:
    """Retrieve all notes scoped to a project, across all its papers.

    Args:
        project_id: Numeric project ID.
    """
    return [
        {
            "id": n.note_id,
            "source_fk": n.source_fk,
            "project_id": n.project_id,
            "title": n.title,
            "content": n.content,
            "created_at": n.created_at.isoformat() if n.created_at else None,
        }
        for n in get_project_notes(project_id)
    ]


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
