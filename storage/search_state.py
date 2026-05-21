from __future__ import annotations

import json
from typing import Any

from .db import _connect


def save_state(
    clauses: list[dict[str, Any]],
    source: str,
    max_results: int,
    results: list[dict[str, Any]],
    saved_ids: list[str],
    sort_prefs: dict[str, str] | None = None,
) -> None:
    """Persist the current search page state (single-row table, id=1)."""
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO SEARCH_STATE
                (ID, CLAUSES_JSON, SOURCE, MAX_RESULTS, RESULTS_JSON, SAVED_IDS_JSON, SORT_JSON, UPDATED_AT)
            VALUES (1, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(ID) DO UPDATE SET
                CLAUSES_JSON   = excluded.CLAUSES_JSON,
                SOURCE         = excluded.SOURCE,
                MAX_RESULTS    = excluded.MAX_RESULTS,
                RESULTS_JSON   = excluded.RESULTS_JSON,
                SAVED_IDS_JSON = excluded.SAVED_IDS_JSON,
                SORT_JSON      = excluded.SORT_JSON,
                UPDATED_AT     = datetime('now')
            """,
            (
                json.dumps(clauses),
                source,
                max_results,
                json.dumps(results),
                json.dumps(saved_ids),
                json.dumps(sort_prefs) if sort_prefs is not None else None,
            ),
        )


def load_state() -> dict[str, Any] | None:
    """Return the persisted search state, or None if none has been saved yet."""
    with _connect() as conn:
        row = conn.execute("SELECT * FROM SEARCH_STATE WHERE ID = 1").fetchone()
    if row is None:
        return None
    try:
        raw_sort = row["SORT_JSON"]
        return {
            "clauses":     json.loads(row["CLAUSES_JSON"]),
            "source":      str(row["SOURCE"]),
            "max_results": int(row["MAX_RESULTS"]),
            "results":     json.loads(row["RESULTS_JSON"]),
            "saved_ids":   json.loads(row["SAVED_IDS_JSON"]),
            "sort_prefs":  json.loads(raw_sort) if raw_sort is not None else None,
            "updated_at":  str(row["UPDATED_AT"]),
        }
    except (json.JSONDecodeError, ValueError):
        return None
