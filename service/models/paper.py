from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


@dataclass
class PaperDetails:
    paper_id:          int
    source_id:         str
    version:           int
    title:             str
    summary:           str | None       = None
    published:         date | None      = None
    updated:           date | None      = None
    url:               str | None       = None
    doi:               str | None       = None
    category:          str | None       = None
    categories:        list[str] | None = field(default_factory=list)
    journal_ref:       str | None       = None
    comment:           str | None       = None
    authors:           list[str] | None = field(default_factory=list)
    tags:              list[str] | None = field(default_factory=list)
    has_pdf:           bool             = False
    pdf_path:          str | None       = None
    source:            str | None       = None
    full_text:         str | None       = None
    downloaded_source: bool             = False
    source_fk:         int | None       = None

    def to_dict(self) -> dict:
        return {
            "paper_id":          self.paper_id,
            "source_id":         self.source_id,
            "version":           self.version,
            "title":             self.title,
            "summary":           self.summary,
            "published":         self.published.isoformat() if self.published else None,
            "updated":           self.updated.isoformat() if self.updated else None,
            "url":               self.url,
            "doi":               self.doi,
            "category":          self.category,
            "categories":        self.categories,
            "journal_ref":       self.journal_ref,
            "comment":           self.comment,
            "authors":           self.authors or [],
            "tags":              self.tags or [],
            "has_pdf":           self.has_pdf,
            "pdf_path":          self.pdf_path,
            "source":            self.source,
            "full_text":         self.full_text,
            "downloaded_source": self.downloaded_source,
            "source_fk":         self.source_fk,
        }


@dataclass
class PaperDetailsAll:
    """Aggregate view of a paper across all stored versions.

    Display fields (title, summary, authors) come from the latest version by
    default; stable metadata (doi, url, categories, tags) is shared.
    All individual versions are available via `versions`, oldest-first.
    """
    source_id:      str
    latest_version: int
    title:          str                        # latest version
    authors:        list[str] | None           = field(default_factory=list)   # latest version
    summary:        str | None                 = None                          # latest version
    published:      date | None                = None                          # first-version date
    updated:        date | None                = None                          # latest-version date
    doi:            str | None                 = None
    url:            str | None                 = None
    category:       str | None                 = None
    categories:     list[str] | None           = field(default_factory=list)
    journal_ref:    str | None                 = None
    comment:        str | None                 = None
    tags:           list[str] | None           = field(default_factory=list)
    source:         str | None                 = None
    versions:       list[PaperDetails]         = field(default_factory=list)