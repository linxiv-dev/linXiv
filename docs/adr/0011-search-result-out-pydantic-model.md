# ADR 0011: SearchResultOut as the single serializer for search and fetch responses

## Status

Accepted

## Context

`api/app.py` had two private serializer functions producing slightly different dict shapes from the same underlying `PaperMetadata`:

- `_metadata_to_search_result(meta: PaperMetadata) -> dict` — used by the arXiv search route. Stripped the namespace prefix from `source_id` (e.g. `"arxiv:2204.12985"` → `"2204.12985"`), set `entry_id` to the namespaced form.
- `_arxiv_result_summary(p: arxiv.Result) -> dict` — used by the arXiv fetch route. Took a raw `arxiv.Result` object, set `entry_id` to the full URL (e.g. `"http://arxiv.org/abs/2204.12985v4"`).
- Inline dict construction in `api_openalex_search` — did not strip the namespace prefix, so `source_id` was `"openalex:W3..."` instead of the bare `"W3..."`.

This created three divergent code paths with no shared contract:
1. arXiv search and OpenAlex search were inconsistent on `source_id` format (bare vs namespaced).
2. arXiv search and arXiv fetch were inconsistent on `entry_id` format (namespaced string vs URL).
3. No Pydantic model meant FastAPI could not validate or document the response schema.
4. The arXiv fetch route used `fetch_paper_metadata()` (returning `arxiv.Result`) rather than `_arxiv_source.fetch_by_id()` (returning `PaperMetadata`), creating a second dependency on the lower-level arxiv library in the route handler.

The frontend `SearchResult` TypeScript interface was the implicit contract; there was no Python counterpart to validate against it.

## Decision

Replace all three serialization paths with a single `SearchResultOut(BaseModel)` Pydantic class and a single `from_metadata(cls, meta: PaperMetadata)` classmethod.

Key choices:

**`source_id` is always bare (namespace stripped).** `"arxiv:2204.12985"` → `"2204.12985"`, `"openalex:W3123456789"` → `"W3123456789"`. This matches what the arXiv path already returned and fixes the OpenAlex inconsistency. Both `ArxivSource.fetch_by_id` and `OpenAlexSource.fetch_by_id` accept bare IDs (they call `.removeprefix()` internally), so the save routes are not broken by this change.

**`entry_id` is the full namespaced source_id.** The search route already returned the namespaced form; the fetch route previously returned a URL. Unifying on the namespaced form is simpler and consistent. The frontend treats `entry_id` and `source_id` as interchangeable (see `SearchPage.tsx` line 44) and does not construct URLs from `entry_id`.

**The arXiv fetch route switches from `fetch_paper_metadata()` to `_arxiv_source.fetch_by_id()`.** This returns `PaperMetadata` directly, eliminating the separate `_arxiv_result_summary` function and the dependency on `arxiv.Result` in the route layer. Storage write uses `save_paper_metadata` (the `PaperMetadata` path) instead of `save_paper` (the `arxiv.Result` path); both call the same `_write_paper_version` with identical field coverage.

**Response wrapper models are added for all affected routes.** `ArxivSearchOut`, `ArxivFetchOut`, `OpenAlexSearchOut`, `OpenAlexSaveOut` are declared with `response_model=` on their routes.

**A `_strip_namespace` helper is extracted** to avoid repeating `.split(":", 1)[-1]` at every call site.

## Exception hierarchy for source errors

As part of this change, typed exceptions were added to the source modules to give route handlers precise 404/400/502 mapping:

- `ArxivNotFoundError(LookupError)` — raised when a paper ID does not exist on arXiv.
- `OpenAlexNotFoundError(LookupError)` — raised when a work ID does not exist on OpenAlex.
- `OpenAlexHTTPError(Exception)` — raised for non-404 HTTP errors from OpenAlex (carries `.status`).
- `OpenAlexInputError(ValueError)` — raised for invalid or malformed `source_id` inputs before any network call (empty ID, ID not matching `W\d+`).

`LookupError` is the correct base for not-found exceptions. `OpenAlexHTTPError` inherits from `Exception` (not `LookupError`) because an upstream HTTP 5xx is not a lookup failure; conflating the two would let a `503 Service Unavailable` be silently absorbed by a handler that expected only "not found."

## Consequences

### Positive
- One class, one classmethod, consistent `source_id` and `entry_id` across all three routes.
- FastAPI can generate accurate OpenAPI docs for search and fetch responses.
- Route handlers map source-layer exceptions to correct HTTP status codes (404 for not-found, 400 for malformed input, 409 for DB conflicts, 502 for upstream failures).
- `OpenAlexSource.search()` skips malformed individual work records with a log line rather than aborting the entire result set.
- `OpenAlexSource.fetch_by_id()` validates the work ID format before hitting the network.

### Negative / limits
- `entry_id` now consistently holds the namespaced source_id string (e.g. `"arxiv:2204.12985"`). Previously the arXiv fetch route returned the full abs URL. Any external consumer that stored `entry_id` as a URL will see a different format. The frontend is unaffected (it treats the fields as equivalent), but this is a silent breaking change for hypothetical external API clients.
- The `_USER_AGENT` in `openalex_source.py` does not include a `mailto:` address, which means OpenAlex requests hit the unprioritized pool. This should be sourced from user settings when that infrastructure is available.

## References

- `api/app.py` — `SearchResultOut`, `_strip_namespace`, updated routes
- `sources/arxiv_source.py` — `ArxivNotFoundError`, `_ARXIV_EMPTY_PAGE_ERROR` compat shim
- `sources/openalex_source.py` — `OpenAlexNotFoundError`, `OpenAlexHTTPError`, `OpenAlexInputError`
- ADR 0002 — namespaced source IDs (`"arxiv:..."`, `"openalex:..."` convention)
- ADR 0010 — service layer as the only write boundary for `api/app.py`
