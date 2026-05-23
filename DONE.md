# linxiv — Completed Items

Moved from TODO.md once shipped. Grouped by original section.

## Search
- [x] Per-source sort options (arXiv: relevance / date / last-updated; OpenAlex: its own sort fields)
- [x] `+` append button adjacent to Search button (adds to working set instead of replacing)
- [x] `search_history` table + autocomplete dropdown on clause input (shows matches after 1 char)
- [x] `search_results` persistence table; Search page restores from it on mount
- [x] Remove Search from keep-alive in AppShell once db restore is in place
- [x] Query builder like in original gui

## Library
- [x] Virtual scrolling for paper list (expected scale: thousands of papers)
- [x] Paper Metadata Editor — shared create/edit form; port field set from PyQt, do not redesign
- [x] postMessage bridge: selected PaperCard source_fks → parent app → Add to Project flow

## Paper Detail
- [x] Restore-from-trash "keep in projects?" prompt — API + frontend dialog complete (`KeepInProjectsDialog` in SettingsPage, `removeFromAllProjects` wired)
- [x] Version selector in header (switch between stored versions — selector in meta row, edit/download gated to latest)
- [x] Subtle version-awareness indicators in GUI: library badge, new-version nudge, fetch-missing action

## Graph
- [x] postMessage bridge: selected node IDs → parent app → Export flow
- [x] postMessage bridge: selected node IDs → parent app → Add to Project flow

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
- [x] PDF import: make async with progress indicator (currently synchronous / blocking). Note: `exportImport.ts` also bypasses `apiFetch` entirely and duplicates BASE_URL/isTauri detection — fix the infrastructure seam when touching this module.
- [x] Export methods toggle in Settings (show only enabled targets; prune candidates before release)

## Appearance / Theming
- [x] Custom palettes: save named color configurations; appear alongside built-in presets in Settings; Changing of pallette selection ui to be slightly more usable will be important. Allow tinting to be available on each setting. Each setting should be an rgb comlumn and an a column, instead of the "cupertino only thing we got going on"
- [x] Right now overrides always override genuinely even if you try to switch to old theme. We should make it so that the overrides are only changing before you switch to another a set theme. and then that theme takes over the overrides, right now you can never return to the defaults.
- [x] **Remove glass effect from Cupertino theme** — the glass effect is currently a Cupertino-specific special case. Decouple it from the theme definition so it is no longer treated as a theme-exclusive feature.
- [x] **Color picker default to current value** — when the user opens a color input in the palette editor, the hex field should pre-populate with the current active color, not the value inherited from the base theme the palette was derived from.

## Settings Page
- [x] **Collapsible settings sections** — convert all sections in SettingsPage (and its extracted sub-components) to collapsible panels so users can fold away areas they are not actively configuring.

## Architecture & Backend Integrity
- [x] **[HIGH PRIORITY] Delete alias time-bomb** — `storage/db.py:delete_paper` is an alias for `soft_delete_paper` but reads as a hard delete. Two endpoints call different paths to the same operation. Remove the alias, route all deletes through the service layer. Prevents a future "fix" silently bifurcating soft/hard delete behavior across endpoints.
- [x] **[HIGH PRIORITY] Service layer punches through storage seam** — `service/paper.py` has three functions (`_get_paper_project_fks`, `set_has_pdf_by_source`, `remove_from_all_projects`) that call `db._connect()` directly and write raw SQL. Add proper `storage/db.*` functions for these three and remove the internal-access violations.
- [x] **Paper dispatch logging** — `service/paper.py:Paper` dataclass dispatch uses `if paper.source_fk:` (falsy check, wrong for id=0) and silently resolves to the first populated key with no validation that exactly one is set. Add verbose logging at dispatch time and fix checks to `is not None`.
- [x] **SettingsPage decomposition** — `src/pages/SettingsPage.tsx` is 910 lines across 10+ concerns (Appearance, API Keys, Storage, CrossRef, Search, Sidebar, Integrations, Trash). Extract each section into `src/components/settings/`.
- [x] **N+1 query in project listing** — resolved via `list_project_tags_bulk` and `list_project_source_ids_bulk` in `storage/config/queries.py`; project list endpoint now fetches tags and source_ids in two queries total regardless of project count.
- [x] **Non-atomic multi-connection tag writes** — `storage/tags.py:add_project_tags` opens a separate connection per `create_tag` call then a third for the INSERT loop; `_sync_project_tags` in `api/app.py` calls remove and add as two separate operations. A crash mid-sequence leaves orphaned TAG rows or a partial tag set with no rollback. Consolidate into single-transaction helpers.
- [x] **`api/app.py` bypasses service layer for paper saves** — `api/app.py` imports `save_paper`, `save_paper_metadata`, `save_papers_metadata` directly from `storage.db`, bypassing `service/paper.py`. Creates two write paths into storage; the direct callers (BibTeX import, OpenAlex save, arXiv fetch) will silently skip any invariants added to the service save path — e.g., opportunistic version capture. Remove the direct `from storage.db import save_*` imports from `api/app.py` and route all saves through `service.paper`.
- [x] **Note mutations missing from service layer** — `api_note_update` and `api_note_delete` reconstruct `Note` storage objects field-by-field inline in the route handler. `service/note.py` has no `update` or `delete` function. Add them to the service layer; route handlers become 3-line delegates.
- [x] **Implicit search result contract** — `api/app.py` had two private serializers producing slightly different dict shapes from the same `PaperMetadata`. Replaced with `SearchResultOut` Pydantic model and `from_metadata` classmethod. See ADR 0011.
- [x] **`pdf_url` rename in `SearchResultOut`** — renamed to `paper_url` in `SearchResultOut` (backend) and `SearchResult` (frontend `src/types/api.ts`). Result row link label updated to "PDF →" for arXiv and "Open →" for other sources. See ADR 0011.
- [x] Library: search across abstract and notes via `papers_fts` — `search_papers` in `service/paper.py` merges FTS5 results with note LIKE search; `searchLibrary` API client added; LibraryPage integrates both, with FTS triggered at 3+ chars via `useQuery`.
- [x] **`pdf_url` rename in `SearchResultOut`** — `pdf_url` is misnamed for OpenAlex results, which return a DOI landing page or OpenAlex work URL, not a PDF URL. Fixing it requires updating the frontend `SearchResult` TypeScript interface. See ADR 0011.
- [x] **PDF import lifecycle in route handler** — `api/app.py:api_import_pdf` contains ~58 lines of file I/O, DB save, path rename, `has_pdf`/`pdf_path` flag updates, rollback on failure, and project linking inline in the route. Extract to `service/paper.py` as `import_pdf(content: bytes, project_id: int | None) -> PaperImportResult`; route becomes a 5-line delegate. Matches the async groundwork already in place.
