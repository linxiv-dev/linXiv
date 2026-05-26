"""
Build a migration demo DB for DBeaver inspection.

Usage:
    python tests/build_migration_demo.py [--old OLD_DB] [--new NEW_DB] [--force]

Copies the real v0.1.0 test DB, injects a wide set of edge cases,
then runs the full migration so you can open migration_demo_new.db
in DBeaver and inspect the result.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from pathlib import Path

# Allow running as a standalone script from any directory.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

_DEFAULT_SOURCE = Path(__file__).parent / "test_file" / "papers_v_0_1_0.db"
_DEFAULT_OLD    = Path(__file__).parent / "migration_demo_old.db"
_DEFAULT_NEW    = Path(__file__).parent / "migration_demo_new.db"


# ---------------------------------------------------------------------------
# Edge-case data to inject into the old DB
# ---------------------------------------------------------------------------

def _inject_edge_cases(conn: sqlite3.Connection) -> None:
    """Insert rows that stress every migration path without touching existing data.

    All IDs start at 9000 to avoid conflicts with whatever is already in the DB.
    """

    papers = [
        # (paper_id, version, title, authors_json, tags_json, source,
        #  category, summary, full_text, has_pdf, pdf_path, doi, url,
        #  categories_json, downloaded_source)

        # ── arxiv: multi-version paper ──────────────────────────────────────
        ("9001.00001", 1, "Attention Is All You Need",
         json.dumps(["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"]),
         json.dumps(["transformers", "nlp", "attention"]),
         "arxiv", "cs.CL",
         "We propose a new architecture based solely on attention mechanisms.",
         "The transformer model replaces recurrent layers with multi-head attention.",
         0, None, "10.48550/arXiv.1706.03762", "https://arxiv.org/pdf/1706.03762",
         json.dumps(["cs.CL", "cs.LG"]), 1),

        ("9001.00001", 2, "Attention Is All You Need (v2)",
         json.dumps(["Ashish Vaswani", "Noam Shazeer", "Niki Parmar"]),
         json.dumps(["transformers", "nlp", "attention"]),
         "arxiv", "cs.CL",
         "Revised version with additional experiments.",
         None, 0, None, "10.48550/arXiv.1706.03762", "https://arxiv.org/pdf/1706.03762",
         json.dumps(["cs.CL", "cs.LG"]), 0),

        # ── arxiv: single-token author name ─────────────────────────────────
        ("9001.00002", 1, "Paper by Mononym Author",
         json.dumps(["Turing", "Ada Lovelace"]),
         json.dumps(["history", "computing"]),
         "arxiv", "cs.HC",
         "A historical perspective on computing.",
         None, 0, None, None, None, None, 0),

        # ── arxiv: compound first name ───────────────────────────────────────
        ("9001.00003", 1, "Compound Name Author Paper",
         json.dumps(["Mary Ann Evans", "Jean-Pierre Dupont", "Li Wei"]),
         json.dumps([]),
         "arxiv", "math.CO",
         "Edge case for name splitting.", None, 0, None, None, None, None, 0),

        # ── arxiv: no authors, no tags ───────────────────────────────────────
        ("9001.00004", 1, "Anonymous Minimal Paper",
         json.dumps([]), json.dumps([]),
         "arxiv", None,
         None, None, 0, None, None, None, None, 0),

        # ── arxiv: has PDF, has full_text, has pdf_path ──────────────────────
        ("9001.00005", 1, "Paper With Local PDF",
         json.dumps(["Carol White"]),
         json.dumps(["vision", "ml"]),
         "arxiv", "cs.CV",
         "Visual transformers for image recognition.",
         "Introduction\nThis paper presents a novel approach to image classification.",
         1, "/pdfs/9001.00005v1.pdf",
         "10.1234/example.001", "https://arxiv.org/pdf/9001.00005",
         json.dumps(["cs.CV", "cs.LG"]), 1),

        # ── openalex ─────────────────────────────────────────────────────────
        ("W9000000001", 1, "OpenAlex: Graph Neural Networks Survey",
         json.dumps(["Jure Leskovec", "Rex Ying"]),
         json.dumps(["gnn", "graphs"]),
         "openalex", "cs.LG",
         "A comprehensive survey of graph neural network architectures.",
         None, 0, None, "10.1145/3447548.3467421", None, None, 0),

        # ── crossref / DOI ───────────────────────────────────────────────────
        ("10.1145/3447548.3467422", 1, "CrossRef: Federated Learning at Scale",
         json.dumps(["H. Brendan McMahan", "Eider Moore"]),
         json.dumps(["federated", "privacy", "ml"]),
         "crossref", "cs.DC",
         "Communication-efficient federated learning.", None, 0, None,
         "10.1145/3447548.3467422", "https://doi.org/10.1145/3447548.3467422", None, 0),

        # ── semanticscholar (also maps to doi: prefix) ───────────────────────
        ("10.1038/s41586-021-03819-2", 1, "AlphaFold: Protein Structure Prediction",
         json.dumps(["John Jumper", "Richard Evans"]),
         json.dumps(["biology", "protein", "ml"]),
         "semanticscholar", "q-bio.BM",
         "Highly accurate protein structure prediction with AlphaFold.",
         None, 0, None,
         "10.1038/s41586-021-03819-2", "https://doi.org/10.1038/s41586-021-03819-2", None, 0),

        # ── pdf / local ──────────────────────────────────────────────────────
        ("local:a1b2c3d4e5f6a1b2", 1, "Locally Imported PDF",
         json.dumps(["Unknown Author"]),
         json.dumps(["local", "pdf"]),
         "pdf", None,
         "Auto-extracted from a local PDF file.", None,
         1, "/pdfs/local_import.pdf", None, None, None, 0),

        # ── NULL source (gets linxiv: prefix) ────────────────────────────────
        ("manual:entry:001", 1, "Manually Entered Record",
         json.dumps(["Jake Uribe"]),
         json.dumps(["manual"]),
         None, "cs.IR",
         "A paper entered without an explicit source.", None, 0, None, None, None, None, 0),

        # ── tag deduplication: tags that also appear in project_tags ─────────
        ("9001.00006", 1, "Shared Tag Paper",
         json.dumps(["Alice Smith"]),
         json.dumps(["shared-tag", "ml"]),
         "arxiv", "cs.LG",
         "This paper's tags overlap with a project.", None, 0, None, None, None, None, 0),
    ]

    conn.executemany(
        """INSERT OR IGNORE INTO papers
           (paper_id, version, title, authors, tags, source, category,
            summary, full_text, has_pdf, pdf_path, doi, url, categories, downloaded_source)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        papers,
    )

    # ── projects ─────────────────────────────────────────────────────────────
    projects = [
        # (id, name, description, project_tags, paper_ids, status, color)
        (9001, "Active Demo Project",
         "Contains arxiv and openalex papers.",
         json.dumps(["transformers", "ml", "shared-tag"]),
         json.dumps(["9001.00001", "9001.00005", "W9000000001", "9001.00006"]),
         "active", 0x4A90D9),

        (9002, "Archived Project",
         "An archived project with crossref and semanticscholar papers.",
         json.dumps(["federated", "biology"]),
         json.dumps(["10.1145/3447548.3467422", "10.1038/s41586-021-03819-2"]),
         "archived", 0xE8A838),

        (9003, "Empty Project",
         "A project with no papers — edge case for PROJECT_TO_PAPER.",
         json.dumps([]),
         json.dumps([]),
         "active", None),

        (9004, "Project With No Tags",
         "Tags list is empty.",
         json.dumps([]),
         json.dumps(["9001.00002"]),
         "active", None),
    ]

    conn.executemany(
        """INSERT OR IGNORE INTO projects
           (id, name, description, project_tags, paper_ids, status, color)
           VALUES (?,?,?,?,?,?,?)""",
        projects,
    )

    # ── notes ────────────────────────────────────────────────────────────────
    existing_note_ids = {
        r[0] for r in conn.execute("SELECT id FROM notes").fetchall()
    }

    notes = [
        # (id, paper_id, project_id, title, content, created_at, updated_at)

        # Valid note with timestamps
        (9001, "9001.00001", 9001, "Transformer Note",
         "The multi-head attention mechanism is the key innovation.",
         "2024-01-15 13:00:11", "2024-01-16 00:00:05"),

        # Valid note without timestamps (exercises COALESCE in migration)
        (9002, "9001.00005", 9001, "PDF Note",
         "This paper was downloaded locally.",
         None, None),

        # Note scoped to a project
        (9003, "W9000000001", 9002, "GNN Note in Archived Project",
         "Graph neural networks generalize well.",
         "2024-03-01", "2024-03-02 18:00:11"),

        # Note on a paper not in any project
        (9004, "9001.00003", None, "Standalone Note",
         "Interesting name splitting edge case.", "2024-05-01 18:05:11", None),

        # Orphan note: NULL paper_id — logged as WARNING, not migrated
        (9005, None, 9001, "Orphan Note",
         "This has no paper_id so it cannot be migrated.", "1024-06-01 19:00:11", None),

        # Note referencing a paper that doesn't exist → silently dropped
        (9006, "nonexistent:paper", None, "Dangling Note",
         "References a paper not in papers table.", "2024-07-01 18:09:11", None),
    ]

    for note in notes:
        if note[0] not in existing_note_ids:
            conn.execute(
                """INSERT OR IGNORE INTO notes
                   (id, paper_id, project_id, title, content, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?)""",
                note,
            )

    conn.commit()
    print(f"[demo] Injected {len(papers)} papers, {len(projects)} projects, {len(notes)} notes.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Build migration demo DB for DBeaver.")
    parser.add_argument("--old", default=str(_DEFAULT_OLD),
                        help=f"Enriched old DB to write (default: {_DEFAULT_OLD.name})")
    parser.add_argument("--new", default=str(_DEFAULT_NEW),
                        help=f"Migrated new DB to write (default: {_DEFAULT_NEW.name})")
    parser.add_argument("--source", default=str(_DEFAULT_SOURCE),
                        help=f"Base old DB to copy from (default: {_DEFAULT_SOURCE})")
    parser.add_argument("--force", action="store_true",
                        help="Overwrite existing output files")
    args = parser.parse_args()

    source = Path(args.source)
    old_path = Path(args.old)
    new_path = Path(args.new)

    if not source.exists():
        print(f"[demo] Source DB not found: {source}", file=sys.stderr)
        sys.exit(1)

    if old_path.exists() and not args.force:
        print(f"[demo] {old_path} already exists — pass --force to overwrite.", file=sys.stderr)
        sys.exit(1)

    # Copy source → enriched old DB
    print(f"[demo] Copying {source} → {old_path}")
    shutil.copy2(source, old_path)

    # Inject edge cases
    conn = sqlite3.connect(str(old_path))
    try:
        _inject_edge_cases(conn)
    finally:
        conn.close()

    # Migrate
    print(f"[demo] Migrating {old_path} → {new_path}")
    from migrate_db import run_migration
    run_migration(str(old_path), str(new_path), force=args.force)

    print()
    print(f"[demo] Done.")
    print(f"  Old DB (pre-migration):  {old_path.resolve()}")
    print(f"  New DB (post-migration): {new_path.resolve()}")
    print()
    print("Open both files in DBeaver to compare schemas and data.")


if __name__ == "__main__":
    main()