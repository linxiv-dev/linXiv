# linxiv TODO

Items flagged during design review. Grouped by area.
Completed items live in DONE.md.

## Architecture & Backend Integrity
- [ ] Authors page for editing author details. May require full backend implemetation besides existing author table.
- [ ] **PDF import lifecycle in route handler** — `api/app.py:api_import_pdf` contains ~58 lines of file I/O, DB save, path rename, `has_pdf`/`pdf_path` flag updates, rollback on failure, and project linking inline in the route. Extract to `service/paper.py` as `import_pdf(content: bytes, project_id: int | None) -> PaperImportResult`; route becomes a 5-line delegate. Matches the async groundwork already in place.
- [ ] **Project create/update missing from service layer** — `service/project.py` handles lifecycle (delete, restore, purge) but has no `create` or `update` function. Both live inline in route handlers in `api/app.py`, including tag-sync coordination (`_sync_project_tags`, `_normalize_tags`). Extract `create(project_in: ProjectIn)` and `update(project_fk, ...)` into the service layer so project mutations are testable without HTTP.

## Deferred
- [ ] **OpenAlex polite pool `mailto:`** — `_USER_AGENT` in `sources/openalex_source.py` is `"linXiv/1.0"` with no `mailto:` address, so requests hit the unprioritized pool. Should be sourced from user settings when that infrastructure is available.
- [ ] TeX rendering library decision (KaTeX vs MathJax — must be compatible with future Notes Editor)
- [ ] Keyboard shortcut remapping (UX design and defaults TBD before implementation)
- [ ] Notes Editor as optional sidebar page (plugin-tier, off by default)
- [ ] Graph performance: SVG rendering + cluster nodes for large datasets
- [ ] Version monitoring / RSS-style polling for new arXiv versions (separate from opportunistic capture)

### Paper Detail Deferred
- [ ] In-app PDF viewer tab (currently only "Open PDF" external link + download)
- [ ] TeX rendering in result titles and abstracts (library choice TBD — see Deferred)
- [ ] Notes tab: markdown editor, project scope picker defaulting to navigation context, optional version pin. Blocked by choice of latex renderer
