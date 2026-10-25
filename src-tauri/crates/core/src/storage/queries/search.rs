use std::collections::HashMap;

use rusqlite::Connection;

use crate::error::Result;
use crate::models::PaperDetails;

/// FTS5 over TeX source AND note content: the latest version of each matching
/// paper, ranked by bm25 (lower = better); a paper matched both ways (or on
/// several versions' bodies) takes its best score.
///
/// `papers_fts.source_id` is the lineage string that `latest_papers` is then
/// read by — a hit on an older version's body still surfaces the paper as its
/// latest version; notes_fts carries SOURCE_FK, joined back through
/// PAPER_ROOTS. `match_expr` turns raw input into FTS5 syntax; an index that
/// cannot be queried is an error, never an empty result.
pub fn search_full_text(conn: &Connection, query: &str, limit: i64) -> Result<Vec<PaperDetails>> {
    let limit = limit.clamp(0, 1000);
    let Some(expr) = match_expr(query) else {
        return Ok(Vec::new());
    };
    // Each branch keeps only its own top-`limit` (bm25 ascending = best first),
    // so a whole-library match ("the" over a TeX corpus) never crosses the FFI.
    // Sound for the min-merge below: a paper outside both branch top-`limit`s is
    // beaten by `limit` papers whose merged score is at least as good. Both
    // branches are many rows per paper (one per version body / per NOTE), so
    // each groups to per-paper best before limiting — a row-limit could crowd a
    // distinct paper out behind one many-version or many-note paper.
    // MATERIALIZED is load-bearing: flattened, bm25() would land inside min(),
    // which FTS5 refuses. No STATUS gate on the papers branch: papers_fts only
    // ever holds active roots' rows (delete sites + triggers drop the rest).
    let mut best: HashMap<String, f64> = HashMap::new();
    for (sid, score) in fts_matches(
        conn,
        "WITH p AS MATERIALIZED (SELECT source_id, bm25(papers_fts) AS score \
             FROM papers_fts WHERE papers_fts MATCH ?1) \
         SELECT source_id, min(score) FROM p \
         GROUP BY source_id ORDER BY 2 LIMIT ?2",
        &expr,
        limit,
    )?
    .into_iter()
    .chain(fts_matches(
        conn,
        "WITH n AS MATERIALIZED (SELECT source_fk, bm25(notes_fts) AS score \
             FROM notes_fts WHERE notes_fts MATCH ?1) \
         SELECT r.SOURCE_ID, min(n.score) FROM n \
         JOIN PAPER_ROOTS r ON r.SOURCE_FK = n.source_fk \
         WHERE r.STATUS = 'active' \
         GROUP BY r.SOURCE_ID ORDER BY 2 LIMIT ?2",
        &expr,
        limit,
    )?) {
        best.entry(sid)
            .and_modify(|s| {
                if score < *s {
                    *s = score;
                }
            })
            .or_insert(score);
    }

    let mut scored: Vec<(String, f64)> = best.into_iter().collect();
    scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(limit as usize);
    if scored.is_empty() {
        return Ok(Vec::new());
    }

    let sql = format!(
        "SELECT {} FROM latest_papers WHERE source_id IN ({})",
        super::paper::PAPER_COLUMNS_NO_TEXT,
        vec!["?"; scored.len()].join(", ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let ids: Vec<&str> = scored.iter().map(|(sid, _)| sid.as_str()).collect();
    // Manual loop (not query_map): row_to_paper returns CoreError on a bad
    // DATE/LIST decode, which query_map's rusqlite::Result closure can't carry.
    let mut rows = stmt.query(rusqlite::params_from_iter(ids))?;
    let mut by_source_id: HashMap<String, PaperDetails> = HashMap::new();
    while let Some(row) = rows.next()? {
        let details = super::paper::row_to_paper(row)?;
        by_source_id.insert(details.source_id.clone(), details);
    }
    Ok(scored
        .into_iter()
        .filter_map(|(sid, _)| by_source_id.remove(&sid))
        .collect())
}

/// Rewrite raw search box input into an FTS5 MATCH expression. FTS5 reads
/// `-`/`:` as column-filter syntax and rejects stray punctuation, so each bare
/// word becomes a quoted phrase (tokenized like the document, so
/// `encoder-decoder` still matches). Double-quoted phrases, AND/OR/NOT, and a
/// trailing `*` are preserved. `None` when nothing searchable is left — an
/// empty MATCH is itself an error.
/// `ponytail: NEAR()/^ are not preserved (they'd need a real parser); they
/// fall through to a literal term search.`
fn match_expr(raw: &str) -> Option<String> {
    // FTS5 reads its query as a C string; an embedded NUL truncates it before
    // the closing quote is seen, so strip NUL up front.
    let raw: String = raw.chars().filter(|&c| c != '\0').collect();
    let mut out: Vec<String> = Vec::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            continue;
        }
        if c == '"' {
            // A phrase the user quoted: take everything up to the closing quote,
            // or to end of input if they never typed one.
            let mut phrase = String::new();
            for c in chars.by_ref() {
                if c == '"' {
                    break;
                }
                phrase.push(c);
            }
            let prefix = chars.next_if_eq(&'*').is_some();
            push_term(&mut out, &phrase, prefix);
            continue;
        }
        let mut tok = String::from(c);
        while let Some(&next) = chars.peek() {
            if next.is_whitespace() || next == '"' {
                break;
            }
            tok.push(next);
            chars.next();
        }
        match_expr_helper(&mut out, &tok);
    }
    if is_operator(out.last()) {
        out.pop();
    }
    (!out.is_empty()).then(|| out.join(" "))
}

/// Classifies one raw token as an FTS5 operator (AND/OR/NOT, kept only after
/// a term) or a term/prefix (via `push_term`).
fn match_expr_helper(out: &mut Vec<String>, tok: &str) {
    let prefix = tok.ends_with('*');
    let body = tok.strip_suffix('*').unwrap_or(tok);
    if !prefix && matches!(body, "AND" | "OR" | "NOT") {
        // Two operators in a row (or a leading one) is a syntax error.
        if !out.is_empty() && !is_operator(out.last()) {
            out.push(body.to_string());
        }
    } else {
        push_term(out, body, prefix);
    }
}

fn is_operator(tok: Option<&String>) -> bool {
    matches!(tok.map(String::as_str), Some("AND" | "OR" | "NOT"))
}

/// Push one term as a quoted FTS5 phrase.
fn push_term(out: &mut Vec<String>, term: &str, prefix: bool) {
    // FTS5 drops punctuation when tokenizing, so an all-punctuation term is an
    // empty phrase matching nothing; alone it yields `None`.
    if !term.chars().any(char::is_alphanumeric) {
        return;
    }
    out.push(if prefix {
        format!("\"{term}\"*")
    } else {
        format!("\"{term}\"")
    });
}

/// Run one FTS MATCH query, returning (source_id, bm25 score) pairs. A missing,
/// corrupt, or unqueryable index propagates: callers must be able to tell a
/// broken search from one that genuinely found nothing.
fn fts_matches(
    conn: &Connection,
    sql: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<(String, f64)>> {
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.query((query, limit))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push((row.get(0)?, row.get(1)?));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{self, db};
    use chrono::NaiveDate;

    fn seed(conn: &Connection, source_id: &str, full_text: &str) {
        conn.execute(
            "INSERT INTO PAPER_ROOTS (SOURCE_ID) VALUES (?1)",
            [source_id],
        )
        .unwrap();
        let source_fk: i64 = conn
            .query_row(
                "SELECT SOURCE_FK FROM PAPER_ROOTS WHERE SOURCE_ID = ?1",
                [source_id],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO PAPER (SOURCE_ID, VERSION, TITLE, CATEGORY, HAS_PDF, SOURCE_FK) \
             VALUES (?1, 1, ?2, 'cs.LG', 1, ?3)",
            rusqlite::params![source_id, "A Title", source_fk],
        )
        .unwrap();
        let paper_id: i64 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO PAPER_META (PAPER_ID, PUBLISHED, AUTHORS, TAGS, SUMMARY, FULL_TEXT) \
             VALUES (?1, '2024-03-05', '[\"Ada\"]', '[\"ml\"]', 'sum', ?2)",
            rusqlite::params![paper_id, full_text],
        )
        .unwrap();
        // No hand-insert into papers_fts: the PAPER_META write above fires the
        // sync trigger. Seeding it too would give each fixture paper two index
        // rows, not the one-per-paper shape production has.
    }

    #[test]
    fn matches_on_tex_source_and_maps_fields() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(
            &conn,
            "arxiv:2204.12985",
            "the manifold hypothesis in latent space",
        );
        seed(
            &conn,
            "arxiv:1111.00000",
            "unrelated quantum chromodynamics",
        );

        let hits = search_full_text(&conn, "manifold", 20).unwrap();
        assert_eq!(hits.len(), 1);
        let p = &hits[0];
        assert_eq!(p.source_id, "arxiv:2204.12985");
        assert_eq!(p.version, 1);
        assert_eq!(p.title, "A Title");
        assert_eq!(p.published, NaiveDate::from_ymd_opt(2024, 3, 5));
        assert_eq!(p.authors, vec!["Ada".to_string()]);
        assert_eq!(p.tags, vec!["ml".to_string()]);
        assert!(p.has_pdf);

        assert_eq!(
            search_full_text(&conn, "nonexistentterm", 20)
                .unwrap()
                .len(),
            0
        );
    }

    /// Per-version indexing's user-visible delta: a term only in an OLDER
    /// version's body still surfaces the paper, hydrated as its latest version
    /// — exactly how notes-branch hits already behave.
    #[test]
    fn old_version_only_match_surfaces_the_paper_as_latest() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(
            &conn,
            "arxiv:2204.12985",
            "the vanished appendix on kelpie dynamics",
        );
        conn.execute_batch(
            "INSERT INTO PAPER (SOURCE_ID, VERSION, TITLE, CATEGORY, HAS_PDF, SOURCE_FK)
             SELECT SOURCE_ID, 2, 'A Title', CATEGORY, HAS_PDF, SOURCE_FK
             FROM PAPER WHERE SOURCE_ID = 'arxiv:2204.12985';
             INSERT INTO PAPER_META (PAPER_ID, PUBLISHED, AUTHORS, TAGS, SUMMARY, FULL_TEXT)
             SELECT PAPER_ID, '2024-04-01', '[\"Ada\"]', '[\"ml\"]', 'sum', 'a rewritten second version'
             FROM PAPER WHERE SOURCE_ID = 'arxiv:2204.12985' AND VERSION = 2;",
        )
        .unwrap();

        // Only v1's body has the term; the hit hydrates as the latest version.
        let hits = search_full_text(&conn, "kelpie", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source_id, "arxiv:2204.12985");
        assert_eq!(hits[0].version, 2);

        // A term both versions share still yields one result, not two.
        let hits = search_full_text(&conn, "version OR dynamics", 20).unwrap();
        assert_eq!(hits.len(), 1);
    }

    /// The papers branch limits distinct PAPERS, not FTS rows: one paper with
    /// many matching version bodies must not crowd another paper out of the cap.
    #[test]
    fn many_version_paper_does_not_crowd_out_another_within_limit() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(&conn, "arxiv:1", "ocelot ocelot ocelot");
        seed(
            &conn,
            "arxiv:2",
            "one ocelot in a longer digression elsewhere",
        );
        for v in 2..=4 {
            conn.execute_batch(&format!(
                "INSERT INTO PAPER (SOURCE_ID, VERSION, TITLE, CATEGORY, HAS_PDF, SOURCE_FK)
                 SELECT SOURCE_ID, {v}, TITLE, CATEGORY, HAS_PDF, SOURCE_FK
                 FROM PAPER WHERE SOURCE_ID = 'arxiv:1' AND VERSION = 1;
                 INSERT INTO PAPER_META (PAPER_ID, PUBLISHED, AUTHORS, TAGS, SUMMARY, FULL_TEXT)
                 SELECT PAPER_ID, '2024-03-05', '[\"Ada\"]', '[\"ml\"]', 'sum', 'ocelot ocelot ocelot v{v}'
                 FROM PAPER WHERE SOURCE_ID = 'arxiv:1' AND VERSION = {v};"
            ))
            .unwrap();
        }

        let mut sids: Vec<String> = search_full_text(&conn, "ocelot", 2)
            .unwrap()
            .into_iter()
            .map(|p| p.source_id)
            .collect();
        sids.sort();
        assert_eq!(sids, ["arxiv:1", "arxiv:2"]);
    }

    #[test]
    fn matches_on_note_content() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(&conn, "arxiv:2204.12985", "some tex source");

        // A note whose distinctive term appears in no paper's full text; the
        // notes_fts AFTER-INSERT trigger indexes it, so the FTS path finds it.
        conn.execute(
            "INSERT INTO NOTE (SOURCE_FK, TITLE, NOTE) \
             SELECT SOURCE_FK, 'n', 'zephyranthes reminder' \
             FROM PAPER_ROOTS WHERE SOURCE_ID = ?1",
            ["arxiv:2204.12985"],
        )
        .unwrap();

        let hits = search_full_text(&conn, "zephyranthes", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source_id, "arxiv:2204.12985");
    }

    #[test]
    fn dedupes_paper_matched_in_both_indexes() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(
            &conn,
            "arxiv:2204.12985",
            "the manifold hypothesis in latent space",
        );
        conn.execute(
            "INSERT INTO NOTE (SOURCE_FK, TITLE, NOTE) \
             SELECT SOURCE_FK, 'n', 'manifold reading notes' \
             FROM PAPER_ROOTS WHERE SOURCE_ID = ?1",
            ["arxiv:2204.12985"],
        )
        .unwrap();

        let hits = search_full_text(&conn, "manifold", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source_id, "arxiv:2204.12985");
    }

    /// Punctuation FTS5 reads as syntax is searched for literally instead. All
    /// but `encod*` raised before, and a raise reads as "no matches" — so the
    /// search silently returned nothing for terms all over a TeX corpus.
    #[test]
    fn punctuation_in_a_query_searches_instead_of_raising() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(
            &conn,
            "arxiv:2204.12985",
            "the encoder-decoder model is state-of-the-art for c++ at 50% recall",
        );
        seed(
            &conn,
            "arxiv:1111.00000",
            "unrelated quantum chromodynamics",
        );

        for q in [
            "encoder-decoder",
            "state-of-the-art",
            "c++",
            "50%",
            "-encoder",
            "recall:",
            "(encoder",
            "encoder-decoder AND c++",
            "encod*",
        ] {
            let hits = search_full_text(&conn, q, 20).unwrap();
            assert_eq!(hits.len(), 1, "query {q:?} found {} papers", hits.len());
            assert_eq!(hits[0].source_id, "arxiv:2204.12985", "query {q:?}");
        }
    }

    /// A query with no searchable token can't become a MATCH expression (an
    /// empty one raises), so it returns no results rather than erroring.
    #[test]
    fn a_query_with_nothing_to_search_returns_no_results() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(&conn, "arxiv:2204.12985", "the manifold hypothesis");

        for q in ["", "   ", "-", "%%%", "AND", "OR OR"] {
            assert!(
                search_full_text(&conn, q, 20).unwrap().is_empty(),
                "query {q:?} should find nothing"
            );
        }
    }

    /// A missing or corrupt index is a broken search, not one that found
    /// nothing. Callers (MCP included) must get the error so they can't read
    /// failure as "no match".
    #[test]
    fn a_broken_fts_index_is_an_error_not_an_empty_result() {
        for table in ["papers_fts", "notes_fts"] {
            let conn = db::open_in_memory().unwrap();
            storage::init_db(&conn).unwrap();
            conn.execute_batch(&format!("DROP TABLE {table};")).unwrap();
            assert!(
                search_full_text(&conn, "manifold", 20).is_err(),
                "a missing {table} must fail the search"
            );
        }
    }

    /// Column-filter syntax (`full_text:foo`) used to reach FTS5 and is now read
    /// as literal text — the trade for making hyphens work. A plain query
    /// still finds the paper.
    #[test]
    fn column_filter_syntax_is_searched_as_text() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(
            &conn,
            "arxiv:2204.12985",
            "the manifold hypothesis in latent space",
        );

        assert!(search_full_text(&conn, "full_text:manifold", 20)
            .unwrap()
            .is_empty());
        let hits = search_full_text(&conn, "manifold hypothesis", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source_id, "arxiv:2204.12985");
    }

    /// Quoted phrases stay phrases, so word order still narrows a search.
    #[test]
    fn quoted_phrase_requires_adjacency() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(
            &conn,
            "arxiv:2204.12985",
            "latent space and manifold learning",
        );

        assert_eq!(
            search_full_text(&conn, "\"manifold learning\"", 20)
                .unwrap()
                .len(),
            1
        );
        assert!(search_full_text(&conn, "\"manifold space\"", 20)
            .unwrap()
            .is_empty());
        // An unterminated quote runs to end of input instead of raising.
        assert_eq!(
            search_full_text(&conn, "\"manifold learning", 20)
                .unwrap()
                .len(),
            1
        );
    }

    /// The invariant the rewrite rests on: whatever `match_expr` emits parses as
    /// FTS5, for any input at all. An expression FTS5 rejects would surface as
    /// an error from `fts_matches`, indistinguishable from a broken index, so
    /// pin the invariant at the source: run MATCH directly and unwrap.
    #[test]
    fn every_match_expr_output_parses_as_fts5() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();

        // Every character FTS5 gives meaning to, plus the ones that broke it.
        let atoms = [
            "\"",
            "-",
            ":",
            "(",
            ")",
            "*",
            "^",
            "%",
            "+",
            "&",
            "|",
            "{",
            "}",
            "[",
            "]",
            "AND",
            "OR",
            "NOT",
            "NEAR",
            "attention",
            "a",
            "\\",
            "/",
            "~",
            "!",
            ",",
            "日本語",
            "\0",
            "0",
            "'",
        ];
        let mut checked = 0;
        for a in atoms {
            for b in atoms {
                for c in atoms {
                    for raw in [format!("{a}{b}{c}"), format!("{a} {b} {c}")] {
                        let Some(expr) = match_expr(&raw) else {
                            continue;
                        };
                        conn.query_row(
                            "SELECT count(*) FROM papers_fts WHERE papers_fts MATCH ?1",
                            [&expr],
                            |r| r.get::<_, i64>(0),
                        )
                        .unwrap_or_else(|e| panic!("{raw:?} -> {expr:?} rejected by FTS5: {e}"));
                        checked += 1;
                    }
                }
            }
        }
        assert!(checked > 1000, "only {checked} expressions reached FTS5");
    }

    #[test]
    fn match_expr_quotes_terms_and_keeps_operators() {
        assert_eq!(
            match_expr("encoder-decoder").unwrap(),
            "\"encoder-decoder\""
        );
        assert_eq!(
            match_expr("neural networks").unwrap(),
            "\"neural\" \"networks\""
        );
        assert_eq!(match_expr("a OR b").unwrap(), "\"a\" OR \"b\"");
        assert_eq!(match_expr("dot-product*").unwrap(), "\"dot-product\"*");
        assert_eq!(match_expr("\"exact phrase\"").unwrap(), "\"exact phrase\"");
        // A quote mid-query starts a fresh quoted-phrase term rather than being
        // swallowed into the prior bare word.
        assert_eq!(
            match_expr("say \"hi\" now").unwrap(),
            "\"say\" \"hi\" \"now\""
        );
        assert_eq!(
            match_expr("\"scaled dot-product\"*").unwrap(),
            "\"scaled dot-product\"*"
        );
        assert_eq!(match_expr("\"a b\" *").unwrap(), "\"a b\"");
        // Dangling and doubled operators would each be a syntax error.
        assert_eq!(match_expr("a AND").unwrap(), "\"a\"");
        assert_eq!(match_expr("AND a").unwrap(), "\"a\"");
        assert_eq!(match_expr("a AND OR b").unwrap(), "\"a\" AND \"b\"");
        assert_eq!(match_expr(""), None);
        assert_eq!(match_expr("  -%- "), None);
        assert_eq!(match_expr("foo\0bar").unwrap(), "\"foobar\"");
    }

    /// The per-branch LIMIT pushdown must still return the best-scored papers:
    /// the cap counts distinct papers, and bm25 order decides who survives it.
    #[test]
    fn limit_keeps_the_best_scored_papers() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(&conn, "arxiv:1", "walrus walrus walrus");
        seed(
            &conn,
            "arxiv:2",
            "a walrus appears once in a longer digression",
        );
        seed(
            &conn,
            "arxiv:3",
            "another walrus in another longer digression",
        );

        let hits = search_full_text(&conn, "walrus", 2).unwrap();
        assert_eq!(hits.len(), 2);
        // Highest term frequency in the shortest text = best bm25, ranked first.
        assert_eq!(hits[0].source_id, "arxiv:1");

        assert!(search_full_text(&conn, "walrus", 0).unwrap().is_empty());
    }

    /// The notes branch limits distinct PAPERS, not note rows: one paper with
    /// many matching notes must not crowd another matching paper out of the cap.
    #[test]
    fn many_note_paper_does_not_crowd_out_another_within_limit() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(&conn, "arxiv:1", "some tex source");
        seed(&conn, "arxiv:2", "other tex source");
        for (sid, n) in [("arxiv:1", 3), ("arxiv:2", 1)] {
            for i in 0..n {
                conn.execute(
                    "INSERT INTO NOTE (SOURCE_FK, TITLE, NOTE) \
                     SELECT SOURCE_FK, 'n', 'zebra note ' || ?2 \
                     FROM PAPER_ROOTS WHERE SOURCE_ID = ?1",
                    rusqlite::params![sid, i],
                )
                .unwrap();
            }
        }

        let mut sids: Vec<String> = search_full_text(&conn, "zebra", 2)
            .unwrap()
            .into_iter()
            .map(|p| p.source_id)
            .collect();
        sids.sort();
        assert_eq!(sids, ["arxiv:1", "arxiv:2"]);
    }

    #[test]
    fn notes_fts_stays_in_sync_on_update_and_delete() {
        let conn = db::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        seed(&conn, "arxiv:2204.12985", "some tex source");

        conn.execute(
            "INSERT INTO NOTE (SOURCE_FK, TITLE, NOTE) \
             SELECT SOURCE_FK, 'n', 'aardvark reminder' \
             FROM PAPER_ROOTS WHERE SOURCE_ID = ?1",
            ["arxiv:2204.12985"],
        )
        .unwrap();
        let note_sk: i64 = conn
            .query_row(
                "SELECT NOTE_SK FROM NOTE WHERE NOTE = 'aardvark reminder'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(search_full_text(&conn, "aardvark", 20).unwrap().len(), 1);

        conn.execute(
            "UPDATE NOTE SET NOTE = 'buffalo reminder' WHERE NOTE_SK = ?1",
            [note_sk],
        )
        .unwrap();
        assert_eq!(search_full_text(&conn, "aardvark", 20).unwrap().len(), 0);
        assert_eq!(search_full_text(&conn, "buffalo", 20).unwrap().len(), 1);

        conn.execute("DELETE FROM NOTE WHERE NOTE_SK = ?1", [note_sk])
            .unwrap();
        assert_eq!(search_full_text(&conn, "buffalo", 20).unwrap().len(), 0);
    }
}
