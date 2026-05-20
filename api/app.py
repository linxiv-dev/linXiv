"""FastAPI JSON API for linXiv (backend only — UI lives in separate clients)."""

from __future__ import annotations

import datetime
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

from config import ENV_PATH, data_dir, resources_dir
load_dotenv(ENV_PATH)

import arxiv
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.background import BackgroundTasks
from dotenv import set_key
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
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
from sources.pdf_metadata import resolve_pdf_metadata
from sources.openalex_source import OpenAlexSource
from formats.bibtex import BibTeXFormat
from formats.markdown import ObsidianFormat
from service.paper import (
    set_has_pdf_by_source,
    Paper,
    ensure_paper_root,
    get as get_paper_details,
    get_paper_root,
    list_paper_details,
    list_deleted as list_deleted_papers,
    delete as soft_delete_paper,
    restore as restore_paper,
    hard_delete as hard_delete_paper,
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


@app.get("/api/papers/sfk/{source_fk}")
def api_get_paper_by_sfk(source_fk: int) -> dict:
    paper = get_paper_details(Paper(source_fk=source_fk))
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")
    return paper.to_dict()


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


# ── Search history / state ────────────────────────────────────────────────────

import storage.search_history as _search_history
import storage.search_state as _search_state


@app.get("/api/search/history")
def api_search_history(prefix: str = Query(default="", min_length=0), limit: int = Query(default=10, ge=1, le=50)) -> dict:
    suggestions = _search_history.get_suggestions(prefix, limit)
    return {"suggestions": suggestions}


class SearchStateBody(BaseModel):
    clauses: list[dict] = Field(default_factory=list)
    source: str = Field(default="arxiv")
    max_results: int = Field(default=25)
    results: list[dict] = Field(default_factory=list)
    saved_ids: list[str] = Field(default_factory=list)


@app.get("/api/search/state")
def api_search_state_get() -> dict:
    state = _search_state.load_state()
    if state is None:
        return {"state": None}
    return {"state": state}


@app.post("/api/search/state")
def api_search_state_save(body: SearchStateBody) -> dict:
    # Record each non-empty clause term to history.
    for clause in body.clauses:
        term = clause.get("value", "")
        if isinstance(term, str) and term.strip():
            _search_history.add_term(term)
    _search_state.save_state(
        clauses=body.clauses,
        source=body.source,
        max_results=body.max_results,
        results=body.results,
        saved_ids=body.saved_ids,
    )
    return {"ok": True}

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
# ── Trash (soft-delete) ───────────────────────────────────────────────────────

@app.get("/api/trash")
def api_trash_list() -> dict:
    deleted = list_deleted_papers()
    return {
        "papers": [
            {
                "source_fk": d.source_fk,
                "source_id": d.source_id,
                "title": d.title,
                "authors": d.authors,
                "published": d.published.isoformat() if d.published else None,
                "deleted_at": d.deleted_at.isoformat() if d.deleted_at else None,
                "had_pdf": d.had_pdf,
            }
            for d in deleted
        ]
    }


@app.post("/api/trash/{source_id}/restore")
def api_trash_restore(source_id: str) -> dict:
    pdf_path, project_fks = restore_paper(Paper(source_id=source_id))
    return {"ok": True, "pdf_path": pdf_path, "project_fks": project_fks}


@app.delete("/api/trash/{source_id}")
def api_trash_hard_delete(source_id: str) -> dict:
    hard_delete_paper(Paper(source_id=source_id))
    return {"ok": True}


@app.delete("/api/papers/{source_id}/soft")
def api_paper_soft_delete(source_id: str) -> dict:
    soft_delete_paper(Paper(source_id=source_id))
    return {"ok": True}


# ── OpenAlex search ───────────────────────────────────────────────────────────

class OpenAlexSearchBody(BaseModel):
    query: str = Field(min_length=1)
    max_results: int = Field(default=25, ge=1, le=100)


@app.post("/api/openalex/search")
def api_openalex_search(body: OpenAlexSearchBody) -> dict:
    try:
        results = OpenAlexSource().search(body.query.strip(), max_results=body.max_results)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {
        "results": [
            {
                "source_id": m.source_id,
                "version": m.version,
                "title": m.title,
                "summary": m.summary,
                "authors": m.authors,
                "published": m.published.isoformat() if m.published else None,
                "doi": m.doi,
                "url": m.url,
                "primary_category": m.category,
                "entry_id": m.source_id,
            }
            for m in results
        ]
    }


# ── Export / Import ───────────────────────────────────────────────────────────

import tempfile
import shutil
from service import export_import as _export_import


class ExportBody(BaseModel):
    project_id: int
    include_pdfs: bool = False
    dest_path: str | None = None


@app.post("/api/projects/{project_id}/export", response_model=None)
def api_project_export(
    project_id: int,
    body: ExportBody,
    background: BackgroundTasks,
) -> FileResponse | dict:
    if body.dest_path:
        dest = Path(body.dest_path)
        try:
            _export_import.export_project(
                project_id,
                dest_path=dest.parent / dest.stem,
                include_pdfs=body.include_pdfs,
            )
        except ValueError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        return {"ok": True}
    tmp_dir = Path(tempfile.mkdtemp())
    try:
        out = _export_import.export_project(
            project_id,
            dest_path=tmp_dir / "export",
            include_pdfs=body.include_pdfs,
        )
    except ValueError as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(e)) from e
    background.add_task(shutil.rmtree, tmp_dir, True)
    return FileResponse(
        path=str(out),
        filename=out.name,
        media_type="application/zip",
    )


@app.post("/api/projects/import/preview")
async def api_import_preview(file: UploadFile = File(...)) -> dict:
    tmp = Path(tempfile.mktemp(suffix=".lxproj"))
    try:
        content = await file.read()
        tmp.write_bytes(content)
        preview = _export_import.preview_import(tmp)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    finally:
        tmp.unlink(missing_ok=True)
    return {
        "project_name": preview.project_name,
        "description": preview.description,
        "paper_count": preview.paper_count,
        "note_count": preview.note_count,
        "has_pdfs": preview.has_pdfs,
        "format_version": preview.format_version,
    }


@app.post("/api/projects/import/commit")
async def api_import_commit(
    file: UploadFile = File(...),
    on_conflict: str = Query(default="merge", pattern="^(merge|overwrite)$"),
) -> dict:
    tmp = Path(tempfile.mktemp(suffix=".lxproj"))
    try:
        content = await file.read()
        tmp.write_bytes(content)
        project_fk = _export_import.commit_import(
            tmp, on_conflict=on_conflict  # type: ignore[arg-type]
        )
    except _export_import.ProjectImportError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    finally:
        tmp.unlink(missing_ok=True)
    return {"project_id": project_fk}


# ── Plain-text export helpers ─────────────────────────────────────────────────

def _plain_export(project_id: int, fmt_obj: object, media_type: str, ext: str) -> PlainTextResponse:
    p = get_project(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="Project not found")
    ids = set(sfks_to_source_ids(p.source_fks))
    project_papers = [
        pp.to_dict() for pp in list_paper_details(latest_only=True)
        if pp.source_id in ids
    ]
    safe_name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in (p.name or "project"))
    return PlainTextResponse(
        content=fmt_obj.export_papers(project_papers),  # type: ignore[union-attr]
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.{ext}"'},
    )


@app.get("/api/projects/{project_id}/export/bibtex", response_model=None)
def api_project_export_bibtex(
    project_id: int,
    dest_path: str | None = Query(default=None),
) -> PlainTextResponse | dict:
    if dest_path:
        p = get_project(project_id)
        if not p:
            raise HTTPException(status_code=404, detail="Project not found")
        ids = set(sfks_to_source_ids(p.source_fks))
        papers = [pp.to_dict() for pp in list_paper_details(latest_only=True) if pp.source_id in ids]
        Path(dest_path).write_text(BibTeXFormat().export_papers(papers), encoding="utf-8")
        return {"ok": True}
    return _plain_export(project_id, BibTeXFormat(), "text/x-bibtex", "bib")


@app.get("/api/projects/{project_id}/export/obsidian", response_model=None)
def api_project_export_obsidian(
    project_id: int,
    dest_path: str | None = Query(default=None),
) -> PlainTextResponse | dict:
    if dest_path:
        p = get_project(project_id)
        if not p:
            raise HTTPException(status_code=404, detail="Project not found")
        ids = set(sfks_to_source_ids(p.source_fks))
        papers = [pp.to_dict() for pp in list_paper_details(latest_only=True) if pp.source_id in ids]
        Path(dest_path).write_text(ObsidianFormat().export_papers(papers), encoding="utf-8")
        return {"ok": True}
    return _plain_export(project_id, ObsidianFormat(), "text/markdown", "md")


@app.post("/api/papers/import/bibtex")
async def api_import_bibtex(
    file: UploadFile = File(...),
    project_id: int | None = Query(default=None),
) -> dict:
    text = (await file.read()).decode("utf-8", errors="replace")
    try:
        metas = BibTeXFormat().import_string(text)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"BibTeX parse error: {e}") from e
    saved: list[str] = []
    for meta in metas:
        save_paper_metadata(meta)
        saved.append(meta.source_id)
    if project_id and saved:
        proj = get_project(project_id)
        if proj:
            for sid in saved:
                root = get_paper_root(sid)
                if root:
                    proj.add_paper(int(root["SOURCE_FK"]))
    return {"saved_count": len(saved), "source_ids": saved}


# ── PDF import ────────────────────────────────────────────────────────────────

@app.post("/api/papers/import/pdf")
async def api_import_pdf(
    file: UploadFile = File(...),
    project_id: int | None = Query(default=None),
) -> dict:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="File must be a PDF")
    content = await file.read()
    tmp_path = PDF_DIR / f"_upload_{uuid.uuid4().hex}.pdf"
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    try:
        tmp_path.write_bytes(content)
        try:
            meta = resolve_pdf_metadata(str(tmp_path))
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Could not extract PDF metadata: {e}") from e
        save_paper_metadata(meta)
        source_id = meta.source_id
        version = meta.version
        title = meta.title
        final_path = PDF_DIR / f"{source_id}v{version}.pdf"
        tmp_path.rename(final_path)
        set_has_pdf_by_source(source_id, True)
        if project_id:
            proj = get_project(project_id)
            if proj:
                root = get_paper_root(source_id)
                if root:
                    proj.add_paper(int(root["SOURCE_FK"]))
    except HTTPException:
        tmp_path.unlink(missing_ok=True)
        raise
    except Exception as e:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"source_id": source_id, "title": title}


# ── OpenAlex save ─────────────────────────────────────────────────────────────

class OpenAlexSaveBody(BaseModel):
    source_id: str = Field(min_length=1)


@app.post("/api/openalex/save")
def api_openalex_save(body: OpenAlexSaveBody) -> dict:
    try:
        meta = OpenAlexSource().fetch_by_id(body.source_id.strip())
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    save_paper_metadata(meta)
    return {"saved": True, "source_id": meta.source_id}


