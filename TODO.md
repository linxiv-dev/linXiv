# linxiv TODO

Items flagged during design review. Grouped by area.
Completed items live in DONE.md.

### Paper Detail Deferred
- [ ] **PDF viewing** — verify the current "Open PDF" link actually works (local file + external viewer). If broken, fix it to open local PDFs in the OS native viewer. If behaviour differs between dev and installed, add a Settings toggle. In-app viewer tab is not a decided direction yet.
Minor Bugs
- [ ] OpenAlex searches breaking on certain characters??
## Architecture & Backend Integrity

- [ ] Authors page for editing author details. May require full backend implemetation besides existing author table.
- [ ] **Project create/update missing from service layer** — `service/project.py` handles lifecycle (delete, restore, purge) but has no `create` or `update` function. Both live inline in route handlers in `api/app.py`, including tag-sync coordination (`_sync_project_tags`, `_normalize_tags`). Extract `create(project_in: ProjectIn)` and `update(project_fk, ...)` into the service layer so project mutations are testable without HTTP.

## Deferred
- [ ] Logging in via University Credentials
- [ ] **OpenAlex polite pool `mailto:`** — `_USER_AGENT` in `sources/openalex_source.py` is `"linXiv/1.0"` with no `mailto:` address, so requests hit the unprioritized pool. Should be sourced from user settings when that infrastructure is available.
- [ ] TeX rendering library decision (KaTeX vs MathJax — must be compatible with future Notes Editor)
- [ ] Keyboard shortcut remapping (UX design and defaults TBD before implementation)
- [ ] Notes Editor as optional sidebar page (plugin-tier, off by default)
- [ ] Graph performance: SVG rendering + cluster nodes for large datasets
- [ ] Version monitoring (already kind of exists)/ RSS-style polling for new arXiv versions (separate from opportunistic capture)
- [ ] TeX rendering in result titles and abstracts (library choice TBD — see Deferred)
- [ ] **Notes tab** — simple markdown editor, project scope picker defaulting to navigation context, optional version pin. Not blocked by TeX choice — basic tab is implementable now; TeX rendering inside notes is a later layer. See ADR 0003.
