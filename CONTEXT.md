# linxiv Domain Glossary

## Note

A markdown text block attached to a **Paper**, scoped to a **Project**. The same paper can carry independent notes in different project contexts. A note with no project scope is a global note (attached to the paper across all contexts).

The UI for creating and editing notes is a dedicated markdown editor view — not an inline widget — that defaults its project scope to wherever the user navigated from (e.g. arriving from a project detail pre-selects that project; arriving from the library pre-selects global/unscoped). Notes attach at the paper (`source_fk`) level by default, not to a specific version; a note can optionally be pinned to a version explicitly.

## Paper

A research paper record in the local library. Identified by a `source_fk` (source-specific key, e.g. arXiv ID or DOI). A paper can belong to zero or more Projects. The library is expected to scale to thousands of papers; the Library page uses virtual scrolling to keep render cost constant regardless of library size.

## Paper Metadata Editor

A form for creating or correcting a Paper's metadata fields (title, authors, abstract, date, category, URL, etc.). Used for both manual entry (papers with no online presence) and fixing papers imported incorrectly (e.g. bad PDF OCR, wrong DOI resolution). It is a single shared component, not two separate flows. The pattern and field set already exist in the old PyQt GUI (`gui/`) and need to be ported to React, not redesigned.

## Project

A named collection of Papers. Has a color, optional tags, and a three-state status: **active** (visible and in use), **archived** (hidden from main list, preserved in full), **deleted** (soft-deleted, in trash, restorable or hard-deletable). Archiving and deletion are distinct operations — archiving is "done with this for now," deletion is "might want this back." The trash panel in Settings surfaces deleted projects alongside deleted papers.

## TeX Rendering

LaTeX math expressions in paper titles and abstracts must be rendered — raw markup is unacceptable for the target audience. Library choice (KaTeX, MathJax, or other) is not yet committed; the decision should account for compatibility with the future Notes Editor. Applied wherever paper titles or abstracts are displayed: search results, library cards, paper detail, graph node labels where feasible.

## Custom Palette

A user-saved named color configuration. Stores a full set of color values (the same fields as a built-in preset) so the user can define their own theme once and switch back to it without re-entering individual overrides. Custom palettes appear alongside built-in presets in the Appearance section of Settings. **[NOT IMPLEMENTED]**

## Glass Effect

Controls frosted-glass rendering (currently Cupertino only). The intensity input should be a **percentage** (0–100%), not a binary toggle. The tint/color component of the glass should be expressed as a **hex color value**. **[NOT IMPLEMENTED in current format — currently a boolean toggle]**

## Keyboard Shortcuts

User-remappable key bindings stored in settings. Defaults are TBD — UX and default mapping need to be designed before implementation. Tab navigation within pages already works via browser defaults. Shortcuts are a planned customization feature, not yet scoped.

## Sidebar

The app's primary navigation. Divided into a **fixed core** (Library, Projects, Settings — always visible) and **optional pages** (Graph, Search, DOI Lookup, Tags, Notes Editor, and any future additions) that can be individually shown or hidden via Settings. Optional pages are off or on by default depending on how niche they are (Tags: off by default; Notes Editor: off by default; Graph, Search: on by default).

## Tag

A label that can be applied to a **Paper** directly, or to a **Project**. Project tags propagate to the graph filter panel (filtering by project tag highlights papers in that project). Tags are shared vocabulary across both entities.

A **Tag View** is a cross-cutting view that shows everything associated with a given tag: papers individually tagged with it, plus projects tagged with it and (transitively) papers in those projects. Tags are clickable links throughout the app (paper cards, project cards, graph nodes). A Tag index page also exists as an optional sidebar entry, disabled by default and togglable in Settings.

## Search History

A log of past searches, stored in its own table. Each row records the query (clauses, source, maxResults) and timestamp. Surfaced as an autocomplete dropdown on the clause input field — past searches matching the current input appear as suggestions after the user types at least one character. Used to re-run or revisit a past search without re-hitting rate limits.

## Search Results

The current working set of results shown in the Search page, stored in a separate table from Search History. Can be the output of a single search or a mix accumulated across multiple searches. Persists across app restarts. Cleared explicitly by the user. The Search page restores from this table on mount, replacing the keep-alive approach. A "+" button adjacent to the Search button appends new results to the current working set (deduplicating by source ID) instead of replacing it; the plain Search button replaces.
In advanced setting the user will be able to configure how many to save off the default (1 batch) 
## PDF Import

Extracts metadata from a PDF file and saves it as a Paper. Must run asynchronously — the user should receive immediate feedback (progress indicator) and not be blocked while extraction runs. **[NOT IMPLEMENTED as async]** — current implementation is synchronous.

## Full-Text Search

Search across the local library including abstract and note content, not just title and author. The backend has a `papers_fts` table (SQLite FTS) ready. **[NOT IMPLEMENTED in frontend]** — current library search only covers title and author fields.

## Obsidian Integration

One-way push of paper or project data to an Obsidian vault as markdown files. Backend functionality already exists; needs UI wiring in Settings under Export methods. **[NOT IMPLEMENTED in frontend]**.

## Export

A one-way push of paper or project data to an external format or tool. Configured in Settings as a set of enabled export methods. Known candidate export targets: Obsidian vault (markdown), BibTeX, CSV, JSON, Markdown file. The final set of supported methods will be pruned before release — not all candidates are confirmed to ship. Users enable the export methods they use; unused ones are hidden. MCP server is a separate integration layer (not an export method).

## Graph

A force-directed visualization of Papers, authors, and Tags as nodes. Supports multi-node selection; selected node IDs are posted to the parent React app via `postMessage`, which handles downstream actions through the standard shared flows: Export and Add to Project. **[NOT IMPLEMENTED]** — postMessage bridge for selection export and Add to Project is not yet built. The bottom paper table from the old PyQt frontend is intentionally removed. Graph performance optimization (level-of-detail, clustering) is deferred; the intended future direction is SVG-style rendering with cluster nodes for dense neighborhoods.

## Paper Version

A snapshot of a Paper at a specific arXiv version number (v1, v2, v3, …). The full versioning workflow has three parts: **opportunistic capture** (when a newer version is encountered during any fetch or batch search, it is recognized as belonging to an existing paper and stored), **storage** (each version kept as a distinct metadata snapshot), and **diff** (showing what changed between versions — abstract, authors, title, etc.). 

Version capture is opportunistic, not active — it happens when a newer version is fetched incidentally. Continuous monitoring (polling arXiv for updates) is a separate optional feature in the vein of RSS feeds, not part of the core versioning model.

Frontend: a version selector in the Paper Detail header lets the user switch between stored versions; a diff view is accessible from there. All four version-awareness capabilities exist (library indicator, new-version nudge, fetch missing versions, notes across versions) but are surfaced subtly — no prominent badges or buttons. The UI principle is: capability without clutter.

Notes attach to the paper at the `source_fk` level (not version-specific) by default, matching the backend model. A note can optionally be pinned to a specific version if the user wants to annotate a particular draft. This is a core differentiating feature of linxiv.

## Source

The origin of a paper record: `arxiv`, `openalex`, `doi`, `pdf` (PDF import), or `local` (manually entered). Determines which fields are available and how the paper was fetched.

## Storage Query Convention

All storage-layer queries live in `storage/config/queries.py` and follow two patterns:

- **Simple lookups** use the `Q` class — a lightweight composable WHERE-clause builder (`&`, `|`, `~`) — passed to the `_fetch_one`, `_fetch_all`, or `_count` runners. No raw SQL strings for single-table queries.
- **JOIN queries** (multi-table) are written as named SQL string constants (e.g. `_LIST_PROJECT_PAPERS_SQL`) stored above their section header. The connection is acquired inline and the constant is passed directly to `conn.execute`. No f-strings; no per-row Python loops.

Callers outside `queries.py` must not call `_connect()` directly. The storage seam is the public functions in `queries.py`; the connection and SQL are implementation details.
