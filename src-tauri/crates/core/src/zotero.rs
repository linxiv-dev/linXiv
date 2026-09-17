//! Zotero bridge — CSL JSON in both directions (what Zotero's own exporter
//! emits and its file importer accepts); no `zotero.sqlite`, no RDF.
//! Only bibliographic fields cross: title, authors, date, DOI, URL, abstract,
//! container-title. Tags, collections, child notes and attachments stay on
//! their side; `--project-id` on import is the collection stand-in.
//! Duplicates: identity is arXiv id (from the URL or an arXiv-issued DOI) >
//! a namespaced `id` from our own export > DOI > `local:<sha256(csl id)>` via
//! the pdf_metadata identity hash (title when there is no id, the whole item
//! when there is neither), so a re-imported library upserts the same roots
//! instead of doubling.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::models::{arxiv_source_id, doi_source_id, PaperDetails, PaperMetadata};
use crate::recognize::{recognize, RecognizedInput};
use crate::sources::doi_resolve::arxiv_doi_id;
use crate::sources::pdf_metadata::pdf_source_id;

/// One CSL JSON item; unknown fields are ignored on read and never written.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CslItem {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Write-only: the export hardcodes `article-journal` and the import never
    /// reads it, so a missing `type` must not fail the whole file.
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub author: Vec<CslName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issued: Option<CslDate>,
    #[serde(rename = "DOI", default, skip_serializing_if = "Option::is_none")]
    pub doi: Option<String>,
    #[serde(rename = "URL", default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#abstract: Option<String>,
    #[serde(
        rename = "container-title",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub container_title: Option<String>,
}

/// `{family, given}` for people; `{literal}` for institutions.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CslName {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub given: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal: Option<String>,
}

/// `{"date-parts": [[y, m, d]]}`; Zotero has emitted parts as strings too, and
/// writes `raw`/`literal` instead for a date it could not itself parse.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CslDate {
    #[serde(rename = "date-parts", default)]
    pub date_parts: Vec<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literal: Option<String>,
}

impl CslName {
    fn display(&self) -> String {
        if let Some(l) = &self.literal {
            return l.trim().to_string();
        }
        [self.given.as_deref(), self.family.as_deref()]
            .into_iter()
            .flatten()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn date_part(v: &serde_json::Value) -> Option<u32> {
    v.as_u64()
        .map(|n| n as u32)
        .or_else(|| v.as_str()?.trim().parse().ok())
}

/// First plausible 4-digit year in free text: "Spring 2020" → 2020.
fn year_in(s: &str) -> Option<i32> {
    s.as_bytes().windows(4).find_map(|w| {
        let y: i32 = std::str::from_utf8(w).ok()?.parse().ok()?;
        (1000..=2999).contains(&y).then_some(y)
    })
}

/// First date-parts entry → date; missing month/day land on the 1st, missing
/// year on 1900-01-01 (same fallback as `bibtex_import`). A `raw`/`literal`
/// date Zotero could not parse still carries its year, so scan that before
/// dropping the item on 1900 and sorting it under every date-ordered view.
fn parse_issued(issued: Option<&CslDate>) -> NaiveDate {
    let parts = issued.and_then(|d| d.date_parts.first());
    let get = |i: usize, dflt: u32| {
        parts
            .and_then(|p| p.get(i))
            .and_then(date_part)
            .unwrap_or(dflt)
    };
    let year = parts
        .and_then(|p| p.first())
        .and_then(date_part)
        .map(|y| y as i32)
        .or_else(|| {
            issued
                .and_then(|d| d.raw.as_deref().or(d.literal.as_deref()))
                .and_then(year_in)
        })
        .unwrap_or(1900);
    // An out-of-range month or day must not cost the year: drop the day, then
    // the month, before falling back to the 1900 sentinel.
    NaiveDate::from_ymd_opt(year, get(1, 1), get(2, 1))
        .or_else(|| NaiveDate::from_ymd_opt(year, get(1, 1), 1))
        .or_else(|| NaiveDate::from_ymd_opt(year, 1, 1))
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(1900, 1, 1).unwrap())
}

/// `(source_id, version)` for one item: arXiv (URL or arXiv DOI) > our own
/// namespaced `id` > DOI > local.
fn identity(item: &CslItem) -> (String, i64) {
    let arxiv = item
        .url
        .as_deref()
        .and_then(|u| match recognize(u) {
            RecognizedInput::ArxivId(id) => Some(id),
            _ => None,
        })
        .or_else(|| item.doi.as_deref().and_then(arxiv_doi_id));
    if let Some(id) = arxiv {
        let (root, version) = match id.rsplit_once('v') {
            Some((r, v)) if !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()) => {
                (r.to_string(), v.parse().unwrap_or(1))
            }
            _ => (id, 1),
        };
        return (arxiv_source_id(&root), version);
    }
    // Zotero's `id` is the item URI (stable across re-exports of one library),
    // so it is the acquisition key; a `local:` id from our own export passes
    // through verbatim. Title is the last resort, never identity by choice.
    let id = item.id.as_deref().map(str::trim).unwrap_or("");
    // `csl_export` writes `id: source_id`, so a round trip must recognise every
    // prefix we emit, and must do so BEFORE the DOI arm: an `openalex:` paper
    // that also carries a DOI would otherwise re-import as a second `doi:` root.
    if ["local:", "arxiv:", "doi:", "openalex:"]
        .iter()
        .any(|p| id.starts_with(p))
    {
        return (id.to_string(), 1);
    }
    if let Some(doi) = item.doi.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        return (doi_source_id(doi), 1);
    }
    let key = if !id.is_empty() {
        id.to_string()
    } else if !item.title.trim().is_empty() {
        item.title.trim().to_lowercase()
    } else {
        // No id and no title: keying on "" would collapse every such item onto
        // one root, so hash the item itself — same bytes, same root, re-import safe.
        serde_json::to_string(item).unwrap_or_default()
    };
    (pdf_source_id(key.as_bytes()), 1)
}

/// Parse a CSL JSON array into `PaperMetadata`, source "zotero".
pub fn csl_import(text: &str) -> Result<Vec<PaperMetadata>, String> {
    let items: Vec<CslItem> =
        serde_json::from_str(text).map_err(|e| format!("CSL JSON parse error: {e}"))?;
    Ok(items
        .into_iter()
        .map(|item| {
            let (source_id, version) = identity(&item);
            let title = if item.title.trim().is_empty() {
                item.id.clone().unwrap_or_else(|| source_id.clone())
            } else {
                item.title.clone()
            };
            PaperMetadata {
                source_id,
                version,
                title,
                authors: item
                    .author
                    .iter()
                    .map(CslName::display)
                    .filter(|a| !a.is_empty())
                    .collect(),
                published: parse_issued(item.issued.as_ref()),
                updated: None,
                summary: item.r#abstract.clone().unwrap_or_default(),
                category: None,
                categories: None,
                doi: item.doi.clone().filter(|d| !d.trim().is_empty()),
                journal_ref: item.container_title.clone(),
                comment: None,
                url: item.url.clone(),
                tags: None,
                source: Some("zotero".into()),
                author_orcids: None,
            }
        })
        .collect())
}

/// Papers → pretty-printed CSL JSON array, one `article-journal` per paper.
/// Authors are stored as display strings, so they go out as `literal`.
pub fn csl_export(papers: &[PaperDetails]) -> String {
    let items: Vec<CslItem> = papers
        .iter()
        .map(|p| CslItem {
            id: Some(p.source_id.clone()),
            kind: "article-journal".into(),
            title: p.title.clone(),
            author: p
                .authors
                .iter()
                .map(|a| CslName {
                    literal: Some(a.clone()),
                    ..Default::default()
                })
                .collect(),
            issued: p.published.map(|d| CslDate {
                raw: None,
                literal: None,
                date_parts: vec![vec![
                    serde_json::Value::from(
                        d.format("%Y").to_string().parse::<u32>().unwrap_or(1900),
                    ),
                    serde_json::Value::from(d.format("%m").to_string().parse::<u32>().unwrap_or(1)),
                    serde_json::Value::from(d.format("%d").to_string().parse::<u32>().unwrap_or(1)),
                ]],
            }),
            doi: p.doi.clone().filter(|s| !s.is_empty()),
            url: p.url.clone().filter(|s| !s.is_empty()),
            r#abstract: p.summary.clone().filter(|s| !s.is_empty()),
            container_title: p.journal_ref.clone().filter(|s| !s.is_empty()),
        })
        .collect();
    serde_json::to_string_pretty(&items).unwrap_or_else(|_| "[]".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The export writes `id: source_id`; a paper with no URL and no DOI has
    /// nothing else to be recognised by, so the id prefix is the only hook.
    #[test]
    fn arxiv_id_alone_round_trips_without_url_or_doi() {
        let json = r#"[{"id":"arxiv:2204.12985","type":"article-journal","title":"T"},
                       {"id":"doi:10.1/y","type":"article-journal","title":"U"}]"#;
        let back = csl_import(json).unwrap();
        assert_eq!(back[0].source_id, "arxiv:2204.12985");
        assert_eq!(back[1].source_id, "doi:10.1/y");
    }

    /// Zotero emits `raw` for a date it could not parse; the year in it is
    /// still better than silently filing the paper under 1900.
    #[test]
    fn unparsed_date_keeps_its_year() {
        let json = r#"[{"id":"k","type":"report","title":"T","issued":{"raw":"Spring 2020"}},
                       {"id":"k2","type":"report","title":"U","issued":{"raw":"no year here"}}]"#;
        let back = csl_import(json).unwrap();
        assert_eq!(
            back[0].published,
            NaiveDate::from_ymd_opt(2020, 1, 1).unwrap()
        );
        assert_eq!(
            back[1].published,
            NaiveDate::from_ymd_opt(1900, 1, 1).unwrap()
        );
    }

    /// A namespaced id from our own export outranks the DOI, or an `openalex:`
    /// paper that also has a DOI would come back as a second `doi:` root.
    #[test]
    fn own_id_prefix_beats_the_doi() {
        let json = r#"[{"id":"openalex:W2741809807","type":"article-journal","title":"T",
                        "DOI":"10.7717/peerj.4375"}]"#;
        let back = csl_import(json).unwrap();
        assert_eq!(back[0].source_id, "openalex:W2741809807");
        // A foreign Zotero URI still falls through to the DOI.
        let foreign = r#"[{"id":"http://zotero.org/users/1/items/ABCD","type":"article-journal",
                           "title":"T","DOI":"10.7717/peerj.4375"}]"#;
        assert_eq!(
            csl_import(foreign).unwrap()[0].source_id,
            "doi:10.7717/peerj.4375"
        );
    }

    /// An out-of-range month or day must not drag a good year down to 1900.
    #[test]
    fn bad_month_or_day_keeps_the_year() {
        let json = r#"[{"id":"k","type":"report","title":"T","issued":{"date-parts":[[2020,13]]}},
                       {"id":"k2","type":"report","title":"U","issued":{"date-parts":[[2020,2,30]]}}]"#;
        let back = csl_import(json).unwrap();
        assert_eq!(
            back[0].published,
            NaiveDate::from_ymd_opt(2020, 1, 1).unwrap()
        );
        assert_eq!(
            back[1].published,
            NaiveDate::from_ymd_opt(2020, 2, 1).unwrap()
        );
    }

    /// Items with neither id nor title used to hash "" and share one root;
    /// they must differ from each other yet stay stable across re-imports.
    #[test]
    fn id_less_title_less_items_get_distinct_stable_roots() {
        let json = r#"[{"type":"report","author":[{"literal":"A"}]},
                       {"type":"report","author":[{"literal":"B"}]},
                       {"type":"report","issued":{"raw":"2020"}}]"#;
        let ids: Vec<String> = csl_import(json)
            .unwrap()
            .iter()
            .map(|p| p.source_id.clone())
            .collect();
        let mut uniq = ids.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), 3, "{ids:?}");
        // Re-importing the same file reuses the roots instead of minting more.
        let again: Vec<String> = csl_import(json)
            .unwrap()
            .iter()
            .map(|p| p.source_id.clone())
            .collect();
        assert_eq!(ids, again);
    }

    /// A hand-edited or non-Zotero item with no `type` must still import:
    /// nothing on the import path reads it.
    #[test]
    fn missing_type_still_imports() {
        let json = r#"[{"id":"k1","title":"T","DOI":"10.1/x"},
                       {"id":"k2","type":"report","title":"U"}]"#;
        let back = csl_import(json).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].source_id, "doi:10.1/x");
        assert_eq!(back[0].title, "T");
    }

    #[test]
    fn export_round_trips_through_import() {
        let p = PaperDetails {
            paper_id: 1,
            source_id: "arxiv:2204.12985".into(),
            version: 1,
            title: "A Title".into(),
            summary: Some("S".into()),
            published: NaiveDate::from_ymd_opt(2024, 1, 1),
            updated: None,
            url: Some("https://arxiv.org/abs/2204.12985v2".into()),
            doi: Some("10.1/x".into()),
            category: None,
            categories: vec![],
            journal_ref: None,
            comment: None,
            authors: vec!["Ada Lovelace".into()],
            tags: vec![],
            has_pdf: false,
            pdf_path: None,
            source: None,
            full_text: None,
            downloaded_source: false,
            source_fk: 1,
        };
        // Same paper filed under OpenAlex: no arXiv URL, so its own id must
        // carry it home instead of the DOI minting a second root.
        let oa = PaperDetails {
            source_id: "openalex:W2741809807".into(),
            url: None,
            doi: Some("10.7717/peerj.4375".into()),
            ..p.clone()
        };
        let json = csl_export(&[p, oa]);
        assert!(json.contains("\"DOI\": \"10.1/x\""));
        let back = csl_import(&json).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[1].source_id, "openalex:W2741809807");
        // arXiv URL wins over the DOI; the vN suffix becomes the version.
        assert_eq!(back[0].source_id, "arxiv:2204.12985");
        assert_eq!(back[0].version, 2);
        assert_eq!(back[0].title, "A Title");
        assert_eq!(back[0].authors, vec!["Ada Lovelace".to_string()]);
        assert_eq!(
            back[0].published,
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap()
        );
    }
}
