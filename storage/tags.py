from __future__ import annotations

from typing import Optional

from .db import _connect
from .config.queries import (
    Q,
    get_tag as _get_tag_row,
    list_tags_by_paper,
    list_tags_by_project,
)
from service.models.tag import TagDetails


def _row_to_tag(row) -> TagDetails:
    return TagDetails(tag_id=row["TAG_FK"], label=row["TAG"])


def get_tag(tag_id: int) -> Optional[TagDetails]:
    row = _get_tag_row(tag_id)
    return _row_to_tag(row) if row is not None else None


def list_tags(
    paper_id:   int | None = None,
    project_id: int | None = None,
    label:      str | None = None,
) -> list[TagDetails]:
    if paper_id is not None:
        rows = list_tags_by_paper(Q("ptt.PAPER_ID = ?", paper_id))
        return [_row_to_tag(r) for r in rows]
    if project_id is not None:
        rows = list_tags_by_project(Q("ptt.PROJECT_FK = ?", project_id))
        return [_row_to_tag(r) for r in rows]
    with _connect() as conn:
        if label is not None:
            rows = conn.execute(
                "SELECT TAG_FK, TAG FROM TAG WHERE TAG = ? COLLATE NOCASE ORDER BY TAG",
                (label,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT TAG_FK, TAG FROM TAG ORDER BY TAG"
            ).fetchall()
    return [TagDetails(tag_id=row["TAG_FK"], label=row["TAG"]) for row in rows]


def create_tag(label: str) -> int | None:
    with _connect() as conn:
        existing = conn.execute(
            "SELECT TAG_FK FROM TAG WHERE TAG = ? COLLATE NOCASE LIMIT 1", (label,)
        ).fetchone()
        if existing is not None:
            return int(existing["TAG_FK"])
        cur = conn.execute("INSERT INTO TAG (TAG) VALUES (?)", (label,))
        return cur.lastrowid


def delete_tag(tag_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM TAG WHERE TAG_FK = ?", (tag_id,))