from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from typing import Optional

from storage.db import _connect
from storage.config.queries import Q
from service.models.project import Status


# ── DB helpers ────────────────────────────────────────────────────────────────

def ensure_projects_db() -> None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='PROJECT'"
        ).fetchone()
    if row is None:
        raise RuntimeError("PROJECT table not found — run apply_sql_schema first")


# ── Colour helpers ────────────────────────────────────────────────────────────

def color_to_hex(color: int) -> str:
    return f"#{color:06x}"


def color_from_hex(hex_str: str) -> int:
    return int(hex_str.lstrip("#"), 16)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _load_source_fks(project_fk: int) -> list[int]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT p2p.SOURCE_FK FROM PROJECT_TO_PAPER p2p
            JOIN PAPER_ROOTS r ON r.SOURCE_FK = p2p.SOURCE_FK
            WHERE p2p.PROJECT_FK = ? AND r.STATUS = 'active'
            ORDER BY p2p.PROJECT_TO_PAPER_FK
            """,
            (project_fk,),
        ).fetchall()
    return [int(row["SOURCE_FK"]) for row in rows]


def _save_source_fks(conn, project_fk: int, source_fks: list[int]) -> None:
    conn.execute("DELETE FROM PROJECT_TO_PAPER WHERE PROJECT_FK = ?", (project_fk,))
    for sfk in source_fks:
        conn.execute(
            "INSERT INTO PROJECT_TO_PAPER (PROJECT_FK, SOURCE_FK) VALUES (?, ?)",
            (project_fk, sfk),
        )


# ── Data model ────────────────────────────────────────────────────────────────

@dataclass
class Project:
    name:         str
    description:  str                         = ""
    color:        Optional[int]               = None
    project_tags: list[str]                   = field(default_factory=list)
    source_fks:   list[int]                   = field(default_factory=list)
    status:       Status                      = Status.ACTIVE
    id:           Optional[int]               = None
    created_at:   Optional[datetime.datetime] = None
    updated_at:   Optional[datetime.datetime] = None
    archived_at:  Optional[datetime.datetime] = None

    @classmethod
    def from_row(cls, row) -> Project:
        proj_fk = row["PROJECT_FK"]
        source_fks = _load_source_fks(proj_fk) if proj_fk else []
        return cls(
            id           = proj_fk,
            name         = row["NAME"],
            description  = row["DESCRIPTION"] or "",
            color        = int(row["COLOR"]) if row["COLOR"] else None,
            source_fks   = source_fks,
            status       = Status(row["STATUS"]),
            created_at   = row["CREATED_AT"],
            updated_at   = row["UPDATED_AT"],
            archived_at  = row["ARCHIVED_AT"],
        )

    def save(self) -> None:
        now = datetime.datetime.now()
        self.updated_at = now
        if self.id is None:
            self.created_at = now
            with _connect() as conn:
                cur = conn.execute(
                    """
                    INSERT INTO PROJECT
                        (NAME, DESCRIPTION, COLOR, STATUS,
                         CREATED_AT, UPDATED_AT, ARCHIVED_AT)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (self.name, self.description, self.color, self.status,
                     self.created_at, self.updated_at, self.archived_at),
                )
                self.id = cur.lastrowid
                assert self.id 
                _save_source_fks(conn, self.id, self.source_fks)
        else:
            with _connect() as conn:
                conn.execute(
                    """
                    UPDATE PROJECT
                    SET NAME = ?, DESCRIPTION = ?, COLOR = ?, STATUS = ?,
                        UPDATED_AT = ?, ARCHIVED_AT = ?
                    WHERE PROJECT_FK = ?
                    """,
                    (self.name, self.description, self.color, self.status,
                     self.updated_at, self.archived_at, self.id),
                )
                assert self.id 
                _save_source_fks(conn, self.id, self.source_fks)

    def delete(self) -> None:
        self.status      = Status.DELETED
        self.archived_at = datetime.datetime.now()
        self.save()

    def archive(self) -> None:
        self.status      = Status.ARCHIVED
        self.archived_at = datetime.datetime.now()
        self.save()

    def restore(self) -> None:
        self.status      = Status.ACTIVE
        self.archived_at = None
        self.save()

    def add_paper(self, source_fk: int, position: Optional[int] = None) -> None:
        if self.id is None:
            raise ValueError("Project must be saved before papers can be added.")
        if source_fk in self.source_fks:
            return
        if position is None:
            self.source_fks.append(source_fk)
        else:
            self.source_fks.insert(position, source_fk)
        with _connect() as conn:
            _save_source_fks(conn, self.id, self.source_fks)

    def add_papers(self, source_fks: list[int]) -> None:
        if self.id is None:
            raise ValueError("Project must be saved before papers can be added.")
        new_fks = [sfk for sfk in source_fks if sfk not in self.source_fks]
        if not new_fks:
            return
        self.source_fks.extend(new_fks)
        with _connect() as conn:
            _save_source_fks(conn, self.id, self.source_fks)

    def remove_paper(self, source_fk: int) -> None:
        if self.id is None:
            return
        if source_fk not in self.source_fks:
            return
        self.source_fks.remove(source_fk)
        with _connect() as conn:
            _save_source_fks(conn, self.id, self.source_fks)

    def reorder_paper(self, source_fk: int, new_position: int) -> None:
        if self.id is None or source_fk not in self.source_fks:
            return
        self.source_fks.remove(source_fk)
        self.source_fks.insert(new_position, source_fk)
        with _connect() as conn:
            _save_source_fks(conn, self.id, self.source_fks)

    def load_papers(self) -> list[int]:
        return self.source_fks

    @property
    def paper_count(self) -> int:
        return len(self.source_fks)

    def __repr__(self) -> str:
        return f"<Project id={self.id!r} name={self.name!r} status={self.status!r} papers={self.paper_count}>"


# ── Queries ───────────────────────────────────────────────────────────────────

def get_project(project_id: int) -> Optional[Project]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM PROJECT WHERE PROJECT_FK = ?", (project_id,)
        ).fetchone()
    return Project.from_row(row) if row else None


def filter_projects(condition: Q | None = None) -> list[Project]:
    if condition is None:
        sql, params = "SELECT * FROM PROJECT", ()
    else:
        sql    = f"SELECT * FROM PROJECT WHERE {condition.sql}"
        params = condition.params
    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [Project.from_row(row) for row in rows]


def get_paper_project_fks(source_fk: int) -> list[int]:
    """Return PROJECT_FKs of all projects that contain this paper.

    Returns membership regardless of project status (active, archived, deleted).
    Callers that need only active projects must filter the result.
    """
    with _connect() as conn:
        rows = conn.execute(
            "SELECT PROJECT_FK FROM PROJECT_TO_PAPER WHERE SOURCE_FK = ?",
            (source_fk,),
        ).fetchall()
    return [int(r["PROJECT_FK"]) for r in rows]


def remove_paper_from_all_projects(source_fk: int) -> list[int]:
    """Remove a paper from every project. Returns the project FKs it was removed from."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT PROJECT_FK FROM PROJECT_TO_PAPER WHERE SOURCE_FK = ?", (source_fk,)
        ).fetchall()
        fks = [int(r["PROJECT_FK"]) for r in rows]
        if fks:
            conn.execute("DELETE FROM PROJECT_TO_PAPER WHERE SOURCE_FK = ?", (source_fk,))
    return fks


def hard_delete_project(project_fk: int) -> None:
    """Permanently remove a project and all its associations in a single transaction.

    Silently no-ops if project_fk does not exist — all four statements succeed as
    zero-row operations. Callers are responsible for existence checks.

    NOTE rows are not deleted: notes keep their content but lose their project scope.
    TAG rows are not cleaned up; orphan TAGs are an accepted trade-off.
    See docs/adr/0009-orphan-row-policy.md.
    """
    with _connect() as conn:
        conn.execute("DELETE FROM PROJECT_TO_PAPER WHERE PROJECT_FK = ?", (project_fk,))
        conn.execute("DELETE FROM PROJECT_TO_TAG WHERE PROJECT_FK = ?", (project_fk,))
        conn.execute("UPDATE NOTE SET PROJECT_FK = NULL WHERE PROJECT_FK = ?", (project_fk,))
        conn.execute("DELETE FROM PROJECT WHERE PROJECT_FK = ?", (project_fk,))
