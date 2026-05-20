# linXiv — Domain Glossary

## Paper Root

The abstract identity of a paper that exists in the world, independent of any particular stored version. A Paper Root is created once and never changes. Stored as a `PAPER_ROOTS` row.

Identified by:
- `source_id` — the string paper identifier (e.g. `"2204.12985"`)
- `source_fk` — the integer surrogate key for this root (`PAPER_ROOTS.SOURCE_FK`)

## Paper Version

A specific stored snapshot of a Paper Root at a given revision. Multiple Paper Versions can exist for the same Paper Root. Stored as a `PAPER` row.

Identified by:
- `paper_id` — the integer primary key for this version (`PAPER.PAPER_ID`)
- `(source_id, version)` — unique together

## source_id

The canonical string identifier for a paper. Always prefixed with the provider name (e.g. `"arxiv:2204.12985"`, `"openalex:W3123456789"`, `"local:{uuid}"`). Belongs to the Paper Root; denormalized into Paper Version rows for query convenience. See **source_id (namespaced)** for the full contract.

## source_fk

The integer surrogate key for a Paper Root (`PAPER_ROOTS.SOURCE_FK`). Used as a FK anchor in Notes, Project-to-paper links, and other associations that should survive version changes.

## paper_id

The integer primary key of a specific Paper Version (`PAPER.PAPER_ID`). Distinct from `source_id` and `source_fk`. Used when the caller needs to reference an exact version.

## Library

A UI concept: the full collection of all Paper Roots a user has saved locally. Not a first-class domain entity — there is no Library table or FK. The note table is `NOTE` (previously `LIBRARY_NOTE` — renamed; no migration needed).

## Note

An annotation that always belongs to a Paper Root (via `source_fk`). Optionally pinned to a specific Paper Version (via `paper_id`). Optionally scoped to a Project (via `project_fk`). There are no free-standing project notes — every note has a paper behind it; project scoping is a filter on top of that.

## Service Layer Dataclass Convention

Service-layer dataclasses (e.g. `service/note.py::Note`, `service/project.py::Project`) are **query objects** — what the caller passes in, with all fields optional. Storage-layer dataclasses (e.g. `storage/notes.py::Note`) are **row objects** — what the caller receives back, with full fields populated. Same class name across layers is intentional: the caller's mental model is consistent (pass a `Note`, receive a `Note`), even though the internal shape differs. Do not treat same-named dataclasses across `service/` and `storage/` as duplicate code.

## Project

A named collection of Paper Roots. Papers are linked to a Project at the root level (via `SOURCE_FK` in `PROJECT_TO_PAPER`), so all versions of a paper are in the project together.

**Lifecycle:** `ACTIVE` → `ARCHIVED` (read-only, visible) → `DELETED` (soft-deleted, hidden). Soft delete is implemented; hard delete (permanent row removal, requires explicit user confirmation) and restoration (`DELETED`/`ARCHIVED` → `ACTIVE`) are intended but not yet implemented.

## Tag

A named label that exists independently as a TAG entity. Both paper tags and project tags reference the same TAG entities. `PAPER_TO_TAG` is the authoritative join table for paper tags; `PAPER_META.TAGS` is a denormalized read cache. Project tags should eventually have a `PROJECT_TO_TAG` join table to match. When a Tag is deleted, its join-table rows cascade; the tag label disappears from all associated papers and projects.

## Graph

A force-directed D3.js visualization of the library. Three node types: **paper** (keyed by `source_fk`), **author** (currently keyed by raw name string from `PAPER_META.AUTHORS` — should eventually key off the normalized AUTHOR entity once enrichment is in place), and **tag** (added by augmentation). Edges: paper→author and paper→tag. Project membership is overlaid as node metadata, not as edges.

Semantic edges (AI-computed paper similarity) are not yet wired into the graph. Whether they belong in the same graph as a filterable edge type or in a separate view is undecided.

## Obsidian Integration

A one-way export — linXiv generates markdown notes with YAML frontmatter into `obsidian_vault/arXivVault/`. linXiv is the source of truth; Obsidian is a consumer. Edits made in Obsidian do not sync back. Obsidian is optional — linXiv is fully usable without it.

## MCP Server

Exposes the linXiv service layer as tools Claude can call directly (`search_papers`, `create_note`, `add_paper_to_project`, etc.). Write operations go through the service layer and are immediately visible in the GUI — this is shared service access, not bidirectional sync. One-way in the same sense as the API layer: the service layer is the authority.

## API Layer

A FastAPI HTTP server (`api/`) that is a thin pass-through to the service layer for a separate web frontend (lives in a different repository). Not a first-class priority. Routes only serialize service layer results to JSON — no business logic in routes. All paper routes call `service.paper` directly; `PaperDetails.to_dict()` is the one serializer for JSON responses. `sfks_to_source_ids`, `list_paper_details`, and `search_full_text_details` live in `service/paper.py` so the GUI, API, and MCP share one source of truth.

## ML / AI Posture

The data model should remain **vectorizable, searchable, and linkable** — schema decisions should not foreclose embedding, semantic search, or graph-based reasoning. However, ML/AI features are not first-class and must be built from scratch; they do not drive near-term design choices. When a decision has ML implications, note it, but do not design around hypothetical AI requirements at the expense of the current working product.

## Content (DROPPED)

The `CONTENT` table, `service/content.py`, and `service/models/content.py` have been deleted. The DDL file (`CONTENT.SQL`) and its entry in `_TABLE_DDL_ORDER` are removed. The `get_paper_content` query helper in `storage/config/queries.py` is also gone. Full Text + FTS covers the text case; binary attachments belong on disk.

## Provider

The external service that supplied a paper's metadata (e.g. `'arxiv'`, `'openalex'`). Stored as `PAPER_META.PROVIDER` (renamed from `SOURCE`). Distinct from `source_id` and `source_fk`, which identify the Paper Root and have nothing to do with provenance. Must equal `PaperSource.source_name` of the backend that fetched the record. The `papers` view aliases `PROVIDER` as `source` for Python callers; `PaperDetails.source` and `PaperMetadata.source` still use the Python name `source`.

## source_id (namespaced)

`source_id` is always prefixed with the provider name: `"arxiv:2204.12985"`, `"openalex:W3123456789"`, `"local:{uuid}"`. This guarantees global uniqueness in `PAPER_ROOTS` across all providers without relying on format accidents.

**Local-only papers** — PDFs uploaded without a known external ID — receive a `"local:{uuid}"` source_id at import time. When the user later identifies the paper (via DOI lookup, arXiv search, or manual entry), Paper Repair migrates the `source_id` from `"local:{uuid}"` to the canonical namespaced ID. If the user also has the same paper saved under a provider namespace (duplicate Paper Root), repair resolves the duplicate by re-keying.

`"local"` is a fallback namespace — used only when a paper genuinely cannot be identified against any known provider. Existing deduplication logic catches papers before they are saved as duplicates, so `"local"` should be rare in practice.

**Missing workflow:** Paper Repair re-keys a single Paper Root's `source_id` but does not merge two existing Paper Roots into one. If a user has both `"local:uuid"` and `"arxiv:2204.12985"` as separate roots (same physical paper), there is currently no way to consolidate their notes, project memberships, and version history into a single root. A **Merge Papers** workflow is needed that re-points all FKs from the losing root to the winning root before deleting the losing root.

## Managed PDF

A PDF downloaded by the app into the app-controlled `pdf_dir`, named `{paper_id}v{version}.pdf`. The app owns managed PDFs and may delete them. Contrast with an **External PDF**: a user-supplied path the app reads but never deletes. `pdf_path()` checks the external path first, then falls back to managed. `delete_pdf()` refuses to act on any path outside `pdf_dir`.

## Paper Repair

The backend operation of correcting a Paper Root's identity and metadata when the user fixes a bad import — wrong arXiv ID, formatting mistake, failed PDF import. Keyed by `source_fk` (stable) so it survives a `source_id` rename. Migrates `SOURCE_ID` across all referencing tables (PAPER, PAPER_TO_TAG, papers_fts) in a single transaction. The UI surfaces this as "edit"; the backend calls it `repair_paper`. The naming mismatch is intentional — "repair" describes the backend's corrective act, "edit" describes what the user sees.

## Author

A person associated with a Paper Version. Two representations coexist:

- `PAPER_META.AUTHORS` — denormalized list of raw name strings from the provider API; always present; used as a read cache and display fallback.
- `PAPER_TO_AUTHOR` — normalized join table linking AUTHOR entities (which may carry ORCID, split first/last name) to a specific Paper Version by `paper_id`. Authoritative when enriched.

An Author page for full enrichment (ORCID lookup, canonical name) is not yet implemented. Author names can currently be edited per-paper.

## Full Text

The extracted text content of a Paper Version (TeX source or PDF text), stored in `PAPER_META.FULL_TEXT` and indexed in the `papers_fts` FTS5 virtual table. `set_full_text()` keeps both in sync. `papers_fts` is a one-way write-through cache — it has no FK back to any other table and is safe to rebuild from `FULL_TEXT` at any time. The TeX source zip itself lives on disk; `PAPER_META.DOWNLOADED_SOURCE` records whether it has been fetched.
