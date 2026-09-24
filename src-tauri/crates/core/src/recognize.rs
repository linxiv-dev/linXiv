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
    /// Bare DOI, from a DOI or a doi.org/dx.doi.org URL.
    Doi(String),
    /// Known publisher URL: its DOI plus the publisher's PDF link for it.
    DoiWithPdf {
        doi: String,
        pdf_url: String,
    },
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
    if let Some((doi, pdf_path)) = publisher_doi(&url) {
        // A pasted PDF link keeps its URL (query and all); else swap in the PDF path.
        let pdf_url = if url.path().trim_matches('/') == pdf_path {
            url_str
        } else {
            let mut pdf = url;
            pdf.set_path(&pdf_path);
            pdf.set_query(None);
            pdf.set_fragment(None);
            pdf.to_string()
        };
        return DoiWithPdf { doi, pdf_url };
    }
    if url.path().to_ascii_lowercase().ends_with(".pdf") {
        return DirectPdfUrl(url_str);
    }
    Unrecognized
}

const ATYPON_HOSTS: &[&str] = &[
    "onlinelibrary.wiley.com",
    "pubs.acs.org",
    "tandfonline.com",
    "dl.acm.org",
    "epubs.siam.org",
    "journals.sagepub.com",
    "science.org",
    "pnas.org",
];

/// Publisher URLs that carry the DOI: (hosts sans `www.`, path prefix, optional
/// suffixes, DOI registrant for suffix-only paths, PDF path template). Prefix
/// segments are `*` or `a|b` alternatives. The template fills `{1}` with the
/// first prefix segment and `{id}` with the path's DOI part. Not recoverable
/// from the URL, so absent: Elsevier (sciencedirect.com `/pii/`), IEEE
/// (`/document/<n>`), JSTOR (`/stable/<n>`).
#[rustfmt::skip]
const PUBLISHER_DOI_PATHS: &[(&[&str], &str, &[&str], &str, &str)] = &[
    (&["journals.aps.org"], "*/pdf|abstract", &[], "", "{1}/pdf/{id}"),
    (ATYPON_HOSTS, "doi/pdf|epdf|abs|full", &[], "", "doi/pdf/{id}"),
    (ATYPON_HOSTS, "doi", &[], "", "doi/pdf/{id}"),
    (&["iopscience.iop.org"], "article", &["/pdf", "/meta"], "", "article/{id}/pdf"),
    (&["link.springer.com"], "content/pdf", &[".pdf"], "", "content/pdf/{id}.pdf"),
    (&["link.springer.com"], "article|chapter", &[], "", "content/pdf/{id}.pdf"),
    (&["nature.com"], "articles", &[".pdf"], "10.1038", "articles/{id}.pdf"),
];

/// (DOI, PDF path without leading `/`) from a URL listed in `PUBLISHER_DOI_PATHS`.
// ponytail: path isn't percent-decoded, so old SICI DOIs with `<>` stay encoded.
fn publisher_doi(url: &Url) -> Option<(String, String)> {
    let host = url.host_str()?;
    let host = host.strip_prefix("www.").unwrap_or(host);
    let path = url.path().trim_start_matches('/').trim_end_matches('/');
    PUBLISHER_DOI_PATHS
        .iter()
        .filter(|(hosts, ..)| hosts.contains(&host))
        .find_map(|&(_, prefix, suffixes, registrant, pdf)| {
            let mut rest = path;
            let first = path.split('/').next().unwrap_or("");
            for seg in prefix.split('/') {
                let (head, tail) = rest.split_once('/')?;
                if seg != "*" && !seg.split('|').any(|alt| alt == head) {
                    return None;
                }
                rest = tail;
            }
            let rest = suffixes
                .iter()
                .find_map(|s| rest.strip_suffix(s))
                .unwrap_or(rest);
            let doi = match registrant {
                "" => rest.to_string(),
                _ if rest.is_empty() || rest.contains('/') => return None,
                r => format!("{r}/{rest}"),
            };
            let (reg, suffix) = doi.split_once('/')?;
            let pdf = pdf.replace("{1}", first).replace("{id}", rest);
            (reg.starts_with("10.") && !suffix.is_empty()).then_some((doi, pdf))
        })
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
    fn publisher_urls_extract_the_doi_and_pdf_url() {
        for (url, doi, pdf_url) in [
            (
                "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.128.073601",
                "10.1103/PhysRevLett.128.073601",
                "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.128.073601",
            ),
            (
                "https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.128.073601",
                "10.1103/PhysRevLett.128.073601",
                "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.128.073601",
            ),
            (
                "journals.aps.org/prl/pdf/10.1103/PhysRevLett.128.073601",
                "10.1103/PhysRevLett.128.073601",
                "https://journals.aps.org/prl/pdf/10.1103/PhysRevLett.128.073601",
            ),
            (
                "https://onlinelibrary.wiley.com/doi/epdf/10.1002/anie.202100001",
                "10.1002/anie.202100001",
                "https://onlinelibrary.wiley.com/doi/pdf/10.1002/anie.202100001",
            ),
            (
                "https://pubs.acs.org/doi/pdf/10.1021/jacs.1c00001",
                "10.1021/jacs.1c00001",
                "https://pubs.acs.org/doi/pdf/10.1021/jacs.1c00001",
            ),
            (
                "https://www.tandfonline.com/doi/full/10.1080/00268976.2021.1900001",
                "10.1080/00268976.2021.1900001",
                "https://www.tandfonline.com/doi/pdf/10.1080/00268976.2021.1900001",
            ),
            (
                "https://dl.acm.org/doi/10.1145/3290605.3300234",
                "10.1145/3290605.3300234",
                "https://dl.acm.org/doi/pdf/10.1145/3290605.3300234",
            ),
            (
                "https://epubs.siam.org/doi/abs/10.1137/20M1234567",
                "10.1137/20M1234567",
                "https://epubs.siam.org/doi/pdf/10.1137/20M1234567",
            ),
            (
                "https://journals.sagepub.com/doi/pdf/10.1177/0956797620000001",
                "10.1177/0956797620000001",
                "https://journals.sagepub.com/doi/pdf/10.1177/0956797620000001",
            ),
            (
                "https://www.science.org/doi/10.1126/science.abc1234",
                "10.1126/science.abc1234",
                "https://www.science.org/doi/pdf/10.1126/science.abc1234",
            ),
            (
                "https://www.pnas.org/doi/full/10.1073/pnas.2000001117?af=R#sec-1",
                "10.1073/pnas.2000001117",
                "https://www.pnas.org/doi/pdf/10.1073/pnas.2000001117",
            ),
            (
                "https://iopscience.iop.org/article/10.1088/1742-6596/1234/1/012345/pdf",
                "10.1088/1742-6596/1234/1/012345",
                "https://iopscience.iop.org/article/10.1088/1742-6596/1234/1/012345/pdf",
            ),
            (
                "https://iopscience.iop.org/article/10.1088/1742-6596/1234/1/012345/meta",
                "10.1088/1742-6596/1234/1/012345",
                "https://iopscience.iop.org/article/10.1088/1742-6596/1234/1/012345/pdf",
            ),
            (
                "https://iopscience.iop.org/article/10.1088/1742-6596/1234/1/012345",
                "10.1088/1742-6596/1234/1/012345",
                "https://iopscience.iop.org/article/10.1088/1742-6596/1234/1/012345/pdf",
            ),
            (
                "https://link.springer.com/content/pdf/10.1007/s00220-020-03456-7.pdf?pdf=button",
                "10.1007/s00220-020-03456-7",
                "https://link.springer.com/content/pdf/10.1007/s00220-020-03456-7.pdf?pdf=button",
            ),
            (
                "https://link.springer.com/article/10.1007/s00220-020-03456-7",
                "10.1007/s00220-020-03456-7",
                "https://link.springer.com/content/pdf/10.1007/s00220-020-03456-7.pdf",
            ),
            (
                "https://link.springer.com/chapter/10.1007/978-3-030-12345-6_7",
                "10.1007/978-3-030-12345-6_7",
                "https://link.springer.com/content/pdf/10.1007/978-3-030-12345-6_7.pdf",
            ),
            (
                "https://www.nature.com/articles/s41586-020-2649-2",
                "10.1038/s41586-020-2649-2",
                "https://www.nature.com/articles/s41586-020-2649-2.pdf",
            ),
            (
                "https://www.nature.com/articles/s41586-020-2649-2.pdf",
                "10.1038/s41586-020-2649-2",
                "https://www.nature.com/articles/s41586-020-2649-2.pdf",
            ),
        ] {
            let want = DoiWithPdf {
                doi: doi.into(),
                pdf_url: pdf_url.into(),
            };
            assert_eq!(recognize(url), want, "{url}");
        }
        for url in [
            "https://journals.aps.org/prl/issues/128/7",
            "https://journals.aps.org/prl/pdf/not-a-doi",
            "https://pubs.acs.org/doi/pdf/",
            "https://www.nature.com/articles/s41586-020-2649-2/figures/1",
            "https://www.nature.com/nature/volumes",
            "https://www.sciencedirect.com/science/article/pii/S0370269320300001",
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
