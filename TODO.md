# linxiv TODO

Items flagged during design review. Grouped by area.

## Search
- [x] Per-source sort options (arXiv: relevance / date / last-updated; OpenAlex: its own sort fields)
- [x] `+` append button adjacent to Search button (adds to working set instead of replacing)
- [x] `search_history` table + autocomplete dropdown on clause input (shows matches after 1 char)
- [x] `search_results` persistence table; Search page restores from it on mount
- [x] Remove Search from keep-alive in AppShell once db restore is in place
- [ ] TeX rendering in result titles and abstracts (library choice TBD — see Deferred)
- [x] Query builder like in original gui
## Library
- [x] Virtual scrolling for paper list (expected scale: thousands of papers)
- [x] Paper Metadata Editor — shared create/edit form; port field set from PyQt, do not redesign
- [x] postMessage bridge: selected PaperCard source_fks → parent app → Add to Project flow

## Paper Detail
- [x] Restore-from-trash "keep in projects?" prompt — API + frontend dialog complete (`KeepInProjectsDialog` in SettingsPage, `removeFromAllProjects` wired)
- [ ] In-app PDF viewer tab (currently only "Open PDF" external link + download)
- [x] Version selector in header (switch between stored versions — selector in meta row, edit/download gated to latest)
- [ ] Diff view between any two stored versions (deferred)
- [ ] Subtle version-awareness indicators in GUI: library badge, new-version nudge, fetch-missing action
- [ ] Notes tab: markdown editor, project scope picker defaulting to navigation context, optional version pin. Blocked by choice of latex renderer

## Graph
- [ ] postMessage bridge: selected node IDs → parent app → Export flow
- [ ] postMessage bridge: selected node IDs → parent app → Add to Project flow

## Projects
- [x] Project status UI: active / archived / deleted (three-state, not two)
- [x] Archived projects view (hidden from main list, accessible separately)
- [x] Deleted projects surfaced in Settings trash panel alongside deleted papers (30-day auto-purge on startup)
- [x] Project tags UI (create, assign, display)
- [x] ProjectCard (ProjectsPage list): Archive and Delete are first-class card buttons 
- [x] move into `···` **context menu** or right-click context menu (same treatment applied to ProjectDetailPage header)

## Tags
- [x] Clickable tag links everywhere they appear (paper cards, project cards, graph nodes)
- [x] Tag View page: papers tagged directly + projects tagged + papers in those projects
- [x] Tags sidebar entry (off by default, togglable in Settings)

## Sidebar
- [x] Configurable optional page toggles in Settings (Graph, Search, DOI Lookup on by default; Tags, Notes Editor off by default)

## Bugs
- [x] Dialog component (`src/components/ui/dialog.tsx`): content overflows the modal boundary, clipping buttons at the right edge — affects all dialogs with the backdrop-blur overlay
- [x] Project tags not persisting — tags entered via TagInput on ProjectDetailPage are not saved (TAG table and PROJECT_TO_TAG remain empty)

## Integrations & Import/Export
- [x] Obsidian export: UI wiring in Settings under Export methods (backend already implemented)
- [ ] PDF import: make async with progress indicator (currently synchronous / blocking). Note: `exportImport.ts` also bypasses `apiFetch` entirely and duplicates BASE_URL/isTauri detection — fix the infrastructure seam when touching this module.
- [x] Export methods toggle in Settings (show only enabled targets; prune candidates before release)

## Appearance / Theming
- [ ] Custom palettes: save named color configurations; appear alongside built-in presets in Settings; Changing of pallette selection ui to be slightly more usable will be important. Allow tinting to be available on each setting. Each setting should be an rgb comlumn and an a column, instead of the "cupertino only thing we got going on"
- [x] Right now overrides always override genuinely even if you try to switch to old theme. We should make it so that the overrides are only changing before you switch to another a set theme. and then that theme takes over the overrides, right now you can never return to the defaults.

## Architecture & Backend Integrity

- [x] **[HIGH PRIORITY] Delete alias time-bomb** — `storage/db.py:delete_paper` is an alias for `soft_delete_paper` but reads as a hard delete. Two endpoints call different paths to the same operation. Remove the alias, route all deletes through the service layer. Prevents a future "fix" silently bifurcating soft/hard delete behavior across endpoints.
- [x] **[HIGH PRIORITY] Service layer punches through storage seam** — `service/paper.py` has three functions (`_get_paper_project_fks`, `set_has_pdf_by_source`, `remove_from_all_projects`) that call `db._connect()` directly and write raw SQL. Add proper `storage/db.*` functions for these three and remove the internal-access violations.
- [x] **Paper dispatch logging** — `service/paper.py:Paper` dataclass dispatch uses `if paper.source_fk:` (falsy check, wrong for id=0) and silently resolves to the first populated key with no validation that exactly one is set. Add verbose logging at dispatch time and fix checks to `is not None`.
- [x] **SettingsPage decomposition** — `src/pages/SettingsPage.tsx` is 910 lines across 10+ concerns (Appearance, API Keys, Storage, CrossRef, Search, Sidebar, Integrations, Trash). Extract each section into `src/components/settings/`.
- [x] **N+1 query in project listing** — resolved via `list_project_tags_bulk` and `list_project_source_ids_bulk` in `storage/config/queries.py`; project list endpoint now fetches tags and source_ids in two queries total regardless of project count.
- [x] **Non-atomic multi-connection tag writes** — `storage/tags.py:add_project_tags` opens a separate connection per `create_tag` call then a third for the INSERT loop; `_sync_project_tags` in `api/app.py` calls remove and add as two separate operations. A crash mid-sequence leaves orphaned TAG rows or a partial tag set with no rollback. Consolidate into single-transaction helpers.

## Deferred
- [ ] TeX rendering library decision (KaTeX vs MathJax — must be compatible with future Notes Editor)
- [ ] Keyboard shortcut remapping (UX design and defaults TBD before implementation)
- [ ] Notes Editor as optional sidebar page (plugin-tier, off by default)
- [ ] Graph performance: SVG rendering + cluster nodes for large datasets
- [ ] Version monitoring / RSS-style polling for new arXiv versions (separate from opportunistic capture)
- [ ] Library: search across abstract and notes via `papers_fts` (backend ready)
