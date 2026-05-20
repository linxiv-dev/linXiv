from __future__ import annotations

import user_settings
from .db import _connect


def add_term(term: str) -> None:
    """Record a search term, incrementing use_count if already present."""
    if not user_settings.get("search_history_enabled"):
        return
    stripped = term.strip()
    if not stripped:
        return
    raw = user_settings.get("search_history_max")
    max_history: int = int(raw) if raw is not None else 200
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO SEARCH_HISTORY (TERM, USE_COUNT, LAST_USED_AT)
            VALUES (?, 1, datetime('now'))
            ON CONFLICT(TERM) DO UPDATE SET
                USE_COUNT    = USE_COUNT + 1,
                LAST_USED_AT = datetime('now')
            """,
            (stripped,),
        )
        conn.execute(
            "DELETE FROM SEARCH_HISTORY WHERE HISTORY_ID NOT IN ("
            "  SELECT HISTORY_ID FROM SEARCH_HISTORY"
            "  ORDER BY LAST_USED_AT DESC, USE_COUNT DESC"
            "  LIMIT ?"
            ")",
            (max_history,),
        )


def get_suggestions(prefix: str, limit: int = 10) -> list[str]:
    """Return up to `limit` history terms that start with `prefix`."""
    stripped = prefix.strip()
    if not stripped:
        return []
    pattern = stripped + "%"
    with _connect() as conn:
        rows = conn.execute(
            "SELECT TERM FROM SEARCH_HISTORY WHERE TERM LIKE ? COLLATE NOCASE "
            "ORDER BY USE_COUNT DESC, LAST_USED_AT DESC LIMIT ?",
            (pattern, limit),
        ).fetchall()
    return [str(r["TERM"]) for r in rows]
