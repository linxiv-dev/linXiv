-- =============================================================================
-- Data migration: old (blue) -> new (green)
-- Run this AGAINST the new DB, AFTER the DDL files have created the schema.
-- The old DB must be ATTACHed as `old` before running.
--
-- Assumes (from your clarifications):
--   * old.papers.paper_id is a natural string id (e.g. '2401.12345')
--   * (paper_id, version) is unique in old.papers
--   * old.papers.authors / tags are JSON arrays of strings
--   * old.projects.paper_ids is a JSON array of old paper_id strings
--   * old.projects.project_tags is a JSON array of tag strings
--   * old.notes carries no version info -> migrate as paper-level (PAPER_ID_FK NULL)
--   * source string in old.papers (e.g. 'arxiv') becomes PAPER_META.PROVIDER
--
-- One row per unique paper_id in old.papers becomes one PAPER_ROOTS row.
-- SOURCE_ID in new schema == old paper_id string (the natural id).
-- =============================================================================

PRAGMA foreign_keys = OFF;
BEGIN;

-- ---------------------------------------------------------------------------
-- Scratch mapping tables (dropped at end). Use temp so they vanish on COMMIT
-- end-of-connection; explicit DROPs at the bottom too for safety.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE map_paper (
    old_paper_id TEXT NOT NULL,
    old_version  INTEGER NOT NULL,
    new_paper_id INTEGER NOT NULL,   -- the integer surrogate from PAPER
    source_fk    INTEGER NOT NULL,
    PRIMARY KEY (old_paper_id, old_version)
);

-- ---------------------------------------------------------------------------
-- 1. PAPER_ROOTS: one row per distinct old paper_id
--    SOURCE_ID := old paper_id (natural id like '2401.12345')
-- ---------------------------------------------------------------------------

INSERT INTO PAPER_ROOTS (SOURCE_ID)
SELECT DISTINCT paper_id
FROM old.papers
WHERE paper_id IS NOT NULL
ORDER BY paper_id;

-- ---------------------------------------------------------------------------
-- 2. AUTHOR: one row per distinct author name across all papers.
--    AUTHOR_FULL_NAME only; AUTHOR_FIRST / AUTHOR_LAST are populated by the
--    Python wrapper (SQLite has no reverse()/rinstr(), so a SQL-only split
--    is brittle).
-- ---------------------------------------------------------------------------

INSERT INTO AUTHOR (AUTHOR_FULL_NAME)
SELECT DISTINCT TRIM(j.value)
FROM old.papers p, json_each(p.authors) j
WHERE TRIM(j.value) <> ''
ORDER BY TRIM(j.value);

-- ---------------------------------------------------------------------------
-- 3. TAG: one row per distinct tag string across all papers AND projects
-- ---------------------------------------------------------------------------

INSERT INTO TAG (TAG)
SELECT DISTINCT TRIM(t) AS tag FROM (
    SELECT j.value AS t FROM old.papers p, json_each(p.tags) j
    WHERE TRIM(j.value) <> ''
    UNION
    SELECT j.value AS t FROM old.projects pr, json_each(pr.project_tags) j
    WHERE TRIM(j.value) <> ''
);

-- ---------------------------------------------------------------------------
-- 4. PROJECT: copy from old.projects, preserving id as PROJECT_FK
-- ---------------------------------------------------------------------------

INSERT INTO PROJECT (PROJECT_FK, NAME, DESCRIPTION, COLOR, STATUS, PROJECT_TAGS,
                     CREATED_AT, UPDATED_AT, ARCHIVED_AT)
SELECT
    id,
    name,
    COALESCE(description, ''),
    color,
    COALESCE(status, 'active'),
    project_tags,
    created_at,
    updated_at,
    archived_at
FROM old.projects;

-- ---------------------------------------------------------------------------
-- 5. PAPER: one row per (paper_id, version) in old.papers
--    SOURCE_ID = old.paper_id; SOURCE_FK looked up from PAPER_ROOTS
-- ---------------------------------------------------------------------------

INSERT INTO PAPER (SOURCE_ID, VERSION, TITLE, CATEGORY, HAS_PDF, SOURCE_FK)
SELECT
    p.paper_id,
    p.version,
    COALESCE(p.title, ''),
    p.category,
    COALESCE(p.has_pdf, 0),
    pr.SOURCE_FK
FROM old.papers p
JOIN PAPER_ROOTS pr ON pr.SOURCE_ID = p.paper_id;

-- Populate the mapping table for downstream FK lookups
INSERT INTO map_paper (old_paper_id, old_version, new_paper_id, source_fk)
SELECT p.SOURCE_ID, p.VERSION, p.PAPER_ID, p.SOURCE_FK
FROM PAPER p;

-- ---------------------------------------------------------------------------
-- 6. PAPER_META: one row per PAPER row
--    AUTHORS / TAGS / CATEGORIES stored as JSON strings (the LIST columns)
-- ---------------------------------------------------------------------------

INSERT INTO PAPER_META (
    PAPER_ID, URL, PUBLISHED, UPDATED, CATEGORIES, DOI, JOURNAL_REF,
    COMMENT, SUMMARY, PROVIDER, PDF_PATH, FULL_TEXT, DOWNLOADED_SOURCE,
    AUTHORS, TAGS
)
SELECT
    m.new_paper_id,
    p.url,
    p.published,
    p.updated,
    p.categories,
    p.doi,
    p.journal_ref,
    p.comment,
    p.summary,
    COALESCE(p.source, 'arxiv'),
    p.pdf_path,
    p.full_text,
    COALESCE(p.downloaded_source, 0),
    p.authors,
    p.tags
FROM old.papers p
JOIN map_paper m
  ON m.old_paper_id = p.paper_id AND m.old_version = p.version;

-- ---------------------------------------------------------------------------
-- 7. PAPER_TO_AUTHOR: explode old.papers.authors JSON array
--    AUTHOR_INDEX preserved from JSON ordering (json_each.key gives 0-based idx)
-- ---------------------------------------------------------------------------

INSERT INTO PAPER_TO_AUTHOR (PAPER_ID, AUTHOR_FK, AUTHOR_INDEX)
SELECT
    m.new_paper_id,
    a.AUTHOR_FK,
    j.key AS author_index
FROM old.papers p
JOIN map_paper m
  ON m.old_paper_id = p.paper_id AND m.old_version = p.version
JOIN json_each(p.authors) j
JOIN AUTHOR a ON a.AUTHOR_FULL_NAME = TRIM(j.value)
WHERE TRIM(j.value) <> '';

-- ---------------------------------------------------------------------------
-- 8. PAPER_TO_TAG: explode old.papers.tags JSON array
--    Populates both the integer PAPER_ID FK and the (SOURCE_ID, VERSION) pair
-- ---------------------------------------------------------------------------

INSERT INTO PAPER_TO_TAG (PAPER_ID, SOURCE_ID, VERSION, TAG_FK)
SELECT
    m.new_paper_id,
    p.paper_id,
    p.version,
    t.TAG_FK
FROM old.papers p
JOIN map_paper m
  ON m.old_paper_id = p.paper_id AND m.old_version = p.version
JOIN json_each(p.tags) j
JOIN TAG t ON t.TAG = TRIM(j.value)
WHERE TRIM(j.value) <> '';

-- ---------------------------------------------------------------------------
-- 9. PROJECT_TO_PAPER: explode old.projects.paper_ids JSON array
--    Maps each old paper_id string -> SOURCE_FK in PAPER_ROOTS
--    PROJECT_TO_PAPER_FK has no AUTOINCREMENT in your DDL so we synthesize one.
-- ---------------------------------------------------------------------------

INSERT INTO PROJECT_TO_PAPER (PROJECT_TO_PAPER_FK, PROJECT_FK, SOURCE_FK)
SELECT
    row_number() OVER (ORDER BY pr.id, j.key) AS pk,
    pr.id,
    roots.SOURCE_FK
FROM old.projects pr
JOIN json_each(pr.paper_ids) j
JOIN PAPER_ROOTS roots ON roots.SOURCE_ID = TRIM(j.value)
WHERE TRIM(j.value) <> '';

-- ---------------------------------------------------------------------------
-- 10. PROJECT_TO_TAG: explode old.projects.project_tags JSON array
-- ---------------------------------------------------------------------------

INSERT INTO PROJECT_TO_TAG (PROJECT_TO_TAG_FK, PROJECT_FK, TAG_FK)
SELECT
    row_number() OVER (ORDER BY pr.id, j.key) AS pk,
    pr.id,
    t.TAG_FK
FROM old.projects pr
JOIN json_each(pr.project_tags) j
JOIN TAG t ON t.TAG = TRIM(j.value)
WHERE TRIM(j.value) <> '';

-- ---------------------------------------------------------------------------
-- 11. NOTE: copy from old.notes.
--     Old schema has no version on notes -> SOURCE_FK only, PAPER_ID_FK NULL.
--     NOTE_SK reuses old.notes.id.
-- ---------------------------------------------------------------------------

INSERT INTO NOTE (NOTE_SK, SOURCE_FK, PAPER_ID_FK, PROJECT_FK,
                  TITLE, NOTE, CREATED_AT, UPDATED_AT)
SELECT
    n.id,
    roots.SOURCE_FK,
    NULL,                              -- paper-level, not version-pinned
    n.project_id,
    n.title,
    n.content,
    COALESCE(n.created_at, date('now')),
    COALESCE(n.updated_at, date('now'))
FROM old.notes n
JOIN PAPER_ROOTS roots ON roots.SOURCE_ID = n.paper_id;

-- Notes with no paper_id (project-level notes): keep them, but they need a
-- SOURCE_FK which is NOT NULL in your schema. This is a schema/data mismatch:
-- if any old.notes rows have NULL paper_id, they cannot be migrated as-is.
-- Surface them so the operator sees the loss:

-- (Just a count via a temp table for the wrapper to log)
CREATE TEMP TABLE _orphan_notes_count AS
SELECT COUNT(*) AS n FROM old.notes WHERE paper_id IS NULL;

-- ---------------------------------------------------------------------------
-- 12. Rebuild papers_fts from PAPER_META.FULL_TEXT
--     rowid = new integer PAPER_ID so search results map back trivially.
-- ---------------------------------------------------------------------------

INSERT INTO papers_fts (rowid, paper_id, full_text)
SELECT
    pm.PAPER_ID,
    p.SOURCE_ID,
    pm.FULL_TEXT
FROM PAPER_META pm
JOIN PAPER p ON p.PAPER_ID = pm.PAPER_ID
WHERE pm.FULL_TEXT IS NOT NULL AND pm.FULL_TEXT <> '';

-- ---------------------------------------------------------------------------
-- Cleanup
-- ---------------------------------------------------------------------------

DROP TABLE map_paper;

COMMIT;
PRAGMA foreign_keys = ON;
