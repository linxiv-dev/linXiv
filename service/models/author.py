from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class BasicAuthorDetails:
    author_id:  int
    orcid:      str | None = None
    full_name:  str | None = None
    first_name: str | None = None
    last_name:  str | None = None


@dataclass
class FullAuthorDetails(BasicAuthorDetails):
    paper_ids: Optional[list[int]] = None


@dataclass
class AuthorWithCount(BasicAuthorDetails):
    paper_count: int = 0


@dataclass
class AuthorPaperPreview:
    paper_id:  int
    source_id: str
    source_fk: int
    version:   int
    title:     str | None = None