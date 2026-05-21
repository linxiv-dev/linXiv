# ADR 0008: Repair endpoint scope — PUT semantics, metadata-only, source_id immutable

## Status

Accepted

## Context

The Paper Metadata Editor allows users to correct a paper's metadata fields (title, authors, date, abstract, DOI, URL, category, tags). This requires an HTTP endpoint that writes updated metadata to the database.

Two design questions needed resolution before shipping:

1. **HTTP verb**: A partial update (PATCH) would require the client to send only the fields it wants to change. A full replace (PUT) requires all mandatory fields on every call.

2. **source_id mutability**: A paper's `source_id` (e.g. `arxiv:2204.12985`, `doi:10.1234/...`) is its identity key in the system — it is used as a FK in PAPER_ROOTS, as a string key in PAPER and PAPER_TO_TAG, and as the key in the FTS index. Renaming it requires a multi-table migration (see `db.repair_paper`). Should that migration be exposable via HTTP?

## Decision

### 1. PUT semantics

`PUT /api/papers/sfk/{source_fk}` uses full-replace semantics: `title`, `authors`, and `published` are required on every call. Optional fields (`summary`, `category`, `doi`, `url`, `tags`) default to empty/null if omitted.

**Reason:** The metadata editor always submits a complete form payload. There is no partial-edit flow in the UI. Implementing PATCH semantics would require server-side merging of the incoming partial body with the existing stored values — introducing a read-modify-write pattern that can silently lose concurrent edits. Full replace from the UI's current state is simpler and safer given the single-user, local-app context.

### 2. source_id is not changeable via this endpoint

`api_repair_paper` constructs `PaperMetadata` with `source_id=paper.source_id` (the existing ID, never from the request body). This makes the `if new_id != old_id:` migration branch in `db.repair_paper` unreachable through HTTP.

**Reason:** Renaming a paper's identity key is a dangerous operation that changes the FTS index, all version rows, and all tag associations in a single transaction. It is only needed for import/export workflows (e.g. resolving a DOI that maps to a different arXiv ID during an import). Exposing it via a general-purpose metadata editor would allow accidental identity corruption with no undo path. If source_id migration is ever needed via HTTP, it should be a dedicated endpoint with explicit conflict detection and confirmation semantics — not the general repair endpoint.

### 3. Conflict detection returns 409

If a source_id rename were somehow triggered (or if concurrent writes produce a constraint violation), `api_repair_paper` catches `sqlite3.IntegrityError` and returns HTTP 409 rather than letting it propagate as an unhandled 500 with a raw SQLite message.

## Consequences

### Positive
- No merge logic in the endpoint; the handler is a simple validate → write → re-read.
- source_id is always stable across repair operations; no accidental identity changes possible from the UI.
- Constraint violations surface as actionable HTTP errors.

### Negative / limits
- Clients that send only partial updates (e.g. a future CLI or MCP tool that wants to update just a DOI) must supply the full mandatory fields. This is a minor inconvenience for non-UI callers.
- source_id migration is not available via HTTP; if a paper was imported with a wrong source_id (e.g. corrupt PDF OCR producing a bad arXiv ID), a user cannot fix this through the UI — they would need a manual DB operation or a dedicated migration endpoint.

## References

- `api/app.py` — `api_repair_paper`, `PaperRepairBody`
- `storage/db.py` — `repair_paper` (contains the source_id migration branch)
- `src/api/papers.ts` — `repairPaper` client function
- `src/components/papers/PaperMetadataEditor.tsx` — the UI that calls this endpoint
