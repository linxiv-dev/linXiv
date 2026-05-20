# ADR 0002: Namespace source_id with provider prefix

## Status

Accepted

## Context

`PAPER_ROOTS.SOURCE_ID` is a unique string identifier for a paper (e.g. `"2204.12985"` for arXiv, `"W3123456789"` for OpenAlex). The `UNIQUE` constraint on this column spans all providers in a single namespace. As more providers are added, format-based collision avoidance (relying on arXiv and OpenAlex IDs happening to look different) becomes fragile and unenforceable by the schema.

Local-only papers — PDFs uploaded without a known external ID — also need a `source_id` before they can be saved.

## Decision

`source_id` is always prefixed with the provider name, separated by a colon:

- `"arxiv:2204.12985"`
- `"openalex:W3123456789"`
- `"local:{uuid}"` — fallback for papers that cannot be identified against any known provider; used only when existing deduplication logic has no match

`"local"` is a fallback namespace, not a first-class provider. Existing deduplication catches most papers before they reach the local fallback.

The alternative considered was a two-column `UNIQUE(PROVIDER, RAW_ID)` constraint on `PAPER_ROOTS`. The single namespaced string was preferred because `source_id` is used as an opaque token throughout the codebase (FTS index, tag join table, query parameters) — a single column is simpler to pass around, and the prefix makes the origin self-describing in logs and debug output.

## Consequences

### Positive

- `PAPER_ROOTS.SOURCE_ID` is globally unique by construction, not by format accident.
- Provider origin is visible in the ID itself without a join.
- `"local:{uuid}"` gives unidentified papers a valid slot; Paper Repair migrates them to a canonical namespaced ID once identified.

### Negative / limits

- All stored `source_id` values must be migrated in a one-time schema migration.
- Every caller that constructs or parses a `source_id` string must be updated.
- If a user has a `"local:{uuid}"` and an `"arxiv:..."` root for the same physical paper, Paper Repair re-keys one but does not merge two existing roots. A **Merge Papers** workflow is needed to consolidate notes, project memberships, and version history before the losing root is deleted.

## References

- `PAPER_ROOTS` — `SOURCE_ID UNIQUE` constraint
- `storage/db.py` — `repair_paper`, `add_paper_tags`, `search_full_text`
- `sources/base.py` — `PaperSource.source_name`, `PaperMetadata.source`
- `CONTEXT.md` — source_id (namespaced), Paper Repair, Merge Papers
