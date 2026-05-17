"""Headless CLI for linXiv — search, fetch, list, tag, and manage projects without the GUI."""

from __future__ import annotations

from dotenv import load_dotenv
from config import ENV_PATH
load_dotenv(ENV_PATH)

import argparse
import dataclasses
from importlib.metadata import version, PackageNotFoundError
import json
from pathlib import Path
import re
import sys
from typing import Any

try:
    __version__ = version("linxiv")
except PackageNotFoundError:
    __version__ = "unknown"

from sources.arxiv_source import ArxivSource
from sources.base import PaperMetadata, PaperSource
from sources.crossref_source import CrossRefSource
from sources.openalex_source import OpenAlexSource

import service.paper as svc_paper
import service.tag as svc_tag
import service.project as svc_project
import service.note as svc_note
import service.files as svc_files
import service.export_import as svc_ei
from service.export_import import ProjectImportError
from service.paper import Paper
from service.tag import Tag, TagIn
from service.project import Project, Projects, ProjectIn, Status
from service.note import Note, Notes, NoteIn

_FORMATS_DIR = Path(__file__).parent / "formats"

_ARXIV_ID_RE = re.compile(r"^\d{4}\.\d{4,5}(v\d+)?$|^[a-z\-]+(\.[A-Z]{2})?/\d{7}(v\d+)?$")


def _validate_arxiv_id(source_id: str) -> str:
    if not _ARXIV_ID_RE.match(source_id):
        print(json.dumps({"error": f"Invalid arXiv ID format: {source_id!r}"}), file=sys.stderr)
        sys.exit(1)
    return source_id


def _as_source_id(raw: str, source: str = "arxiv") -> str:
    """Prefix a bare paper ID with its namespace; already-prefixed IDs are returned unchanged."""
    return raw if ":" in raw else f"{source}:{raw}"


def _render_paper(meta: PaperMetadata) -> str | None:
    template_path = _FORMATS_DIR / f"{meta.source}_paper.md"
    if not template_path.exists():
        return None
    template = template_path.read_text(encoding="utf-8")
    data = meta.model_dump(mode="json")
    data["authors_inline"] = ", ".join(meta.authors)
    return template.format_map(data)


_SOURCES: dict[str, type[PaperSource]] = {
    "arxiv":    ArxivSource,
    "openalex": OpenAlexSource,
    "crossref": CrossRefSource,
}


def _source_for(name: str) -> PaperSource:
    cls = _SOURCES.get(name)
    if cls is None:
        raise ValueError(f"Unknown source {name!r}. Available: {list(_SOURCES)}")
    return cls()


def _output(data: Any) -> None:
    json.dump(data, sys.stdout, indent=2, default=str)
    sys.stdout.write("\n")


def _details_to_dict(obj: Any) -> dict[str, Any]:
    return dataclasses.asdict(obj)


def _resolve_paper_or_exit(source_id: str) -> Any:
    details = svc_paper.get(Paper(source_id=source_id))
    if details is None:
        print(json.dumps({"error": f"Paper {source_id!r} not found in DB"}), file=sys.stderr)
        sys.exit(1)
    return details


def _resolve_project_or_exit(project_id: int) -> Any:
    details = svc_project.get(Project(project_fk=project_id))
    if details is None:
        print(json.dumps({"error": f"Project {project_id} not found"}), file=sys.stderr)
        sys.exit(1)
    return details


# ---------------------------------------------------------------------------
# Commands — search / fetch / list
# ---------------------------------------------------------------------------

def cmd_search(args: argparse.Namespace) -> None:
    source = _source_for(args.source)
    try:
        results = source.search(args.query, max_results=args.max)
    except Exception as e:
        print(f"[search] {e}", file=sys.stderr)
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
    _output([m.model_dump(mode="json") for m in results])


def cmd_fetch(args: argparse.Namespace) -> None:
    if args.source == "arxiv":
        _validate_arxiv_id(args.source_id)
    source = _source_for(args.source)
    try:
        meta = source.fetch_by_id(args.source_id)
    except Exception as e:
        print(f"[fetch] {e}", file=sys.stderr)
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
    svc_paper.save_paper_metadata(meta, None)
    rendered = _render_paper(meta)
    if rendered:
        sys.stdout.write(rendered + "\n")
    else:
        _output(meta.model_dump(mode="json"))


def cmd_list(args: argparse.Namespace) -> None:
    rows = svc_paper.list_papers(limit=args.limit, offset=args.offset)
    papers = [{k: row[k] for k in row.keys()} for row in rows]
    if args.category:
        papers = [p for p in papers if p.get("category") == args.category]
    _output(papers)


# ---------------------------------------------------------------------------
# Commands — paper subgroup
# ---------------------------------------------------------------------------

def cmd_paper_get(args: argparse.Namespace) -> None:
    source_id = _as_source_id(args.source_id)
    details = _resolve_paper_or_exit(source_id)
    _output(_details_to_dict(details))


def cmd_paper_delete(args: argparse.Namespace) -> None:
    source_id = _as_source_id(args.source_id)
    _resolve_paper_or_exit(source_id)
    svc_paper.delete_paper(source_id)
    _output({"deleted": source_id})


def cmd_paper_versions(args: argparse.Namespace) -> None:
    source_id = _as_source_id(args.source_id)
    all_versions = svc_paper.get_all(Paper(source_id=source_id))
    if all_versions is None:
        print(json.dumps({"error": f"Paper {source_id!r} not found in DB"}), file=sys.stderr)
        sys.exit(1)
    _output(_details_to_dict(all_versions))


# ---------------------------------------------------------------------------
# Commands — tag subgroup
# ---------------------------------------------------------------------------

def cmd_tag_add(args: argparse.Namespace) -> None:
    source_id = _as_source_id(args.source_id)
    try:
        updated = svc_tag.add_paper_tags(source_id, args.tags)
    except KeyError:
        print(json.dumps({"error": f"Paper {source_id} not found in DB"}), file=sys.stderr)
        sys.exit(1)
    _output({"source_id": source_id, "tags": updated})


def cmd_tag_remove(args: argparse.Namespace) -> None:
    source_id = _as_source_id(args.source_id)
    try:
        updated = svc_tag.remove_paper_tags(source_id, args.tags)
    except KeyError:
        print(json.dumps({"error": f"Paper {source_id} not found in DB"}), file=sys.stderr)
        sys.exit(1)
    _output({"source_id": source_id, "tags": updated})


def cmd_tag_list(args: argparse.Namespace) -> None:
    source_id = _as_source_id(args.source_id)
    tags = svc_tag.get_paper_tags(source_id)
    _output({"source_id": source_id, "tags": tags})


def cmd_tag_list_all(args: argparse.Namespace) -> None:
    _output(svc_tag.list_all_tags())


def cmd_tag_create(args: argparse.Namespace) -> None:
    tag_id = svc_tag.upsert(TagIn(label=args.label))
    _output({"tag_id": tag_id, "label": args.label})


def cmd_tag_delete(args: argparse.Namespace) -> None:
    svc_tag.delete(Tag(tag_id=args.tag_id))
    _output({"deleted_tag_id": args.tag_id})


# ---------------------------------------------------------------------------
# Commands — project subgroup
# ---------------------------------------------------------------------------

def cmd_project_list(args: argparse.Namespace) -> None:
    status = Status(args.status) if args.status else None
    projects = svc_project.get_many(Projects(status=status))
    if status is None:
        projects = [p for p in projects if p.status != Status.DELETED]
    _output([{
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "status": p.status.value,
        "paper_count": len(p.source_fks),
        "color": p.color,
        "project_tags": p.project_tags,
    } for p in projects])


def cmd_project_get(args: argparse.Namespace) -> None:
    details = _resolve_project_or_exit(args.project_id)
    _output(_details_to_dict(details))


def cmd_project_create(args: argparse.Namespace) -> None:
    fk = svc_project.upsert(ProjectIn(name=args.name, description=args.description or ""))
    _output({"id": fk, "name": args.name, "status": "active"})


def cmd_project_update(args: argparse.Namespace) -> None:
    details = _resolve_project_or_exit(args.project_id)
    svc_project.upsert(ProjectIn(
        name=args.name if args.name is not None else details.name,
        description=args.description if args.description is not None else details.description,
        color=details.color,
        tags=details.project_tags,
        source_fks=details.source_fks,
    ), project_fk=args.project_id)
    updated = svc_project.get(Project(project_fk=args.project_id))
    _output(_details_to_dict(updated))


def cmd_project_delete(args: argparse.Namespace) -> None:
    _resolve_project_or_exit(args.project_id)
    svc_project.delete(Project(project_fk=args.project_id))
    _output({"deleted_project_id": args.project_id})


def cmd_project_add_paper(args: argparse.Namespace) -> None:
    source_id = _as_source_id(args.source_id)
    details = _resolve_project_or_exit(args.project_id)
    root = svc_paper.get_paper_root(source_id)
    if root is None:
        print(json.dumps({"error": f"Paper {source_id} not found in database"}), file=sys.stderr)
        sys.exit(1)
    source_fk = int(root["SOURCE_FK"])
    if source_fk not in details.source_fks:
        svc_project.upsert(ProjectIn(
            name=details.name,
            description=details.description,
            color=details.color,
            tags=details.project_tags,
            source_fks=details.source_fks + [source_fk],
        ), project_fk=args.project_id)
    _output({"project_id": args.project_id, "source_id": source_id})


def cmd_project_remove_paper(args: argparse.Namespace) -> None:
    source_id = _as_source_id(args.source_id)
    details = _resolve_project_or_exit(args.project_id)
    root = svc_paper.get_paper_root(source_id)
    if root is None:
        print(json.dumps({"error": f"Paper {source_id} not found in database"}), file=sys.stderr)
        sys.exit(1)
    source_fk = int(root["SOURCE_FK"])
    svc_project.upsert(ProjectIn(
        name=details.name,
        description=details.description,
        color=details.color,
        tags=details.project_tags,
        source_fks=[fk for fk in details.source_fks if fk != source_fk],
    ), project_fk=args.project_id)
    _output({"project_id": args.project_id, "source_id": source_id, "removed": True})


# ---------------------------------------------------------------------------
# Commands — project export / import
# ---------------------------------------------------------------------------

def cmd_project_export(args: argparse.Namespace) -> None:
    try:
        out = svc_ei.export_project(args.project_id, Path(args.dest), include_pdfs=args.pdfs)
    except Exception as e:
        print(f"[export] {e}", file=sys.stderr)
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
    _output({"path": str(out), "project_id": args.project_id})


def cmd_project_import(args: argparse.Namespace) -> None:
    zip_path = Path(args.zip_path)
    if args.preview:
        try:
            preview = svc_ei.preview_import(zip_path)
        except Exception as e:
            print(f"[import] {e}", file=sys.stderr)
            print(json.dumps({"error": str(e)}), file=sys.stderr)
            sys.exit(1)
        _output(_details_to_dict(preview))
    else:
        try:
            fk = svc_ei.commit_import(zip_path, on_conflict=args.on_conflict)
        except (ProjectImportError, Exception) as e:
            print(f"[import] {e}", file=sys.stderr)
            print(json.dumps({"error": str(e)}), file=sys.stderr)
            sys.exit(1)
        _output({"project_id": fk})


# ---------------------------------------------------------------------------
# Commands — note subgroup
# ---------------------------------------------------------------------------

def cmd_note_create(args: argparse.Namespace) -> None:
    source_id = _as_source_id(args.source_id)
    root = svc_paper.get_paper_root(source_id)
    if root is None:
        print(json.dumps({"error": f"Paper {source_id} not found in DB"}), file=sys.stderr)
        sys.exit(1)
    source_fk = int(root["SOURCE_FK"])
    note_id = svc_note.upsert(NoteIn(
        source_fk=source_fk,
        title=args.title or "",
        content=args.content,
        project_fk=args.project_id,
    ))
    _output({"id": note_id, "source_fk": source_fk, "project_id": args.project_id, "title": args.title or ""})


def cmd_note_get(args: argparse.Namespace) -> None:
    details = svc_note.get(Note(note_id=args.note_id))
    if details is None:
        print(json.dumps({"error": f"Note {args.note_id} not found"}), file=sys.stderr)
        sys.exit(1)
    _output(_details_to_dict(details))


def cmd_note_list(args: argparse.Namespace) -> None:
    source_fk = None
    if args.source_id is not None:
        sid = _as_source_id(args.source_id)
        root = svc_paper.get_paper_root(sid)
        if root is None:
            print(json.dumps({"error": f"Paper {sid!r} not found in DB"}), file=sys.stderr)
            sys.exit(1)
        source_fk = int(root["SOURCE_FK"])
    notes = svc_note.get_many(Notes(source_fk=source_fk, project_fk=args.project_id))
    _output([_details_to_dict(n) for n in notes])


def cmd_note_delete(args: argparse.Namespace) -> None:
    details = svc_note.get(Note(note_id=args.note_id))
    if details is None:
        print(json.dumps({"error": f"Note {args.note_id} not found"}), file=sys.stderr)
        sys.exit(1)
    svc_note.delete(Note(note_id=args.note_id))
    _output({"deleted_note_id": args.note_id})


# ---------------------------------------------------------------------------
# Commands — pdf subgroup
# ---------------------------------------------------------------------------

def cmd_pdf_path(args: argparse.Namespace) -> None:
    paper = _resolve_paper_or_exit(_as_source_id(args.source_id))
    version = args.version if args.version is not None else paper.version
    path = svc_files.pdf_path(paper.source_id, version, paper.pdf_path)
    _output({"source_id": args.source_id, "version": version, "path": path})


def cmd_pdf_download(args: argparse.Namespace) -> None:
    paper = _resolve_paper_or_exit(_as_source_id(args.source_id))
    version = args.version if args.version is not None else paper.version
    try:
        path = svc_files.download_pdf(paper.source_id, version, args.url)
    except Exception as e:
        print(f"[pdf] {e}", file=sys.stderr)
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
    if path is None:
        print(json.dumps({"error": "Download failed"}), file=sys.stderr)
        sys.exit(1)
    _output({"source_id": args.source_id, "version": version, "path": path})


def cmd_pdf_storage(args: argparse.Namespace) -> None:
    mb = svc_files.pdf_storage_mb()
    _output({"storage_mb": round(mb, 3), "pdf_dir": svc_files.managed_pdf_dir()})


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="linxiv", description="linXiv headless CLI")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    _source_choices = list(_SOURCES)

    # search
    p_search = sub.add_parser("search", help="Search for papers")
    p_search.add_argument("query", help="Search query string")
    p_search.add_argument("--source", choices=_source_choices, default="arxiv")
    p_search.add_argument("--max", type=int, default=10, help="Max results")
    p_search.set_defaults(func=cmd_search)

    # fetch
    p_fetch = sub.add_parser("fetch", help="Fetch and save a paper by ID")
    p_fetch.add_argument("source_id", help="Paper ID (e.g. 2204.12985 or W3123456789)")
    p_fetch.add_argument("--source", choices=_source_choices, default="arxiv")
    p_fetch.set_defaults(func=cmd_fetch)

    # list
    p_list = sub.add_parser("list", help="List papers in the database")
    p_list.add_argument("--limit", type=int, default=None, help="Max papers to return")
    p_list.add_argument("--offset", type=int, default=0, help="Offset for pagination")
    p_list.add_argument("--category", type=str, default=None, help="Filter by category")
    p_list.set_defaults(func=cmd_list)

    # paper
    p_paper = sub.add_parser("paper", help="Manage individual papers")
    paper_sub = p_paper.add_subparsers(dest="paper_command", required=True)

    p_paper_get = paper_sub.add_parser("get", help="Get full details for a paper")
    p_paper_get.add_argument("source_id", help="Paper source ID")
    p_paper_get.set_defaults(func=cmd_paper_get)

    p_paper_del = paper_sub.add_parser("delete", help="Delete a paper from the database")
    p_paper_del.add_argument("source_id", help="Paper source ID")
    p_paper_del.set_defaults(func=cmd_paper_delete)

    p_paper_ver = paper_sub.add_parser("versions", help="List all stored versions of a paper")
    p_paper_ver.add_argument("source_id", help="Paper source ID")
    p_paper_ver.set_defaults(func=cmd_paper_versions)

    # tag
    p_tag = sub.add_parser("tag", help="Manage tags")
    tag_sub = p_tag.add_subparsers(dest="tag_command", required=True)

    p_tag_add = tag_sub.add_parser("add", help="Add tags to a paper")
    p_tag_add.add_argument("source_id", help="Paper source ID")
    p_tag_add.add_argument("tags", nargs="+", help="Tags to add")
    p_tag_add.set_defaults(func=cmd_tag_add)

    p_tag_remove = tag_sub.add_parser("remove", help="Remove tags from a paper")
    p_tag_remove.add_argument("source_id", help="Paper source ID")
    p_tag_remove.add_argument("tags", nargs="+", help="Tags to remove")
    p_tag_remove.set_defaults(func=cmd_tag_remove)

    p_tag_list = tag_sub.add_parser("list", help="List tags on a paper")
    p_tag_list.add_argument("source_id", help="Paper source ID")
    p_tag_list.set_defaults(func=cmd_tag_list)

    p_tag_list_all = tag_sub.add_parser("list-all", help="List all tags in the database")
    p_tag_list_all.set_defaults(func=cmd_tag_list_all)

    p_tag_create = tag_sub.add_parser("create", help="Create a tag")
    p_tag_create.add_argument("label", help="Tag label")
    p_tag_create.set_defaults(func=cmd_tag_create)

    p_tag_delete = tag_sub.add_parser("delete", help="Delete a tag by ID")
    p_tag_delete.add_argument("tag_id", type=int, help="Tag ID")
    p_tag_delete.set_defaults(func=cmd_tag_delete)

    # project
    p_proj = sub.add_parser("project", help="Manage projects")
    proj_sub = p_proj.add_subparsers(dest="project_command", required=True)

    p_proj_list = proj_sub.add_parser("list", help="List projects")
    p_proj_list.add_argument("--status", choices=["active", "archived", "deleted"], default=None)
    p_proj_list.set_defaults(func=cmd_project_list)

    p_proj_get = proj_sub.add_parser("get", help="Get project details")
    p_proj_get.add_argument("project_id", type=int, help="Project ID")
    p_proj_get.set_defaults(func=cmd_project_get)

    p_proj_create = proj_sub.add_parser("create", help="Create a project")
    p_proj_create.add_argument("name", help="Project name")
    p_proj_create.add_argument("--description", default="", help="Project description")
    p_proj_create.set_defaults(func=cmd_project_create)

    p_proj_update = proj_sub.add_parser("update", help="Update project name or description")
    p_proj_update.add_argument("project_id", type=int, help="Project ID")
    p_proj_update.add_argument("--name", default=None, help="New name")
    p_proj_update.add_argument("--description", default=None, help="New description")
    p_proj_update.set_defaults(func=cmd_project_update)

    p_proj_delete = proj_sub.add_parser("delete", help="Delete a project")
    p_proj_delete.add_argument("project_id", type=int, help="Project ID")
    p_proj_delete.set_defaults(func=cmd_project_delete)

    p_proj_add = proj_sub.add_parser("add-paper", help="Add a paper to a project")
    p_proj_add.add_argument("project_id", type=int, help="Project ID")
    p_proj_add.add_argument("source_id", help="Paper source ID")
    p_proj_add.set_defaults(func=cmd_project_add_paper)

    p_proj_rem = proj_sub.add_parser("remove-paper", help="Remove a paper from a project")
    p_proj_rem.add_argument("project_id", type=int, help="Project ID")
    p_proj_rem.add_argument("source_id", help="Paper source ID")
    p_proj_rem.set_defaults(func=cmd_project_remove_paper)

    p_proj_export = proj_sub.add_parser("export", help="Export a project to a .lxproj archive")
    p_proj_export.add_argument("project_id", type=int, help="Project ID")
    p_proj_export.add_argument("dest", help="Destination path (.lxproj extension added automatically)")
    p_proj_export.add_argument("--pdfs", action="store_true", default=False,
                               help="Include bundled PDFs in the archive")
    p_proj_export.set_defaults(func=cmd_project_export)

    p_proj_import = proj_sub.add_parser("import", help="Import a project from a .lxproj archive")
    p_proj_import.add_argument("zip_path", help="Path to .lxproj archive")
    p_proj_import.add_argument("--preview", action="store_true", default=False,
                               help="Show archive summary without modifying the database")
    p_proj_import.add_argument("--on-conflict", choices=["merge", "overwrite"], default="merge",
                               dest="on_conflict",
                               help="How to handle papers that already exist (default: merge)")
    p_proj_import.set_defaults(func=cmd_project_import)

    # note
    p_note = sub.add_parser("note", help="Manage notes")
    note_sub = p_note.add_subparsers(dest="note_command", required=True)

    p_note_create = note_sub.add_parser("create", help="Create a note on a paper")
    p_note_create.add_argument("source_id", help="Paper source ID")
    p_note_create.add_argument("content", help="Note body text")
    p_note_create.add_argument("--title", default="", help="Note title")
    p_note_create.add_argument("--project-id", type=int, dest="project_id", default=None,
                               help="Associate note with a project")
    p_note_create.set_defaults(func=cmd_note_create)

    p_note_get = note_sub.add_parser("get", help="Get a note by ID")
    p_note_get.add_argument("note_id", type=int, help="Note ID")
    p_note_get.set_defaults(func=cmd_note_get)

    p_note_list = note_sub.add_parser("list", help="List notes")
    p_note_list.add_argument("--paper-id", dest="source_id", default=None,
                             help="Filter by paper source ID")
    p_note_list.add_argument("--project-id", type=int, dest="project_id", default=None,
                             help="Filter by project ID")
    p_note_list.set_defaults(func=cmd_note_list)

    p_note_del = note_sub.add_parser("delete", help="Delete a note by ID")
    p_note_del.add_argument("note_id", type=int, help="Note ID")
    p_note_del.set_defaults(func=cmd_note_delete)

    # pdf
    p_pdf = sub.add_parser("pdf", help="Manage PDFs")
    pdf_sub = p_pdf.add_subparsers(dest="pdf_command", required=True)

    p_pdf_path = pdf_sub.add_parser("path", help="Show local PDF path for a paper")
    p_pdf_path.add_argument("source_id", help="Paper source ID")
    p_pdf_path.add_argument("--version", type=int, default=None,
                            help="Paper version (defaults to latest)")
    p_pdf_path.set_defaults(func=cmd_pdf_path)

    p_pdf_dl = pdf_sub.add_parser("download", help="Download PDF for a paper")
    p_pdf_dl.add_argument("source_id", help="Paper source ID")
    p_pdf_dl.add_argument("url", help="PDF download URL")
    p_pdf_dl.add_argument("--version", type=int, default=None,
                          help="Paper version (defaults to latest)")
    p_pdf_dl.set_defaults(func=cmd_pdf_download)

    p_pdf_storage = pdf_sub.add_parser("storage", help="Report total PDF storage usage")
    p_pdf_storage.set_defaults(func=cmd_pdf_storage)

    return parser


def main(argv: list[str] | None = None) -> None:
    svc_paper.init_db()
    svc_project.ensure_projects_db()
    svc_note.ensure_notes_db()
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
