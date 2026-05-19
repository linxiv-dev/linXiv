"""
FastAPI JSON API for linXiv (backend only — UI lives in separate clients).

Serves ``/api/...`` routes and, for the graph viewer, static files under
``/assets/graph/`` (from ``gui/graph/web/``) so a frontend can iframe them or proxy the path.
"""

from __future__ import annotations

import datetime
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

from config import ENV_PATH, data_dir, resources_dir
load_dotenv(ENV_PATH)

import arxiv
from fastapi import FastAPI, HTTPException, Query
from dotenv import set_key
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .graph_payload import get_augmented_graph_data, project_filter_options
from storage.db import (
    delete_paper,
    get_categories,
    get_tags,
    init_db,
    parse_entry_id,
    save_paper,
    save_papers,
    save_paper_metadata,
)
from sources import resolve_doi, fetch_paper_metadata, search_papers
from service.paper import (
    Paper,
    ensure_paper_root,
    get as get_paper_details,
    get_paper_root,
    list_paper_details,
    sfks_to_source_ids,
)
import user_settings
from storage.notes import Note, ensure_notes_db, get_note, get_notes
from storage.projects import (
    Project,
    Status,
    color_from_hex,
    color_to_hex,
    ensure_projects_db,
    filter_projects,
    get_project,
)
from storage.tags import get_project_tags

PDF_DIR = data_dir() / "pdfs"
GUI_WEB = resources_dir() / "gui" / "graph" / "web"


def _cors_config() -> tuple[list[str], bool]:
    """Return (origins, allow_credentials). Wildcard * disables credentials."""
    raw = os.environ.get("CORS_ORIGINS", "").strip()
    if not raw:
        return ["*"], False
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    return origins, True



def _arxiv_result_summary(p: arxiv.Result) -> dict:
    sid, ver = parse_entry_id(p.entry_id)
    return {
        "source_id": sid,
        "version": ver,
        "title": p.title,
        "summary": p.summary,
        "authors": [a.name for a in p.authors],
        "published": p.published.date().isoformat(),
        "pdf_url": p.pdf_url,
        "primary_category": p.primary_category,
        "entry_id": p.entry_id,
    }


def _resolve_local_pdf(source_id: str, version: int | None) -> str | None:
    paper = get_paper_details(Paper(source_id=source_id, version=version))
    if not paper:
        return None
    ver = paper.version if version is None else version
    if paper.pdf_path and os.path.isfile(paper.pdf_path):
        return paper.pdf_path
    std = PDF_DIR / f"{source_id}v{ver}.pdf"
    if std.is_file():
        return str(std)
    return None


@asynccontextmanager
async def _lifespan(_: FastAPI):
    init_db()
    ensure_projects_db()
    ensure_notes_db()
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="linXiv API", lifespan=_lifespan)
_cors_origins, _cors_credentials = _cors_config()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def api_root() -> dict:
    """Service metadata. Interactive docs at ``/docs``."""
    return {
        "service": "linXiv",
        "api": "JSON over HTTP; routes under /api/…",
        "docs": "/docs",
        "openapi": "/openapi.json",
        "graph_assets": "/assets/graph/graph.html",
    }


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/stats")
def stats() -> dict:
    papers = list_paper_details(latest_only=True)
    tags = get_tags()
    categories = get_categories()
    return {
        "paper_count": len(papers),
        "tag_count": len(tags),
        "category_count": len(categories),
        "pdf_count": sum(1 for p in papers if p.has_pdf),
        "recent_papers": [p.to_dict() for p in papers[:10]],
    }


@app.get("/api/papers")
def api_list_papers(
    limit: int | None = Query(default=200, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
) -> dict:
    papers = list_paper_details(latest_only=True, limit=limit, offset=offset)
    return {"papers": [p.to_dict() for p in papers]}


@app.get("/api/papers/{source_id}")
def api_get_paper(source_id: str) -> dict:
    paper = get_paper_details(Paper(source_id=source_id))
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    return paper.to_dict()


@app.delete("/api/papers/{source_id}")
def api_delete_paper(source_id: str) -> dict:
    paper = get_paper_details(Paper(source_id=source_id))
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    delete_paper(source_id)
    return {"deleted": source_id}


@app.get("/api/graph")
def api_graph() -> dict:
    return get_augmented_graph_data()


@app.get("/api/categories")
def api_categories() -> dict:
    return {"categories": get_categories()}


@app.get("/api/tags")
def api_tags() -> dict:
    return {"tags": get_tags()}


@app.get("/api/projects")
def api_projects() -> dict:
    projects = filter_projects()
    out = []
    for p in projects:
        if p.id is None:
            continue
        out.append(
            {
                "id": p.id,
                "name": p.name,
                "description": p.description or "",
                "color_hex": color_to_hex(p.color) if p.color else None,
                "project_tags": get_project_tags(p.id),
                "source_ids": sfks_to_source_ids(p.source_fks),
                "status": p.status.value,
                "paper_count": p.paper_count,
            }
        )
    return {"projects": out}


@app.get("/api/graph/project-options")
def api_graph_project_options() -> dict:
    return {"projects": project_filter_options()}


# TODO: add tags: list[str] = [] to ProjectCreate and ProjectUpdate, then call
#       storage.tags.add_project_tags / remove+add in api_project_create and api_project_patch
class ProjectCreate(BaseModel):
    name: str = Field(min_length=1)
    description: str = ""
    color_hex: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    color_hex: str | None = None
    status: str | None = None


@app.post("/api/projects")
def api_project_create(body: ProjectCreate) -> dict:
    color = color_from_hex(body.color_hex) if body.color_hex else None
    p = Project(name=body.name.strip(), description=body.description.strip(), color=color)
    p.save()
    assert p.id
    return {"project": {"id": p.id, "name": p.name}}


@app.get("/api/projects/{project_id}")
def api_project_get(project_id: int) -> dict:
    p = get_project(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description or "",
        "color_hex": color_to_hex(p.color) if p.color else None,
        "project_tags": get_project_tags(p.id) if p.id else [],
        "source_ids": sfks_to_source_ids(p.source_fks),
        "status": p.status.value,
    }


@app.patch("/api/projects/{project_id}")
def api_project_patch(project_id: int, body: ProjectUpdate) -> dict:
    p = get_project(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    if body.name:
        p.name = body.name.strip()
    if body.description:
        p.description = body.description
    if body.color_hex:
        p.color = color_from_hex(body.color_hex)
    if body.status:
        try:
            p.status = Status(body.status)
        except ValueError as e:
            raise HTTPException(status_code=400, detail="Invalid status") from e
    p.save()
    return {"ok": True}


@app.delete("/api/projects/{project_id}")
def api_project_delete(project_id: int) -> dict:
    p = get_project(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    p.delete()
    return {"ok": True}


class ProjectPaperBody(BaseModel):
    source_id: str = Field(min_length=1)


@app.post("/api/projects/{project_id}/papers")
def api_project_add_paper(project_id: int, body: ProjectPaperBody) -> dict:
    p = get_project(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    root = get_paper_root(body.source_id.strip())
    if root is None:
        raise HTTPException(status_code=404, detail="Paper not found")
    p.add_paper(int(root["SOURCE_FK"]))
    return {"ok": True}


@app.delete("/api/projects/{project_id}/papers/{source_id}")
def api_project_remove_paper(project_id: int, source_id: str) -> dict:
    p = get_project(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    root = get_paper_root(source_id)
    if root is None:
        raise HTTPException(status_code=404, detail="Paper not found")
    p.remove_paper(int(root["SOURCE_FK"]))
    return {"ok": True}


class ArxivSearchBody(BaseModel):
    query: str = Field(min_length=1)
    max_results: int = Field(default=25, ge=1, le=100)
    save: bool = False


@app.post("/api/arxiv/search")
def api_arxiv_search(body: ArxivSearchBody) -> dict:
    try:
        results = search_papers(body.query.strip(), max_results=body.max_results)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    summaries = [_arxiv_result_summary(p) for p in results]
    saved: list[str] = []
    if body.save and results:
        save_papers(results)
        saved = [parse_entry_id(p.entry_id)[0] for p in results]
    return {"results": summaries, "saved_source_ids": saved if body.save else []}

#TODO:RECREATE API to be more efficient, use service layer???
class ArxivFetchBody(BaseModel):
    source_id: str = Field(min_length=1)
    save: bool = True


@app.post("/api/arxiv/fetch")
def api_arxiv_fetch(body: ArxivFetchBody) -> dict:
    try:
        paper = fetch_paper_metadata(body.source_id.strip())
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    pid, _ = parse_entry_id(paper.entry_id)
    if body.save:
        save_paper(paper)
    return {"paper": _arxiv_result_summary(paper), "saved": body.save, "source_id": pid}


class DoiResolveBody(BaseModel):
    doi: str = Field(min_length=1)


@app.post("/api/doi/resolve")
def api_doi_resolve(body: DoiResolveBody) -> dict:
    try:
        meta = resolve_doi(body.doi.strip())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"metadata": meta.model_dump(mode="json")}


class DoiSaveBody(BaseModel):
    doi: str = Field(min_length=1)


@app.post("/api/doi/save")
def api_doi_save(body: DoiSaveBody) -> dict:
    try:
        meta = resolve_doi(body.doi.strip())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    save_paper_metadata(meta)
    return {"metadata": meta.model_dump(mode="json"), "saved": True}


class NoteCreate(BaseModel):
    source_id: str
    project_id: int | None = None
    title: str = ""
    content: str = ""


@app.get("/api/notes")
def api_notes(
    source_id: str,
    project_id: int | None = None,
    all_projects: bool = Query(default=False),
) -> dict:
    root = get_paper_root(source_id)
    if root is None:
        return {"notes": []}
    notes = get_notes(int(root["SOURCE_FK"]), project_id=project_id, all_projects=all_projects)
    return {
        "notes": [
            {
                "id": n.note_id,
                "source_fk": n.source_fk,
                "project_id": n.project_id,
                "title": n.title,
                "content": n.content,
                "created_at": n.created_at.isoformat() if isinstance(n.created_at, datetime.datetime) else n.created_at,
                "updated_at": n.updated_at.isoformat() if isinstance(n.updated_at, datetime.datetime) else n.updated_at,
            }
            for n in notes
        ]
    }


@app.post("/api/notes")
def api_note_create(body: NoteCreate) -> dict:
    source_fk = ensure_paper_root(body.source_id.strip())
    n = Note(
        source_fk=source_fk,
        project_id=body.project_id,
        title=body.title,
        content=body.content,
    )
    n.save()
    return {"id": n.id}


class NoteUpdate(BaseModel):
    title: str | None = None
    content: str | None = None


@app.patch("/api/notes/{note_id}")
def api_note_update(note_id: int, body: NoteUpdate) -> dict:
    details = get_note(note_id)
    if details is None:
        raise HTTPException(status_code=404, detail="Note not found")
    n = Note(
        id=details.note_id,
        source_fk=details.source_fk,
        paper_id_fk=details.paper_id_fk,
        project_id=details.project_id,
        title=body.title if body.title is not None else details.title,
        content=body.content if body.content is not None else details.content,
    )
    n.save()
    return {"ok": True}


@app.delete("/api/notes/{note_id}")
def api_note_delete(note_id: int) -> dict:
    details = get_note(note_id)
    if details is None:
        raise HTTPException(status_code=404, detail="Note not found")
    n = Note(
        id=details.note_id,
        source_fk=details.source_fk,
        paper_id_fk=details.paper_id_fk,
        project_id=details.project_id,
        title=details.title,
        content=details.content,
    )
    n.delete()
    return {"ok": True}


@app.get("/api/settings")
def api_settings_get() -> dict:
    return user_settings.all_settings()


class SettingsUpdate(BaseModel):
    updates: dict


@app.patch("/api/settings")
def api_settings_patch(body: SettingsUpdate) -> dict:
    for key, value in body.updates.items():
        user_settings.set(key, value)
    return {"ok": True}


class EnvUpdate(BaseModel):
    key: str
    value: str


@app.patch("/api/env")
def api_env_patch(body: EnvUpdate) -> dict:
    set_key(str(ENV_PATH), body.key, body.value)
    os.environ[body.key] = body.value
    return {"ok": True}


@app.get("/api/papers/{source_id}/pdf", response_model=None)
def api_paper_pdf(source_id: str, version: int | None = Query(default=None)):
    paper = get_paper_details(Paper(source_id=source_id, version=version))
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    path = _resolve_local_pdf(source_id, version)
    if path:
        return FileResponse(path, media_type="application/pdf", filename=os.path.basename(path))
    if paper.url:
        return RedirectResponse(paper.url)
    raise HTTPException(status_code=404, detail="No PDF available")


# Graph viewer static bundle (used by PyQt, external frontends via iframe/proxy)
app.mount("/assets/graph", StaticFiles(directory=str(GUI_WEB), html=True), name="graph_assets")
