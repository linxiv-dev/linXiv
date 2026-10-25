//! BibTeX + Obsidian-markdown export/import — leaf string transforms over
//! `PaperDetails`, no DB access; shared by the Tauri router, CLI, and MCP.
//! Known laxities: export neither LaTeX-encodes field values nor dedups
//! case-insensitive citation keys; import emits "Given Last" names, drops
//! literal braces, and accepts out-of-range years.

use std::collections::BTreeSet;

use biblatex::Bibliography;
use chrono::NaiveDate;

use crate::models::{
    arxiv_source_id, doi_source_id, local_source_id, strip_provider_prefix, PaperDetails,
    PaperMetadata, ARXIV_ID_PREFIX, LOCAL_ID_PREFIX, OPENALEX_ID_PREFIX,
};
use crate::recognize::{recognize, RecognizedInput};

/// `repr()`-style quoting for `!r` error-message parity: single quotes,
/// switching to double only when the string holds a `'` but no `"`.
pub fn pyrepr(s: &str) -> String {
    let quote = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::with_capacity(s.len() + 2);
    out.push(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// Append `ext` only when the path has no extension. Shared by the CLI and
/// MCP export commands.
pub fn with_default_ext(dest: &str, ext: &str) -> std::path::PathBuf {
    let mut p = std::path::PathBuf::from(dest);
    if p.extension().is_none() {
        p.set_extension(ext);
    }
    p
}

/// One `@article` entry per paper: 4-space indent, `field = "value"`, no trailing
/// comma on the last field, one blank line between entries, single trailing newline.
pub fn bibtex_export(papers: &[PaperDetails]) -> String {
    let mut out = String::new();
    for (i, p) in papers.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let key = bib_key(&p.source_id);
        let year = p
            .published
            .map(|d| d.format("%Y").to_string())
            .unwrap_or_default();
        let authors = p.authors.join(" and ");
        let bare = strip_provider_prefix(&p.source_id, ARXIV_ID_PREFIX);
        let eprint = is_arxiv_id(bare).then(|| format!("{bare}v{}", p.version));
        out.push_str(&format!("@article{{{key}"));
        let mut fields: Vec<(&str, &str)> = vec![("title", p.title.as_str())];
        if !authors.is_empty() {
            fields.push(("author", authors.as_str()));
        }
        fields.extend([
            ("year", year.as_str()),
            ("abstract", p.summary.as_deref().unwrap_or("")),
        ]);
        if let Some(doi) = p.doi.as_deref().filter(|s| !s.is_empty()) {
            fields.push(("doi", doi));
        }
        if let Some(journal) = p.journal_ref.as_deref().filter(|s| !s.is_empty()) {
            fields.push(("journal", journal));
        }
        if let Some(eprint) = eprint.as_deref() {
            fields.extend([("eprint", eprint), ("archivePrefix", "arXiv")]);
        }
        if let Some(url) = p.url.as_deref().filter(|s| !s.is_empty()) {
            fields.push(("url", url));
        }
        for (name, value) in fields {
            out.push_str(&format!(",\n    {name} = {}", bib_quote(value)));
        }
        out.push_str("\n}\n");
    }
    out
}

/// `"value"` unless the value contains a `"`, then `{value}`.
fn bib_quote(value: &str) -> String {
    if value.contains('"') {
        format!("{{{value}}}")
    } else {
        format!("\"{value}\"")
    }
}

/// `source_id` (or "unknown" when empty) with `/` and `.` replaced by `_`.
fn bib_key(source_id: &str) -> String {
    if source_id.is_empty() {
        "unknown"
    } else {
        source_id
    }
    .replace(['/', '.'], "_")
}

/// YAML frontmatter + one `##` section per paper.
pub fn obsidian_export(papers: &[PaperDetails]) -> String {
    let all_tags: BTreeSet<&String> = papers.iter().flat_map(|p| &p.tags).collect();

    let mut lines: Vec<String> = vec!["---".into(), format!("papers: {}", papers.len())];
    if !all_tags.is_empty() {
        lines.push("tags:".into());
        for t in &all_tags {
            lines.push(format!("  - {t}"));
        }
    }
    lines.extend([
        "---".into(),
        "".into(),
        "# Selected Papers".into(),
        "".into(),
    ]);

    for p in papers {
        let sid = p.source_id.as_str();
        // Title is always present; an empty title stays empty (no source_id fallback).
        let title = p.title.as_str();
        let authors = p.authors.join(", ");
        let url = paper_url(sid, p.url.as_deref());
        lines.push(format!("## [{title}]({url})"));
        lines.push("".into());
        if !is_arxiv_id(sid) {
            lines.push(format!("**Paper-ID:** {sid}"));
        }
        if !authors.is_empty() {
            lines.push(format!("**Authors:** {authors}"));
        }
        if let Some(cat) = p.category.as_deref().filter(|s| !s.is_empty()) {
            lines.push(format!("**Category:** {cat}"));
        }
        if !p.tags.is_empty() {
            lines.push(format!("**Tags:** {}", p.tags.join(", ")));
        }
        lines.push("".into());
    }
    lines.join("\n")
}

/// Best URL for a paper: stored url > arXiv abs link > empty.
fn paper_url(sid: &str, stored_url: Option<&str>) -> String {
    if let Some(u) = stored_url.filter(|s| !s.is_empty()) {
        return u.to_string();
    }
    if is_arxiv_id(sid) {
        return format!("https://arxiv.org/abs/{sid}");
    }
    String::new()
}

/// arXiv id: `^\d{4}\.\d{4,5}(v\d+)?$ | ^[a-z\-]+(\.[A-Z]{2})?/\d{7}(v\d+)?$`.
/// Single source of truth for `linxiv-cli`'s `validate_arxiv_id` (pub so the CLI has no copy).
pub fn is_arxiv_id(sid: &str) -> bool {
    new_style_arxiv(sid) || old_style_arxiv(sid)
}

fn new_style_arxiv(sid: &str) -> bool {
    let head = match sid.split_once('v') {
        Some((h, v)) if !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()) => h,
        Some(_) => return false,
        None => sid,
    };
    let Some((a, b)) = head.split_once('.') else {
        return false;
    };
    a.len() == 4
        && a.chars().all(|c| c.is_ascii_digit())
        && (4..=5).contains(&b.len())
        && b.chars().all(|c| c.is_ascii_digit())
}

/// Strips an optional `.XX` archive-class suffix (e.g. "math.NT") from a
/// category part: stripped only when it's exactly 2 uppercase letters.
fn compute_cat(cat_part: &str) -> &str {
    match cat_part.rfind('.') {
        Some(i)
            if cat_part[i + 1..].len() == 2
                && cat_part[i + 1..].chars().all(|c| c.is_ascii_uppercase()) =>
        {
            &cat_part[..i]
        }
        _ => cat_part,
    }
}

fn old_style_arxiv(sid: &str) -> bool {
    let Some((cat_part, rest)) = sid.split_once('/') else {
        return false;
    };
    let cat = compute_cat(cat_part);
    if cat.is_empty() || !cat.chars().all(|c| c.is_ascii_lowercase() || c == '-') {
        return false;
    }
    // Optional `vN` version suffix, matching the regex's trailing `(v\d+)?`.
    let num = match rest.split_once('v') {
        Some((n, v)) if !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()) => n,
        Some(_) => return false,
        None => rest,
    };
    num.len() == 7 && num.chars().all(|c| c.is_ascii_digit())
}

/// `(root, version)` of an arXiv id: `"2204.12985v3"` -> `("2204.12985", 3)`; no suffix -> v1.
pub(crate) fn split_arxiv_version(id: &str) -> (String, i64) {
    match id.rsplit_once('v') {
        Some((r, v)) if !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()) => {
            (r.to_string(), v.parse().unwrap_or(1))
        }
        _ => (id.to_string(), 1),
    }
}

// ── BibTeX import ────────────────────────────────────────────────────────────

/// Parse BibTeX into `PaperMetadata` (identity per [`identity`]), source "bibtex",
/// ISO `date` or year→Jan-1 (falling back to 1900-01-01).
pub fn bibtex_import(text: &str) -> Result<Vec<PaperMetadata>, String> {
    let bib = Bibliography::parse(text).map_err(|e| format!("BibTeX parse error: {e}"))?;
    let mut out = Vec::new();
    for entry in bib.into_iter() {
        let key = entry.key.clone();
        let authors: Vec<String> = entry
            .author()
            .unwrap_or_default()
            .iter()
            .map(format_person)
            .collect();
        let doi = field(&entry, "doi");
        let title = field(&entry, "title").unwrap_or_else(|| key.clone());
        let summary = field(&entry, "abstract").unwrap_or_default();
        let journal_ref = field(&entry, "journal").or_else(|| field(&entry, "booktitle"));
        let url = field(&entry, "url");
        let published = parse_published(&entry);
        let (source_id, version) = identity(&entry, &key, doi.as_deref());
        out.push(PaperMetadata {
            source_id,
            version,
            title,
            authors,
            published,
            updated: None,
            summary,
            category: None,
            categories: None,
            doi,
            journal_ref,
            comment: None,
            url,
            tags: None,
            source: Some("bibtex".into()),
            author_orcids: None,
        });
    }
    Ok(out)
}

/// `(source_id, version)`, always namespaced (ADR 0002): our own export's
/// `arxiv:`/`local:`/`openalex:` key > DOI > arXiv eprint/url > `local:<key>`.
fn identity(entry: &biblatex::Entry, key: &str, doi: Option<&str>) -> (String, i64) {
    let arxiv = field(entry, "eprint")
        .map(|e| {
            e.trim_start_matches("arXiv:")
                .trim_start_matches("arxiv:")
                .to_string()
        })
        .into_iter()
        .chain(field(entry, "url"))
        .find_map(|s| match recognize(&s) {
            RecognizedInput::ArxivId(id) => Some(id),
            _ => None,
        })
        .or_else(|| {
            key.strip_prefix(ARXIV_ID_PREFIX)
                .and_then(unmangle_arxiv_key)
        });
    let arxiv_identity = |id: &str| {
        let (root, version) = split_arxiv_version(id);
        (arxiv_source_id(&root), version)
    };
    match (arxiv, doi) {
        (Some(id), _) if key.starts_with(ARXIV_ID_PREFIX) => arxiv_identity(&id),
        _ if key.starts_with(LOCAL_ID_PREFIX) || key.starts_with(OPENALEX_ID_PREFIX) => {
            (key.to_string(), 1)
        }
        (_, Some(d)) => (doi_source_id(d), 1),
        (Some(id), None) => arxiv_identity(&id),
        (None, None) => (local_source_id(key), 1),
    }
}

/// Undo `bib_key`'s `.`/`/` -> `_` fold: new-style ids had one `.`, old-style a
/// `/` before the number (`math_NT_0309136` -> `math.NT/0309136`).
fn unmangle_arxiv_key(bare: &str) -> Option<String> {
    let dotted = bare.replace('_', ".");
    let slashed = dotted
        .rsplit_once('.')
        .map(|(a, b)| format!("{a}/{b}"))
        .unwrap_or_default();
    [dotted, slashed].into_iter().find(|id| is_arxiv_id(id))
}

/// A scalar field as plain text, or None when absent/empty.
fn field(entry: &biblatex::Entry, key: &str) -> Option<String> {
    entry
        .get_as::<String>(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn parse_published(entry: &biblatex::Entry) -> NaiveDate {
    if let Some(date) =
        field(entry, "date").and_then(|s| NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok())
    {
        return date;
    }
    let year = entry
        .get_as::<i64>("year")
        .ok()
        .or_else(|| field(entry, "year").and_then(|s| s.parse::<i64>().ok()));
    year.and_then(|y| NaiveDate::from_ymd_opt(y as i32, 1, 1))
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(1900, 1, 1).unwrap())
}

/// "Given Last" display name (prefix/suffix folded in).
fn format_person(p: &biblatex::Person) -> String {
    [
        p.given_name.as_str(),
        p.prefix.as_str(),
        p.name.as_str(),
        p.suffix.as_str(),
    ]
    .iter()
    .filter(|s| !s.is_empty())
    .copied()
    .collect::<Vec<_>>()
    .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pyrepr_matches_python_repr() {
        // repr("arxiv:1234.5678") == "'arxiv:1234.5678'"
        assert_eq!(pyrepr("arxiv:1234.5678"), "'arxiv:1234.5678'");
        // repr of a string with a single quote and no double → switches to double quotes.
        assert_eq!(pyrepr("O'Brien"), "\"O'Brien\"");
        // Both quote kinds present → stays single, escapes the single.
        assert_eq!(pyrepr("a'b\"c"), "'a\\'b\"c'");
        assert_eq!(pyrepr("tab\there"), "'tab\\there'");
    }

    fn paper(source_id: &str, title: &str) -> PaperDetails {
        PaperDetails {
            paper_id: 1,
            source_id: source_id.into(),
            version: 1,
            title: title.into(),
            summary: Some("S".into()),
            published: NaiveDate::from_ymd_opt(2024, 1, 1),
            updated: None,
            url: None,
            doi: None,
            category: None,
            categories: vec![],
            journal_ref: None,
            comment: None,
            authors: vec!["Ada".into()],
            tags: vec![],
            has_pdf: false,
            pdf_path: None,
            source: None,
            full_text: None,
            downloaded_source: false,
            source_fk: 1,
        }
    }

    #[test]
    fn bibtex_export_matches_pybtex_layout() {
        let bib = bibtex_export(&[paper("2204.12985", "A Title")]);
        assert_eq!(
            bib,
            "@article{2204_12985,\n    title = \"A Title\",\n    author = \"Ada\",\n    \
             year = \"2024\",\n    abstract = \"S\",\n    eprint = \"2204.12985v1\",\n    \
             archivePrefix = \"arXiv\"\n}\n"
        );
    }

    #[test]
    fn bibtex_round_trips_identity_and_authors() {
        let mut ax = paper("arxiv:2404.14423", "Arxiv");
        ax.version = 5;
        ax.authors = vec!["Rafael Sorkin".into(), "Yasaman Yazdi".into()];
        ax.doi = Some("10.1103/x".into()); // a journal DOI must not steal the arXiv root
        let mut old = paper("arxiv:math.NT/0309136", "Old");
        old.version = 2;
        let mut d = paper("doi:10.1/y", "Doi");
        d.doi = Some("10.1/y".into());
        let cases = [
            (ax, "arxiv:2404.14423", 5),
            (old, "arxiv:math.NT/0309136", 2),
            (
                paper("local:729cbb91eb8b753b", "Local"),
                "local:729cbb91eb8b753b",
                1,
            ),
            (paper("openalex:W1", "OA"), "openalex:W1", 1),
            (d, "doi:10.1/y", 1),
        ];
        let papers: Vec<_> = cases.iter().map(|(p, ..)| p.clone()).collect();
        let back = bibtex_import(&bibtex_export(&papers)).unwrap();
        assert_eq!(back.len(), cases.len());
        for ((p, sid, v), m) in cases.iter().zip(&back) {
            assert_eq!((m.source_id.as_str(), m.version), (*sid, *v));
            assert_eq!(m.authors, p.authors);
        }
    }

    #[test]
    fn bibtex_import_repairs_pre_eprint_exports() {
        // Exports before `eprint`/`author` only carry the mangled key (and maybe a url).
        let bib = "@article{arxiv:1103_0638, title={T}, year={2011}}\n\
                   @article{arxiv:2404_14423, title={T}, url={https://arxiv.org/pdf/2404.14423v5}}\n\
                   @article{arxiv:hep-th_9901001, title={T}}\n\
                   @article{local:14604d4b1312048d, title={T}}\n\
                   @article{arxiv:junk, title={T}}\n\
                   @article{foreign, title={T}, eprint={arXiv:1801.09811}}\n\
                   @article{foreign2, title={T}, doi={10.1/j}, eprint={1801.09811}}";
        let ids: Vec<_> = bibtex_import(bib)
            .unwrap()
            .into_iter()
            .map(|m| (m.source_id, m.version))
            .collect();
        let want = [
            ("arxiv:1103.0638", 1),
            ("arxiv:2404.14423", 5),
            ("arxiv:hep-th/9901001", 1),
            ("local:14604d4b1312048d", 1),
            ("local:arxiv:junk", 1),
            ("arxiv:1801.09811", 1),
            ("doi:10.1/j", 1), // foreign entry: DOI still wins, as before
        ];
        assert_eq!(ids, want.map(|(s, v)| (s.to_string(), v)));
    }

    #[test]
    fn obsidian_omits_paper_id_for_arxiv_and_builds_abs_url() {
        let md = obsidian_export(&[paper("2204.12985", "A Title")]);
        assert!(md.contains("## [A Title](https://arxiv.org/abs/2204.12985)"));
        assert!(!md.contains("**Paper-ID:**")); // arXiv id → omitted
        assert!(md.contains("**Authors:** Ada"));
    }

    #[test]
    fn bibtex_import_doi_wins_and_year_falls_back() {
        let metas = bibtex_import(
            "@article{smith2020, author = {John Smith and Jane Doe}, \
             title = {A Title}, year = {2020}, doi = {10.1/x}, journal = {J}}",
        )
        .unwrap();
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].source_id, "doi:10.1/x"); // doi wins over key
        assert_eq!(
            metas[0].authors,
            vec!["John Smith".to_string(), "Jane Doe".to_string()]
        );
        assert_eq!(metas[0].source.as_deref(), Some("bibtex"));
        // no year/doi → the key under the `local:` namespace, 1900-01-01 fallback
        let m2 = &bibtex_import("@misc{k, title={T}}").unwrap()[0];
        assert_eq!(m2.source_id, "local:k");
        assert_eq!(m2.published, NaiveDate::from_ymd_opt(1900, 1, 1).unwrap());
    }

    #[test]
    fn bibtex_import_prefers_iso_date_over_year() {
        let m =
            &bibtex_import("@article{k, title={T}, year = 2017, date = {2017-06-12}}").unwrap()[0];
        assert_eq!(m.published, NaiveDate::from_ymd_opt(2017, 6, 12).unwrap());
        // a non-ISO date falls back to the year
        let m2 =
            &bibtex_import("@article{k, title={T}, year = 2017, date = {2017-06}}").unwrap()[0];
        assert_eq!(m2.published, NaiveDate::from_ymd_opt(2017, 1, 1).unwrap());
    }

    #[test]
    fn arxiv_id_matcher() {
        assert!(is_arxiv_id("2204.12985"));
        assert!(is_arxiv_id("2204.12985v3"));
        assert!(is_arxiv_id("math-ph/0309136"));
        assert!(is_arxiv_id("math.NT/0309136")); // archive-class suffix
        assert!(is_arxiv_id("hep-th/9901001v2")); // old-style with version
        assert!(!is_arxiv_id("math.nt/0309136")); // suffix must be uppercase
        assert!(!is_arxiv_id("2204.123456")); // suffix too long
        assert!(!is_arxiv_id("openalex:W123"));
    }
}
