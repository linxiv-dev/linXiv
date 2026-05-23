# ADR 0010: Service layer is the only import boundary for api/app.py

## Status

Accepted

## Context

`api/app.py` previously imported write functions (`save_paper`, `save_paper_metadata`, `save_papers_metadata`) and several utilities (`get_categories`, `get_tags`, `init_db`, `parse_entry_id`) directly from `storage.db`, bypassing `service/paper.py`. This created two parallel write paths into storage: one through the service layer and one directly into storage. Any invariant added to the service save path (e.g. opportunistic version capture triggered on every paper save) would silently be skipped by the direct callers — arXiv fetch, OpenAlex save, and BibTeX import.

The same issue existed for tag queries: `api/app.py` called `storage.db.get_tags()` directly instead of the service-layer equivalent.

## Decision

`api/app.py` must not import from `storage.*` for paper read/write operations. All such calls route through the appropriate service module (`service.paper`, `service.tag`, etc.).

Functions that previously lived only in `storage.db` are re-exported from `service/paper.py` as pass-through delegates (e.g. `save_paper`, `save_paper_metadata`, `save_papers_metadata`, `get_categories`, `init_db`, `parse_entry_id`). The delegate approach lets the service layer add business logic (logging, version capture, validation) in one place later without changing call sites.

`api/app.py` still imports directly from `storage.notes`, `storage.projects`, and `storage.tags` for the domains whose service modules have not yet absorbed their full surface area. Those are tracked as open TODO items and will be resolved as the service layer matures (see TODO.md — Architecture & Backend Integrity).

## Consequences

### Positive
- A single write path into storage for paper operations; any invariant added to `service/paper.py` applies to all callers automatically.
- `api/app.py` is not aware of which storage module backs a given operation.
- BibTeX import now runs `save_papers_metadata` in a single transaction (the service-layer version) rather than a per-row loop.

### Negative / limits
- The service-layer delegates are thin wrappers that add no logic today; they exist solely to enforce the boundary. This is intentional overhead.
- `storage.notes`, `storage.projects`, and `storage.tags` are still imported directly from `api/app.py`; the rule is not yet uniformly enforced across all domains.

## References

- `api/app.py` — imports from `service.paper`, `service.tag`
- `service/paper.py` — delegate wrappers at lines 372–384, 359, 82–91
- TODO.md — remaining open items: PDF import lifecycle, project create/update, note mutations
