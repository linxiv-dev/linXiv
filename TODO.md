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

---

## UX Audit (2026-05-23, Playwright-driven against Vite dev server)

Issues surfaced during the local-PDF debugging session and a subsequent
exhaustive click-every-button pass across every route. Severity tag is
my best guess.

### Bugs

#### [bug-high] Settings toggles don't reflect saved state until page reload

- [x] **Fix React Query cache invalidation in Settings sections**

**Symptom**
Clicking the "Search history" switch in Settings sends the right PATCH to the
backend (`{"updates":{"search_history_enabled":true}}` → `200 {"ok":true}`),
the value is persisted (`curl /api/settings` confirms), but the toggle's
`aria-checked` stays at its old value and the visual thumb doesn't move.
A full page reload re-fetches `/api/settings` and the toggle then renders
the correct state.

**Root cause**
`src/components/settings/SearchSection.tsx:25-27` calls `updateSettings(...)`
but never invalidates the `["settings"]` React Query cache, so
`useQuery({ queryKey: ["settings"] })` keeps returning the pre-mutation
snapshot. Compare with `src/components/settings/StorageSection.tsx:34`
which does `onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] })`.

**Scope (audit, 2026-05-23)** — same pattern missing from every Section
that mutates settings:

| File | `updateSettings`/`updateEnv` calls | `invalidateQueries` calls |
|---|---|---|
| `ApiKeysSection.tsx` | 3 | 0 |
| `AppearanceSection.tsx` | 2 | 0 |
| `CrossRefSection.tsx` | 2 | 0 |
| `SearchSection.tsx` | 3 | 0 |
| `StorageSection.tsx` | 2 | 1 ✅ |

`SidebarSection.tsx` is fine — Zustand store, not React Query.

**Suggested fix**
Wrap every call site in `useMutation({ ... onSuccess: invalidate })`, or —
better — push the invalidation into `updateSettings` itself in
`src/api/settings.ts` so it's impossible to forget. Same for `updateEnv`.

---

#### [bug-high] "Install CLI" button throws uncaught error in non-Tauri contexts

- [x] **Gate Integrations subsections on `isTauri`**

**Symptom**
Settings → Integrations → linxiv CLI → **Install** in a plain browser
throws an uncaught console error and produces no user-visible feedback
(silent no-op):

```
Error: Not running in Tauri
  at installCli (src/api/integrations.ts:13:25)
  at handleCli (src/components/settings/IntegrationsSection.tsx:140:39)
  at onInstall (src/components/settings/IntegrationsSection.tsx:182:26)
```

The Integrations section is rendered unconditionally, so anyone visiting
the running dev build will hit it. The MCP Clients subsection appears
empty in browser contexts — same root cause likely.

**Suggested fix**
Gate `IntegrationsSection.tsx` on the existing `isTauri` flag from
`src/api/client.ts` and hide (or render disabled with a "Available in the
desktop app" hint) the **COMMAND LINE** + **MCP CLIENTS** subsections in
non-Tauri contexts.

---

#### [bug-low] PDF endpoint receives three identical requests per detail-page load

- [ ] **Stop triple-fetching the PDF on paper detail open**

Observed in API logs:
```
GET /api/papers/local%3A.../pdf?version=1 200 OK
GET /api/papers/local%3A.../pdf?version=1 200 OK
GET /api/papers/local%3A.../pdf?version=1 200 OK
```
User confirmed this is a single visit, not multiple imports. Probable
cause is React StrictMode double-render + iframe mount/remount on tab
change. 1.7 MB requested 3× per visit is wasteful even when cached.

**Suggested fix**
Memoize the iframe `src` in `PaperDetailPage.tsx:379-387` or only mount
the iframe when the PDF tab is `data-state="active"`.

---

### Accessibility

#### [a11y-medium] 6 of 9 toggle switches lack `aria-label`

- [x] **Add `aria-label` to Search and Sidebar switches**

Audited via `document.querySelectorAll('[role=switch]')`. Only the three
Export Methods switches in `ExportSection.tsx` carry `aria-label`. The
six switches in `SearchSection.tsx` and `SidebarSection.tsx` are
unlabeled — screen-reader users hear only "switch, on/off" with no
context.

**Suggested fix**
Add `aria-label="Search history"` to the switch at
`SearchSection.tsx:47` and `aria-label={label}` to each Sidebar switch
at `SidebarSection.tsx:31`.

---

#### [a11y-medium] `+` / `−` buttons in Search lack `aria-label`

- [x] **Add `aria-label` to append/clear-results buttons**

The Search toolbar has `+` (Append to current results) and `−` (Clear
results) buttons with `title` tooltips for sighted mouse users, but no
`aria-label`. Screen-reader users hear "plus" / "minus" with no purpose
context.

---

### Friction (no functional break, worth a pass)

#### [polish-medium] "Add to Project" dead-ends when no projects exist

- [ ] **Show inline 'Create project' affordance in empty Add-to-Project modal**

In the Library, selecting papers → **Add to Project** opens a modal that
shows "No projects found." with only a **Cancel** button. User must
dismiss, navigate to Projects, create one, navigate back, re-select the
papers, re-open the modal — five steps for a probable first-run flow.

**Suggested fix**
Show an inline "Create new project" affordance in the modal when the
list is empty, or route to `/projects?create=1&returnTo=...` with a
flash banner explaining the flow.

---

#### [polish-low] Home stat tiles aren't clickable

- [x] **Link the four Home stat tiles to their corresponding routes** — Papers/PDFs → `/library`, Tags → `/tags`. Categories has no route; left static.

Home page shows `6 Papers`, `6 PDFs`, `1 Categories`, `0 Tags` as plain
`<div>`s. No link, no onclick. Most users will expect `Papers` to
navigate to `/library` etc.

---

#### [polish-low] Raw `source_id` shown in "Add Papers" dialog

- [ ] **Replace raw source_id with author line in Add-Papers picker**

Project's **Add Papers** picker renders each candidate as:
> *Beyond Penrose tensor diagrams with the ZX calculus…*
> `local:5e6c374a652deb61`

The hash is useful for debugging but noisy as the secondary line. Authors
would be more user-friendly; the hash could move into a tooltip.

---

### Earlier-session culprits not yet addressed

Identified during the local-PDF debugging session as *possible* failure
modes; they didn't cause the immediate bug we were chasing
(`Content-Disposition: attachment`) but remain unresolved.

#### [latent-medium] Hardcoded port 8000

- [x] **Dynamic port discovery for API ↔ Tauri webview**

`src/api/client.ts:9` is `BASE_URL = isTauri ? "http://127.0.0.1:8000" : ""`
and `api/run_api.py:27` binds uvicorn to a literal `8000`. If port 8000
is occupied when the Tauri app launches, the sidecar can't bind and the
frontend has no fallback. Scoped plan: find free port in Rust, pass
`LINXIV_PORT` env var, expose via a `get_api_port` Tauri command, set
`BASE_URL` via `setApiPort()` from `main.tsx` before render.

---

#### [latent-medium] `paper.pdf_path` and `has_pdf` can drift out of sync

- [ ] **Make pdf_path / has_pdf writes atomic in import flow**

`service/paper.py:605-606` writes `set_pdf_path()` and `set_has_pdf()` in
two separate calls. A crash between them leaves `has_pdf=true` with
`pdf_path=NULL`. The iframe still works (the fallback in
`_resolve_local_pdf` reconstructs from the standard filename), but the
"Open in system viewer" button in `PaperDetailPage.tsx:367` requires
`paper.pdf_path` and won't appear.

**Suggested fix**
Combine the two DB writes into a single transactional update, or set
`has_pdf=true` after `pdf_path` is written so they can never disagree in
the failure direction we care about.

---

#### [latent-low] `openPath(paper.pdf_path)` uses a stale absolute path

- [ ] **Re-resolve PDF path server-side before native open**

`PaperDetailPage.tsx:131` calls `openPath(paper.pdf_path)` with the
absolute path written at import time (e.g.
`/home/user/.local/share/com.linxiv.app/pdfs/...`). If the data directory
moved, the path is dead and `openPath` errors silently into the small
inline `openNativeError` state.

**Suggested fix**
Have the "Open in system viewer" button hit a backend endpoint that
re-resolves via `_resolve_local_pdf()` and returns the current path,
rather than trusting the stored absolute path.

---

#### [latent-low] Version 0 edge case in iframe URL

- [ ] **Guard against version=0 in iframe URL fallback path**

`PaperDetailPage.tsx:382` does `paper.version > 0 ? paper.version : undefined`.
If a paper ends up with `version=0` in the DB, the iframe omits the
`?version=` param, the API resolves `ver = paper.version = 0`, and
`pdf_on_disk_name(source_id, 0)` produces `..._v0.pdf` which doesn't
match any imported file (imports always start at v1). `pdf_path` still
succeeds; only the standard-filename fallback breaks.

---

#### [latent-low] `_resolve_local_pdf` fallback uses URL `source_id`, not `paper.source_id`

- [ ] **Use `paper.source_id` (DB-authoritative) for fallback path lookup**

`api/app.py:114`:
```python
std = PDF_DIR / pdf_on_disk_name(source_id, ver)
```
Uses the path-parameter `source_id` rather than `paper.source_id` from
the DB. Safe today because FastAPI's `{source_id:path}` decodes
identically to what was stored at import, but any future normalisation
(case, percent-encoding, namespace prefixes) breaks the fallback while
leaving the primary path working.

---

### Notes / context for whoever picks this up

- `Content-Disposition: inline` fix landed in `api/app.py:245` and PDF
  rendering verified end-to-end via Playwright (PDF.js toolbar visible,
  page 1 of 76 rendered).
- `local:sha256` source_id fix landed in `sources/pdf_metadata.py:165` —
  local imports of arXiv papers no longer adopt the `arxiv:...` identity;
  arXiv/CrossRef metadata is still used to enrich title/authors/etc.
- Stray `from _pytest._code import source` import removed from
  `sources/pdf_metadata.py`.
