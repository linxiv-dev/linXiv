//! recognize — classify a pasted string (arXiv link/id, DOI, direct PDF URL)
//! into the typed import target the GUI/routes dispatch on. Pure, no network.

use reqwest::Url;

use crate::formats::is_arxiv_id;
use crate::sources::doi_resolve::strip_doi_url;
use crate::sources::http::{assert_host_allowed, ARXIV_HOSTS};

/// `POST /api/papers/import/recognize` response: what a pasted string is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, ts_rs::TS)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum RecognizedInput {
    /// Bare arXiv id, extracted from an id or any arXiv-host URL.
    ArxivId(String),
    /// Bare DOI, from a DOI, a doi.org/dx.doi.org URL, or a known publisher URL.
    Doi(String),
    /// http(s) URL whose path ends in `.pdf`, normalized (scheme added if pasted bare).
    DirectPdfUrl(String),
    Unrecognized,
}

/// Classify a pasted string. Scheme-less URL pastes ("arxiv.org/abs/…") are
/// read as https; anything else falls out as `Unrecognized`.
pub fn recognize(input: &str) -> RecognizedInput {
    use RecognizedInput::*;
    let t = input.trim();
    if t.is_empty() {
        return Unrecognized;
    }
    if is_arxiv_id(t) {
        return ArxivId(t.to_string());
    }
    // Bare DOI: `10.<registrant>/<suffix>`.
    if t.starts_with("10.") && t.contains('/') {
        return Doi(t.to_string());
    }

    let url_str = if t.contains("://") {
        t.to_string()
    } else {
        format!("https://{t}")
    };
    // Raw prefix strip (not Url::path()): old DOIs hold chars URL parsing mangles.
    let doi = strip_doi_url(&url_str);
    if doi != url_str {
        return if doi.is_empty() {
            Unrecognized
        } else {
            Doi(doi)
        };
    }

    let Ok(url) = Url::parse(&url_str) else {
        return Unrecognized;
    };
    if url.scheme() != "http" && url.scheme() != "https" {
        return Unrecognized;
    }
    if assert_host_allowed(&url_str, ARXIV_HOSTS).is_ok() {
        return match arxiv_url_id(url.path()) {
            Some(id) => ArxivId(id),
            None => Unrecognized,
        };
    }
    if let Some(doi) = publisher_doi(&url) {
        return Doi(doi);
    }
    if url.path().to_ascii_lowercase().ends_with(".pdf") {
        return DirectPdfUrl(url_str);
    }
    Unrecognized
}

/// Publisher hosts whose `/<journal>/<section>/<doi>` paths carry the DOI.
const PUBLISHER_DOI_PATHS: &[(&str, &[&str])] = &[("journals.aps.org", &["pdf", "abstract"])];

/// DOI from a publisher landing/PDF URL listed in `PUBLISHER_DOI_PATHS`.
fn publisher_doi(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let (_, sections) = PUBLISHER_DOI_PATHS.iter().find(|(h, _)| *h == host)?;
    let mut parts = url.path().trim_start_matches('/').splitn(3, '/');
    let (_journal, section, doi) = (parts.next()?, parts.next()?, parts.next()?);
    let doi = doi.trim_end_matches('/');
    (sections.contains(&section) && doi.starts_with("10.") && doi.contains('/'))
        .then(|| doi.to_string())
}

/// arXiv id from an `/abs/…`, `/pdf/…(.pdf)`, or `/html/…` URL path.
fn arxiv_url_id(path: &str) -> Option<String> {
    let (section, id) = path.trim_start_matches('/').split_once('/')?;
    if !matches!(section, "abs" | "pdf" | "html") {
        return None;
    }
    let id = id.trim_end_matches('/');
    let id = id.strip_suffix(".pdf").unwrap_or(id);
    is_arxiv_id(id).then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::RecognizedInput::*;
    use super::*;

    fn arxiv(s: &str) -> RecognizedInput {
        ArxivId(s.to_string())
    }
    fn doi(s: &str) -> RecognizedInput {
        Doi(s.to_string())
    }

    #[test]
    fn bare_ids_pass_through() {
        assert_eq!(recognize("2204.12985"), arxiv("2204.12985"));
        assert_eq!(recognize("2204.12985v3"), arxiv("2204.12985v3"));
        assert_eq!(recognize("hep-th/9901001"), arxiv("hep-th/9901001"));
        assert_eq!(recognize("  2204.12985  "), arxiv("2204.12985"));
        assert_eq!(recognize("10.1000/xyz123"), doi("10.1000/xyz123"));
        assert_eq!(
            recognize("10.48550/arXiv.2312.00752"),
            doi("10.48550/arXiv.2312.00752")
        );
    }

    #[test]
    fn arxiv_urls_extract_the_id() {
        for (url, id) in [
            ("https://arxiv.org/abs/2204.12985", "2204.12985"),
            ("http://arxiv.org/abs/2204.12985v2", "2204.12985v2"),
            ("https://arxiv.org/pdf/2204.12985", "2204.12985"),
            ("https://arxiv.org/pdf/2204.12985v4.pdf", "2204.12985v4"),
            ("https://arxiv.org/html/2204.12985", "2204.12985"),
            ("https://arxiv.org/abs/hep-th/9901001", "hep-th/9901001"),
            ("https://arxiv.org/pdf/hep-th/9901001.pdf", "hep-th/9901001"),
            ("https://ar5iv.labs.arxiv.org/html/2204.12985", "2204.12985"),
            ("https://export.arxiv.org/abs/2204.12985", "2204.12985"),
            ("https://arxiv.org/abs/2204.12985/", "2204.12985"),
            // scheme-less paste
            ("arxiv.org/abs/2204.12985", "2204.12985"),
        ] {
            assert_eq!(recognize(url), arxiv(id), "{url}");
        }
        // query strings are not part of the id
        assert_eq!(
            recognize("https://arxiv.org/abs/2204.12985?context=cs.LG"),
            arxiv("2204.12985")
        );
    }

    #[test]
    fn arxiv_host_with_bad_path_is_unrecognized_not_direct_pdf() {
        // Never fall through to the generic downloader for arXiv hosts.
        assert_eq!(
            recognize("https://arxiv.org/list/cs.LG/recent"),
            Unrecognized
        );
        assert_eq!(
            recognize("https://arxiv.org/pdf/not-an-id.pdf"),
            Unrecognized
        );
        assert_eq!(recognize("https://arxiv.org/abs/"), Unrecognized);
        assert_eq!(recognize("https://arxiv.org"), Unrecognized);
    }

    #[test]
    fn doi_urls_strip_to_the_doi() {
        assert_eq!(recognize("https://doi.org/10.1000/xyz"), doi("10.1000/xyz"));
        assert_eq!(
            recognize("http://dx.doi.org/10.1000/xyz"),
            doi("10.1000/xyz")
        );
        assert_eq!(
            recognize("https://doi.org/10.48550/arXiv.2312.00752"),
            doi("10.48550/arXiv.2312.00752")
        );
        // scheme-less paste
        assert_eq!(recognize("doi.org/10.1000/xyz"), doi("10.1000/xyz"));
        // a bare doi.org URL strips to nothing
        assert_eq!(recognize("https://doi.org/"), Unrecognized);
    }

    #[test]
    fn publisher_urls_extract_the_doi() {
        for url in [
            "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.128.073601",
            "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.128.073601",
            "journals.aps.org/prl/pdf/10.1103/PhysRevLett.128.073601",
        ] {
            assert_eq!(
                recognize(url),
                doi("10.1103/PhysRevLett.128.073601"),
                "{url}"
            );
        }
        for url in [
            "https://journals.aps.org/prl/issues/128/7",
            "https://journals.aps.org/prl/pdf/not-a-doi",
        ] {
            assert_eq!(recognize(url), Unrecognized, "{url}");
        }
    }

    #[test]
    fn direct_pdf_urls_are_detected() {
        assert_eq!(
            recognize("https://example.com/papers/foo.pdf"),
            DirectPdfUrl("https://example.com/papers/foo.pdf".into())
        );
        assert_eq!(
            recognize("https://example.com/Foo.PDF?dl=1"),
            DirectPdfUrl("https://example.com/Foo.PDF?dl=1".into())
        );
        // scheme-less paste gets https prepended
        assert_eq!(
            recognize("example.com/foo.pdf"),
            DirectPdfUrl("https://example.com/foo.pdf".into())
        );
    }

    #[test]
    fn everything_else_is_unrecognized() {
        for s in [
            "",
            "   ",
            "not a paper",
            "https://example.com/landing-page",
            "ftp://example.com/foo.pdf",
            "file:///etc/passwd.pdf",
            "2204.123456",                          // invalid arXiv id shape
            "10.no-slash",                          // DOI prefix without a suffix
            "https://evilarxiv.org/abs/2204.12985", // host spoof
            "https://arxiv.org.evil.com/abs/2204.12985",
        ] {
            assert_eq!(recognize(s), Unrecognized, "{s:?}");
        }
    }
}
