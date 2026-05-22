from __future__ import annotations

from typing import Optional

from .db import _connect
from .config.queries import (
    Q,
    _TAG_FK_BY_LABEL_SQL,
    get_tag as _get_tag_row,
    list_tags_by_paper,
    list_tags_by_project,
)
from service.models.tag import TagDetails


def _row_to_tag(row) -> TagDetails:
    return TagDetails(tag_id=row["TAG_FK"], label=row["TAG"])


def get_tag(tag_id: int) -> Optional[TagDetails]:
    row = _get_tag_row(tag_id)
    return _row_to_tag(row) if row else None


def list_tags(
    paper_id:   int | None = None,
    project_id: int | None = None,
    label:      str | None = None,
) -> list[TagDetails]:
    if paper_id:
        rows = list_tags_by_paper(Q("ptt.PAPER_ID = ?", paper_id))
        return [_row_to_tag(r) for r in rows]
    if project_id:
        rows = list_tags_by_project(Q("ptt.PROJECT_FK = ?", project_id))
        return [_row_to_tag(r) for r in rows]
    with _connect() as conn:
        if label:
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
        existing = conn.execute(_TAG_FK_BY_LABEL_SQL, (label,)).fetchone()
        if existing:
            return int(existing["TAG_FK"])
        cur = conn.execute("INSERT INTO TAG (TAG) VALUES (?)", (label,))
        return cur.lastrowid


def delete_tag(tag_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM TAG WHERE TAG_FK = ?", (tag_id,))


def get_project_tags(project_id: int) -> list[str]:
    rows = list_tags_by_project(Q("ptt.PROJECT_FK = ?", project_id))
    return [row["TAG"] for row in rows]


def add_project_tags(project_id: int, tags: list[str]) -> list[str]:
    with _connect() as conn:
        tag_fks: list[int] = []
        seen: set[str] = set()
        for label in tags:
            label = label.strip()
            if not label or label.lower() in seen:
                continue
            seen.add(label.lower())
            # INSERT OR IGNORE + re-SELECT: safe under the UNIQUE INDEX on TAG(TAG COLLATE NOCASE).
            # A concurrent insert for the same label causes the IGNORE; the re-SELECT then
            # finds the row committed by the other writer.
            conn.execute("INSERT OR IGNORE INTO TAG (TAG) VALUES (?)", (label,))
            row = conn.execute(_TAG_FK_BY_LABEL_SQL, (label,)).fetchone()
            if row is None:
                raise RuntimeError(f"Could not get or create TAG for label {label!r}")
            tag_fks.append(int(row["TAG_FK"]))
        for tag_fk in tag_fks:
            conn.execute(
                "INSERT OR IGNORE INTO PROJECT_TO_TAG (PROJECT_FK, TAG_FK) VALUES (?, ?)",
                (project_id, tag_fk),
            )
    return get_project_tags(project_id)


def remove_project_tags(project_id: int, tags: list[str]) -> list[str]:
    with _connect() as conn:
        for label in tags:
            row = conn.execute(_TAG_FK_BY_LABEL_SQL, (label,)).fetchone()
            if row:
                conn.execute(
                    "DELETE FROM PROJECT_TO_TAG WHERE PROJECT_FK = ? AND TAG_FK = ?",
                    (project_id, int(row["TAG_FK"])),
                )
    return get_project_tags(project_id)