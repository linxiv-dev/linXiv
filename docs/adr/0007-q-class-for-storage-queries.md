# ADR 0007: Q class and named SQL constants for storage-layer queries

## Status

Accepted

## Context

The project listing endpoint in `api/app.py` fetches projects from storage, then calls `get_project_tags` once per project and `sfks_to_source_ids` once per project (which itself calls `db.get_source_id` once per paper in that project). With 10 projects and 20 papers each this is 210 separate database round-trips for a single API call. The root cause is that the service and API layers accumulate related data with per-row Python lookups instead of pushing the join into SQL.

The codebase already has `storage/config/queries.py`, which contains:

- A `Q` class — a lightweight composable WHERE-clause builder supporting `&`, `|`, `~` operators and parameterised values.
- `_fetch_one`, `_fetch_all`, `_count` catch-all runners that accept a `Q` and execute cleanly against a single table.
- A convention for multi-table JOIN queries: write a named SQL string constant (e.g. `_LIST_PROJECT_PAPERS_SQL`) above its section header and call it via `conn.execute`.

Several modules bypass this — `service/paper.py` calls `db._connect()` directly and hand-rolls SQL, and per-row service calls accumulate queries in Python loops.

## Decision

1. **Single-table lookups use `Q` + the catch-all runners.** No hardcoded SQL strings for predicates that can be expressed as `Q(col = ?, val)`. Compose complex predicates with `&` / `|` rather than string interpolation.

2. **Multi-table JOIN queries are named SQL constants in `queries.py`.** Any query spanning more than one table is written as an `_UPPER_SNAKE_SQL` constant above its section header, then executed via `conn.execute(CONSTANT, params)`. This keeps complex SQL readable and co-located with its schema context.

3. **No per-row Python accumulation of relational data.** If the result requires data from a related table (e.g. tags per project, papers per project), it must be fetched in a single JOIN or a single `IN (…)` batch query — not a loop. `_in(col, vals)` in `queries.py` builds the `IN` predicate from a list.

4. **No caller outside `queries.py` calls `_connect()`.** The public functions in `queries.py` are the storage seam. Direct connection access from service or API layers is a violation and should be refactored to a proper `queries.py` function.

## Consequences

### Positive
- The N+1 project listing query becomes a single JOIN constant, consistent with the existing `_LIST_PROJECT_PAPERS_SQL` pattern already in `queries.py`.
- Storage query logic is co-located and reviewable in one module; schema changes have one place to update.
- `Q` composition keeps predicate logic readable without string interpolation risk.
- Future architecture reviews have a clear rule: if it queries the database, it goes through `queries.py`.

### Negative / limits
- Very complex dynamic queries (e.g. multi-filter paper search with optional clauses) can produce verbose `Q` chains. For these, a named SQL constant with a Python-side conditional is acceptable when the `Q` approach becomes harder to read than the SQL itself.
- The `_fetch_all` runner uses `SELECT *` — callers receive `sqlite3.Row` objects and must know the column names. This is consistent with the existing codebase but means column renames require grep-and-fix, not a type error.

## References

- `storage/config/queries.py` — `Q` class, `_in`, `_fetch_one`, `_fetch_all`, `_count`, existing JOIN constants
- `api/app.py` — N+1 project listing endpoint (the motivating case)
- `service/paper.py` — three functions that currently call `db._connect()` directly (violates this decision; fix tracked in TODO.md)