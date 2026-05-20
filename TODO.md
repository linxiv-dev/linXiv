# linxiv TODO

Items flagged during design review. Grouped by area.

## Search
- [ ] Per-source sort options (arXiv: relevance / date / last-updated; OpenAlex: its own sort fields)
- [x] `+` append button adjacent to Search button (adds to working set instead of replacing)
- [x] `search_history` table + autocomplete dropdown on clause input (shows matches after 1 char)
- [x] `search_results` persistence table; Search page restores from it on mount
- [x] Remove Search from keep-alive in AppShell once db restore is in place
- [ ] TeX rendering in result titles and abstracts (library choice TBD — see Deferred)
- [ ] Query builder like in original gui
## Library
- [ ] Virtual scrolling for paper list (expected scale: thousands of papers)
- [ ] Paper Metadata Editor — shared create/edit form; port field set from PyQt, do not redesign
- [ ] postMessage bridge: selected PaperCard source_fks → parent app → Add to Project flow

## Paper Detail
- [ ] In-app PDF viewer tab (currently only "Open PDF" external link + download)
- [ ] Version selector in header (switch between stored versions; diff view between any two)
- [ ] Subtle version-awareness indicators: library badge, new-version nudge, fetch-missing action
- [ ] Notes tab: markdown editor, project scope picker defaulting to navigation context, optional version pin

## Graph
- [ ] postMessage bridge: selected node IDs → parent app → Export flow
- [ ] postMessage bridge: selected node IDs → parent app → Add to Project flow

## Projects
- [x] Project status UI: active / archived / deleted (three-state, not two)
- [x] Archived projects view (hidden from main list, accessible separately)
- [x] Deleted projects surfaced in Settings trash panel alongside deleted papers (30-day auto-purge on startup)
- [ ] Project tags UI (create, assign, display)
- [x] ProjectCard (ProjectsPage list): Archive and Delete are first-class card buttons 
- [x] move into `···` **context menu** or right-click context menu (same treatment applied to ProjectDetailPage header)

## Tags
- [ ] Clickable tag links everywhere they appear (paper cards, project cards, graph nodes)
- [ ] Tag View page: papers tagged directly + projects tagged + papers in those projects
- [ ] Tags sidebar entry (off by default, togglable in Settings)

## Sidebar
- [ x ] Configurable optional page toggles in Settings (Graph, Search, DOI Lookup on by default; Tags, Notes Editor off by default)

## Integrations & Import/Export
- [ x ] Obsidian export: UI wiring in Settings under Export methods (backend already implemented)
- [ ] PDF import: make async with progress indicator (currently synchronous / blocking)
- [ ] Export methods toggle in Settings (show only enabled targets; prune candidates before release)

## Appearance / Theming
- [ ] Custom palettes: save named color configurations; appear alongside built-in presets in Settings; Changing of pallette selection ui to be slightly more usable will be important.
- [ ] Glass effect: replace boolean toggle with percentage intensity input + hex color tint input
- [x] Right now overrides always override genuinely even if you try to switch to old theme. We should make it so that the overrides are only changing before you switch to another a set theme. and then that theme takes over the overrides, right now you can never return to the defaults.

## Deferred
- [ ] TeX rendering library decision (KaTeX vs MathJax — must be compatible with future Notes Editor)
- [ ] Keyboard shortcut remapping (UX design and defaults TBD before implementation)
- [ ] Notes Editor as optional sidebar page (plugin-tier, off by default)
- [ ] Graph performance: SVG rendering + cluster nodes for large datasets
- [ ] Version monitoring / RSS-style polling for new arXiv versions (separate from opportunistic capture)
- [ ] Library: search across abstract and notes via `papers_fts` (backend ready)
