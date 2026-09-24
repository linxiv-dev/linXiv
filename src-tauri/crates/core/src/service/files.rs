//! files service — FS helpers over the managed PDF dir, plus the dest-resolving
//! wrapper around the SSRF-safe `sources::download`.
//!
//! DI: callers pass the resolved managed `pdf_dir: &Path` (or a dest under it);
//! this module NEVER reads `config::pdf_dir()` itself.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};

/// Managed PDF location for a (paper_id, version): `<pdf_dir>/<safe_id>v<n>.pdf`.
fn pdf_file(pdf_dir: &Path, paper_id: &str, version: i64) -> PathBuf {
    pdf_dir.join(crate::service::paper::pdf_on_disk_name(paper_id, version))
}

/// "Where is this paper's PDF" wire envelope — `pdf path`/`pdf download` (CLI),
/// `get_pdf_path`/`download_pdf` (MCP), and `GET /api/papers/{id}/pdf-path` all
/// emit this shape.
#[derive(Debug, serde::Serialize)]
pub struct PdfLocation {
    pub source_id: String,
    pub version: i64,
    pub path: Option<PathBuf>,
}

/// Local path to a paper's PDF if the file is actually present, else `None`. Checks
/// `custom_path` (the paper row's stored path) first, then the standard managed location.
pub fn pdf_path(
    pdf_dir: &Path,
    paper_id: &str,
    version: i64,
    custom_path: Option<&str>,
) -> Option<PathBuf> {
    if let Some(c) = custom_path {
        let p = Path::new(c);
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }
    let std = pdf_file(pdf_dir, paper_id, version);
    std.is_file().then_some(std)
}

/// Cached size of every managed `*.pdf` per `pdf_dir`, keyed by the dir path as the
/// caller spells it. Lazily seeded by a full walk, then kept current by the write/
/// delete seams. Per-file, not a running delta, so overlapping writes can't double-count.
static PDF_STORAGE: std::sync::LazyLock<
    std::sync::Mutex<HashMap<PathBuf, HashMap<std::ffi::OsString, u64>>>,
> = std::sync::LazyLock::new(Default::default);

/// The full scan behind the cache: name → size of all `*.pdf` files directly in
/// `pdf_dir`, empty if the dir is absent. Files that vanish mid-scan are skipped.
pub(crate) fn walk_pdf_files(pdf_dir: &Path) -> HashMap<std::ffi::OsString, u64> {
    std::fs::read_dir(pdf_dir).map_or_else(
        |_| HashMap::new(),
        |entries| {
            entries
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().ends_with(".pdf"))
                .filter_map(|e| Some((e.file_name(), e.metadata().ok()?.len())))
                .collect()
        },
    )
}

#[cfg(test)]
fn walk_pdf_storage_bytes(pdf_dir: &Path) -> u64 {
    walk_pdf_files(pdf_dir).values().sum()
}

/// Total bytes of all managed `*.pdf` files in `pdf_dir` — the basis of the
/// `pdf_save_limit_mb` cap. Sums `PDF_STORAGE`, walking the dir to seed it when
/// the entry is absent (first read, or after a rename dropped it).
///
/// ponytail: files changed outside this process's seams (manual deletes, crash
/// orphans, writes by a sibling linxiv process — CLI/MCP against the same
/// library) drift the total until the next seeding walk; move it into the DB if
/// cross-process accuracy ever matters.
pub fn pdf_storage_bytes(pdf_dir: &Path) -> u64 {
    let mut cache = PDF_STORAGE.lock().unwrap_or_else(|p| p.into_inner());
    cache
        .entry(pdf_dir.to_path_buf())
        .or_insert_with(|| walk_pdf_files(pdf_dir))
        .values()
        .sum()
}

/// Record a managed PDF write: `dest` now holds `size` bytes; last writer wins,
/// never accumulates. A no-op until the dir's cache is seeded and for non-`.pdf` names.
pub fn note_pdf_written(dest: &Path, size: u64) {
    let (Some(dir), Some(name)) = (dest.parent(), dest.file_name()) else {
        return;
    };
    if !name.to_string_lossy().ends_with(".pdf") {
        return;
    }
    if let Some(files) = PDF_STORAGE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(dir)
    {
        files.insert(name.to_os_string(), size);
    }
}

/// Forget `name` from `pdf_dir`'s cache after a managed delete.
fn forget_pdf(pdf_dir: &Path, name: &std::ffi::OsStr) {
    if let Some(files) = PDF_STORAGE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(pdf_dir)
    {
        files.remove(name);
    }
}

/// Best-effort remove of a managed PDF built as `pdf_dir.join(name)`, dropping it
/// from the cached storage total on success. For cleanup paths that hold the exact
/// dest path (import rollback, failed attach/share saves).
pub fn remove_pdf_counted(path: &Path) {
    if std::fs::remove_file(path).is_ok() {
        if let (Some(dir), Some(name)) = (path.parent(), path.file_name()) {
            forget_pdf(dir, name);
        }
    }
}

/// Rename a managed PDF, moving its cache entry under ONE lock acquisition so a
/// concurrent quota check never sees the forgotten-but-not-yet-recorded gap. Size
/// is re-stat'd post-rename, falling back to the old cached size. Keyed by the
/// caller's `pdf_dir`, not `from`/`to`'s parents; both must live in it (callers gate).
pub fn rename_pdf_counted(pdf_dir: &Path, from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)?;
    let stat_size = std::fs::metadata(to).ok().map(|m| m.len());
    let mut cache = PDF_STORAGE.lock().unwrap_or_else(|p| p.into_inner());
    let mut old_size = None;
    if let (Some(files), Some(name)) = (cache.get_mut(pdf_dir), from.file_name()) {
        old_size = files.remove(name);
    }
    if let Some(name) = to.file_name() {
        if name.to_string_lossy().ends_with(".pdf") && cache.contains_key(pdf_dir) {
            match stat_size.or(old_size) {
                Some(size) => {
                    cache
                        .get_mut(pdf_dir)
                        .expect("checked contains_key above")
                        .insert(name.to_os_string(), size);
                }
                // Size unknowable (stat failed, old name never cached): drop
                // the dir's cache so the next quota check re-walks instead of
                // silently missing this file until restart.
                None => {
                    cache.remove(pdf_dir);
                }
            }
        }
    }
    Ok(())
}

/// `pdf_storage_bytes` in MB.
pub fn pdf_storage_mb(pdf_dir: &Path) -> f64 {
    pdf_storage_bytes(pdf_dir) as f64 / (1024.0 * 1024.0)
}

/// `GET /api/pdfs` envelope — CLI `pdf list` and MCP `list_pdfs` emit the same shape.
#[derive(Debug, serde::Serialize, ts_rs::TS)]
pub struct SavedPdfListing {
    pub pdfs: Vec<SavedPdf>,
}

/// Delete-saved-PDF receipt — `DELETE /api/pdfs/{id}` (route/pdfs.rs).
#[derive(Debug, serde::Serialize, ts_rs::TS)]
pub struct DeletedPdf {
    pub deleted: bool,
}

/// One row of the saved-PDF list — paper identity plus on-disk file size.
#[derive(Debug, serde::Serialize, ts_rs::TS)]
pub struct SavedPdf {
    pub source_id: String,
    pub source_fk: i64,
    pub title: String,
    /// The paper's latest version, from `list_pdf_papers`.
    pub version: i64,
    pub size_bytes: u64,
}

/// Saved-PDF listing rows from `paper::list_pdf_papers` output: stat each paper's
/// on-disk PDF (dropping rows whose file is missing), sorted size desc then source_id
/// asc. Uncapped here; the route and MCP cap at 200, the CLI lists everything.
pub fn saved_pdf_sizes(pdf_dir: &Path, papers: Vec<crate::models::PaperDetails>) -> Vec<SavedPdf> {
    let mut out: Vec<SavedPdf> = Vec::new();
    for p in papers {
        let Some(path) = pdf_path(pdf_dir, &p.source_id, p.version, p.pdf_path.as_deref()) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        out.push(SavedPdf {
            source_id: p.source_id,
            source_fk: p.source_fk,
            title: p.title,
            version: p.version,
            size_bytes: meta.len(),
        });
    }
    out.sort_by(|a, b| {
        b.size_bytes
            .cmp(&a.size_bytes)
            .then_with(|| a.source_id.cmp(&b.source_id))
    });
    out
}

/// SECURITY BOUNDARY: deletes `path` only if it resolves inside the managed `pdf_dir`.
/// `true` = inside (removed if present; a missing file is an idempotent success),
/// `false` = outside, or either path unresolvable.
pub fn delete_pdf(pdf_dir: &Path, path: &str) -> bool {
    // Canonicalize the managed root (resolves symlinks + `..`). If it can't be resolved
    // (dir absent), nothing is managed → refuse. Conservative for a trust boundary.
    let managed = match std::fs::canonicalize(pdf_dir) {
        Ok(m) => m,
        Err(_) => return false,
    };
    // Resolve the target the same way. std::fs::canonicalize requires existence, so
    // for a not-yet-existing file we resolve its parent and re-attach the name.
    let target = match std::fs::canonicalize(path) {
        Ok(t) => t,
        Err(_) => {
            let p = Path::new(path);
            match (p.parent(), p.file_name()) {
                (Some(parent), Some(name)) => match std::fs::canonicalize(parent) {
                    Ok(cp) => cp.join(name),
                    Err(_) => return false, // parent unresolvable → not provably inside
                },
                _ => return false,
            }
        }
    };
    if !target.starts_with(&managed) {
        return false;
    }
    // A removed direct child leaves the cached total, keyed by `pdf_dir` as readers
    // spell it (the canonicalized parent may not match); nested ones were never in it.
    if std::fs::remove_file(&target).is_ok() && target.parent() == Some(managed.as_path()) {
        if let Some(name) = target.file_name() {
            forget_pdf(pdf_dir, name);
        }
    }
    true
}

/// Resolve the managed dest under the DI'd `pdf_dir`, then hand the fetch and its
/// SSRF/size guards to `sources::download::download_pdf`.
/// `max_total_bytes` is the `pdf_save_limit_mb` TOTAL-storage cap: the downloader gets
/// whatever the PDFs already in `pdf_dir` leave of it, capped again by that module's
/// fixed per-download ceiling. An existing dest is returned as-is, never quota-blocked.
pub async fn download_pdf(
    pdf_dir: &Path,
    paper_id: &str,
    version: i64,
    url: &str,
    max_total_bytes: u64,
) -> Result<PathBuf> {
    let dest = pdf_file(pdf_dir, paper_id, version);
    if dest.exists() {
        return Ok(dest); // idempotent re-return (mirrors sources::download) — no quota check
    }
    let existing = pdf_storage_bytes(pdf_dir);
    let remaining = max_total_bytes.saturating_sub(existing);
    if remaining == 0 {
        return Err(CoreError::PdfTooLarge(format!(
            "PDF storage is full: {existing} bytes already saved of the {max_total_bytes} byte total limit (pdf_save_limit_mb)."
        )));
    }
    let out = crate::sources::download::download_pdf(&dest, url, remaining).await?;
    note_pdf_written(&out, std::fs::metadata(&out).map_or(0, |m| m.len()));
    Ok(out)
}

/// Best-effort attach of a `download_pdf` result: kept and recorded only if it
/// starts with `%PDF`. A paywall (403) or HTML page leaves the paper
/// metadata-only. Returns whether a PDF was attached.
pub fn keep_fetched_pdf(
    conn: &mut rusqlite::Connection,
    source_id: &str,
    version: i64,
    fetched: Result<PathBuf>,
) -> bool {
    let path = match fetched {
        Ok(p) => p,
        Err(e) => {
            tracing::info!("no PDF for {source_id}: {e}");
            return false;
        }
    };
    let mut magic = [0u8; 4];
    let is_pdf = std::fs::File::open(&path)
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut magic))
        .is_ok()
        && &magic == b"%PDF";
    let saved = is_pdf
        && crate::service::paper::mark_pdf_saved(conn, source_id, &path.to_string_lossy(), version)
            .is_ok();
    if !saved {
        tracing::info!("no PDF for {source_id}: not a PDF or not recorded");
        remove_pdf_counted(&path);
    }
    saved
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_pdf(dir: &Path, name: &str, bytes: usize) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, vec![0u8; bytes]).unwrap();
        p
    }

    /// Wire-shape pin: `{"source_id", "version", "path"}`, path nullable.
    #[test]
    fn pdf_location_wire_shape() {
        let loc = PdfLocation {
            source_id: "arxiv:1".into(),
            version: 2,
            path: None,
        };
        assert_eq!(
            serde_json::to_string(&loc).unwrap(),
            r#"{"source_id":"arxiv:1","version":2,"path":null}"#
        );
    }

    #[test]
    fn pdf_path_prefers_custom_then_standard_then_none() {
        let dir = tempfile::tempdir().unwrap();
        let pdf_dir = dir.path();

        // Nothing on disk yet → None.
        assert!(pdf_path(pdf_dir, "2204.00001", 1, None).is_none());

        // Standard managed file present → returned.
        let std = write_pdf(pdf_dir, "2204.00001v1.pdf", 10);
        assert_eq!(pdf_path(pdf_dir, "2204.00001", 1, None), Some(std.clone()));

        // custom_path takes priority when it is an existing file.
        let custom = write_pdf(pdf_dir, "elsewhere.pdf", 5);
        let custom_s = custom.to_str().unwrap();
        assert_eq!(
            pdf_path(pdf_dir, "2204.00001", 1, Some(custom_s)),
            Some(custom.clone())
        );

        // A custom_path that does not exist falls back to the standard file.
        assert_eq!(
            pdf_path(pdf_dir, "2204.00001", 1, Some("/no/such/file.pdf")),
            Some(std)
        );

        // Old-style id with a slash maps to the sanitised filename.
        write_pdf(pdf_dir, "math.GT_0309136v2.pdf", 3);
        assert!(pdf_path(pdf_dir, "math.GT/0309136", 2, None).is_some());
    }

    #[test]
    fn pdf_storage_mb_sums_only_pdfs() {
        let dir = tempfile::tempdir().unwrap();
        let pdf_dir = dir.path();

        // Missing dir → 0.0.
        assert_eq!(pdf_storage_mb(&pdf_dir.join("nope")), 0.0);

        // Empty dir → 0.0 (own dir: the total is cached per dir on first read).
        assert_eq!(pdf_storage_mb(tempfile::tempdir().unwrap().path()), 0.0);

        // 1 + 0.5 MiB of pdf, plus a non-pdf that must be ignored.
        write_pdf(pdf_dir, "a v1.pdf", 1024 * 1024);
        write_pdf(pdf_dir, "bv1.pdf", 512 * 1024);
        write_pdf(pdf_dir, "notes.txt", 9_000_000);
        let mb = pdf_storage_mb(pdf_dir);
        assert!((mb - 1.5).abs() < 1e-9, "expected ~1.5 MB, got {mb}");
    }

    /// The cached total walks once, then tracks the service add/delete seams
    /// without re-walking — proven by an out-of-band file the cache must not see.
    #[test]
    fn pdf_storage_total_tracks_service_mutations_without_rewalk() {
        let dir = tempfile::tempdir().unwrap();
        let pdf_dir = dir.path();
        let a = write_pdf(pdf_dir, "av1.pdf", 100);
        write_pdf(pdf_dir, "bv1.pdf", 50);

        // Lazy seed walk.
        assert_eq!(pdf_storage_bytes(pdf_dir), 150);

        // Delete through the service seam → decrement, still equal to a fresh walk.
        assert!(delete_pdf(pdf_dir, a.to_str().unwrap()));
        assert_eq!(pdf_storage_bytes(pdf_dir), 50);
        assert_eq!(pdf_storage_bytes(pdf_dir), walk_pdf_storage_bytes(pdf_dir));

        // Write seam, then the counted remove (import rollback) → same.
        let c = write_pdf(pdf_dir, "cv1.pdf", 30);
        note_pdf_written(&c, 30); // as the import/attach write seams do
        assert_eq!(pdf_storage_bytes(pdf_dir), 80);
        // Re-noting the same dest replaces its entry — overlapping writes to one
        // file can never double-count the total.
        note_pdf_written(&c, 30);
        assert_eq!(pdf_storage_bytes(pdf_dir), 80);
        remove_pdf_counted(&c);
        assert_eq!(pdf_storage_bytes(pdf_dir), 50);
        assert_eq!(pdf_storage_bytes(pdf_dir), walk_pdf_storage_bytes(pdf_dir));

        // An out-of-band file is invisible to the cache (no re-walk happens)…
        write_pdf(pdf_dir, "sneakyv1.pdf", 7);
        assert_eq!(pdf_storage_bytes(pdf_dir), 50);
        // …which is exactly the ponytail drift ceiling: a fresh walk sees it.
        assert_eq!(walk_pdf_storage_bytes(pdf_dir), 57);
    }

    #[test]
    fn delete_pdf_only_inside_managed_dir() {
        let dir = tempfile::tempdir().unwrap();
        let pdf_dir = dir.path().join("pdfs");
        fs::create_dir_all(&pdf_dir).unwrap();

        // Inside the managed dir → deleted, returns true.
        let inside = write_pdf(&pdf_dir, "2204.00001v1.pdf", 4);
        assert!(delete_pdf(&pdf_dir, inside.to_str().unwrap()));
        assert!(!inside.exists());

        // A missing file *inside* the managed dir is an idempotent success.
        assert!(delete_pdf(
            &pdf_dir,
            pdf_dir.join("gone.pdf").to_str().unwrap()
        ));

        // A file OUTSIDE the managed dir is refused and left intact.
        let outside = write_pdf(dir.path(), "secret.pdf", 4);
        assert!(!delete_pdf(&pdf_dir, outside.to_str().unwrap()));
        assert!(outside.exists());

        // `..` traversal escaping the managed dir is refused, sibling untouched.
        let escape = format!("{}/../secret.pdf", pdf_dir.display());
        assert!(!delete_pdf(&pdf_dir, &escape));
        assert!(outside.exists());
    }

    #[tokio::test]
    async fn download_pdf_returns_managed_dest_when_present() {
        // A file already at the managed (pdf_dir, paper_id, version) dest → returned with no
        // network call, proving the dest mapping. The network happy-path lives in
        // sources::download's wiremock tests; the public-IP SSRF guard rejects loopback, so a
        // wiremock host can't drive the real guarded download without weakening that guard.
        let dir = tempfile::tempdir().unwrap();
        let pdf_dir = dir.path();
        let body = b"%PDF-1.7 ok".to_vec();
        fs::write(pdf_dir.join("2204.00001v3.pdf"), &body).unwrap();
        let out = download_pdf(
            pdf_dir,
            "2204.00001",
            3,
            "http://example.com/x.pdf",
            1024 * 1024 * 1024,
        )
        .await
        .unwrap();
        assert_eq!(out, pdf_dir.join("2204.00001v3.pdf"));
        assert_eq!(fs::read(&out).unwrap(), body);
    }

    #[tokio::test]
    async fn download_pdf_rejects_when_total_storage_full_before_any_network() {
        // Existing PDFs already meet the pdf_save_limit_mb quota → early PdfTooLarge,
        // proven offline: the unresolvable URL would error differently if fetched.
        let dir = tempfile::tempdir().unwrap();
        let pdf_dir = dir.path();
        write_pdf(pdf_dir, "seedv1.pdf", 100);
        let err = download_pdf(
            pdf_dir,
            "2204.00003",
            1,
            "http://example.invalid/x.pdf",
            100,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, crate::error::CoreError::PdfTooLarge(ref m) if m.contains("full")),
            "expected storage-full rejection, got {err}"
        );
        assert!(!pdf_dir.join("2204.00003v1.pdf").exists());

        // An already-downloaded dest is still returned even at a full quota.
        let body = b"%PDF-1.7 ok".to_vec();
        fs::write(pdf_dir.join("2204.00004v1.pdf"), &body).unwrap();
        let out = download_pdf(
            pdf_dir,
            "2204.00004",
            1,
            "http://example.invalid/x.pdf",
            100,
        )
        .await
        .unwrap();
        assert_eq!(fs::read(&out).unwrap(), body);
    }

    /// A paywall's HTML page or a 403 leaves the paper metadata-only, no error;
    /// a real PDF is recorded.
    #[test]
    fn keep_fetched_pdf_drops_non_pdf_and_keeps_pdf() {
        use crate::service::paper as svc_paper;
        let mut conn = crate::test_support::db();
        let meta: crate::models::PaperMetadata = serde_json::from_value(serde_json::json!({
            "source_id": "doi:10.1000/x", "version": 1, "title": "T",
            "authors": ["A"], "published": "2024-01-01", "summary": "S",
        }))
        .unwrap();
        let (sid, ver) = svc_paper::save_paper_metadata(&mut conn, &meta, None).unwrap();
        let has_pdf =
            |conn: &rusqlite::Connection| svc_paper::get_required(conn, &sid).unwrap().has_pdf;
        let dir = tempfile::tempdir().unwrap();
        let html = write_pdf(dir.path(), "a.pdf", 0);
        fs::write(&html, "<html>Sign in</html>").unwrap();

        assert!(!keep_fetched_pdf(&mut conn, &sid, ver, Ok(html.clone())));
        assert!(!html.exists(), "non-PDF body is removed");
        let forbidden = Err(CoreError::Upstream("download failed: HTTP 403".into()));
        assert!(!keep_fetched_pdf(&mut conn, &sid, ver, forbidden));
        assert!(!has_pdf(&conn));

        let pdf = dir.path().join("b.pdf");
        fs::write(&pdf, "%PDF-1.7 ok").unwrap();
        assert!(keep_fetched_pdf(&mut conn, &sid, ver, Ok(pdf)));
        assert!(has_pdf(&conn));
    }

    #[tokio::test]
    async fn download_pdf_refuses_ssrf_and_leaves_no_file() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        // wiremock binds 127.0.0.1; the SSRF guard must refuse it before any body lands.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/evil.pdf"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/pdf")
                    .set_body_string("x"),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let pdf_dir = dir.path();
        let url = format!("{}/evil.pdf", server.uri());
        let err = download_pdf(pdf_dir, "2204.00002", 1, &url, 1024 * 1024 * 1024)
            .await
            .unwrap_err();
        assert!(
            matches!(err, crate::error::CoreError::Validation(ref m) if m.contains("disallowed")),
            "loopback host must be refused by the SSRF guard, got {err}"
        );
        assert!(
            !pdf_dir.join("2204.00002v1.pdf").exists(),
            "no file on a refused download"
        );
    }
}
