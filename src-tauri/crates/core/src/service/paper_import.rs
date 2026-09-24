//! paper_import service — `import_pdf`: a multi-branch rollback matrix over
//! interleaved DB + filesystem writes, serialized by `IMPORT_ROOT_LOCK`.
//!
//! INJECTED SEAM (`resolve`): the async network + pdfium work must not run under
//! the DB lock, so `import_pdf` takes a resolver. `external` is the optional
//! upstream `(source_id, version)` identity: `Some` ⇒ key on that arxiv/DOI
//! identity, `None` ⇒ mint a fresh `local:<sha>` root — do not drop the Option.
//!
//! Two PDF filename formats stay DISTINCT: on-disk `{safe}v{version}.pdf` vs
//! `.lxproj` archive `{source_id}_v{version}.pdf`. Never unify.

use crate::error::{CoreError, Result};
use crate::models::PaperMetadata;
use crate::service::paper::pdf_on_disk_name;
use crate::storage::queries::{paper as store, project as proj_store};
use rusqlite::Connection;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Serializes `import_body`'s whole DB+FS write section against a concurrent
/// import or `paper_merge` touching the same root.
pub(crate) static IMPORT_ROOT_LOCK: Mutex<()> = Mutex::new(());

/// `POST /api/papers/import/pdf` envelope; MCP emits it verbatim.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct PaperImportResult {
    pub source_id: String,
    pub title: String,
}

/// What `import_body` actually wrote; each flag gates one rollback cell.
#[derive(Default)]
struct ImportState {
    /// Canonical on-disk path we wrote (or would have written) the PDF to.
    final_path: Option<PathBuf>,
    /// Root did NOT pre-exist → this import created it (rollback may hard-delete).
    inserted_new_root: bool,
    /// Adopted a soft-deleted root; `save_paper_metadata` auto-restored it, so
    /// rollback must re-soft-delete.
    restored_deleted_root: bool,
    /// Wrote a fresh file at `final_path` — distinct from "inserted a row": a
    /// same-version adopt with NULL PDF_PATH writes a file but no new row.
    wrote_final_path: bool,
    source_id: Option<String>,
    version: Option<i64>,
}

/// Save a PDF to disk, extract its metadata (via `resolve`), persist to the DB,
/// and optionally link it to a project. Returns the imported `(source_id, title)`.
///
/// Dedupe: an `external` arxiv/DOI identity from `resolve` is keyed on instead of
/// minting a `local:<sha>` root. Adopting a soft-deleted root auto-restores it.
///
/// Rollback policy on storage/FS failure (the matrix):
///   - Brand-new paper (root didn't exist): hard_delete, but only if a re-check
///     under the lock shows no concurrent import wrote a pdf_path for it.
///   - Existing root: the PAPER row is left as-is (deleting it could destroy
///     pre-existing versions); any file this import wrote is unlinked.
///   - Adopted into a soft-deleted root: re-soft-delete.
///
/// Project linking: the membership guard runs before any import work (missing →
/// `ProjectNotFound`, deleted → `ProjectDeleted`), and again at link time — a
/// project deleted mid-import surfaces there as `PaperLink`, paper already saved.
pub fn import_pdf<R>(
    conn: &mut Connection,
    pdf_dir: &Path,
    content: &[u8],
    project_id: Option<i64>,
    max_total_bytes: u64,
    resolve: R,
) -> Result<PaperImportResult>
where
    R: Fn(&[u8]) -> Result<(PaperMetadata, Option<(String, i64)>)>,
{
    // `pdf_save_limit_mb` enforcement; the caller DI's the resolved byte cap.
    // First, before any FS/DB write, so an over-cap upload never touches disk.
    check_pdf_storage_quota(pdf_dir, content.len(), max_total_bytes)?;

    // Membership guard: fail before mutating the library.
    if let Some(pid) = project_id {
        crate::service::project::ensure_membership_writable(conn, pid)?;
    }

    fs::create_dir_all(pdf_dir)
        .map_err(|e| CoreError::Internal(format!("import_pdf: mkdir {pdf_dir:?} failed: {e}")))?;
    // `.part`, not `.pdf`: the storage-total walk counts `*.pdf`, and the upload
    // must not be counted until it is renamed into place.
    let tmp_path = pdf_dir.join(format!("_upload_{}.part", unique_token()));
    fs::write(&tmp_path, content).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        CoreError::Internal(format!("import_pdf: write temp PDF failed: {e}"))
    })?;

    // BEFORE any DB write, so an extraction failure's only cleanup is the temp
    // file — distinct from the rollback matrix below.
    let (meta, external) = match resolve(content) {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            return Err(CoreError::PdfImport(e.to_string()));
        }
    };
    let title = meta.title.clone();

    let mut st = ImportState::default();
    let sid = match import_body(conn, pdf_dir, &tmp_path, meta, external, &mut st) {
        Ok(sid) => sid,
        Err(e) => {
            rollback(conn, &tmp_path, &st);
            return Err(e);
        }
    };

    if let Some(pid) = project_id {
        if let Err(e) = link_imported(conn, pid, &sid) {
            return Err(match e {
                CoreError::ProjectNotFound(_) | CoreError::ProjectDeleted(_) => {
                    CoreError::PaperLink(format!(
                        "paper {sid} was imported but could not be linked to project {pid}: {e}"
                    ))
                }
                other => other,
            });
        }
    }

    Ok(PaperImportResult {
        source_id: sid,
        title,
    })
}

/// Resolve-phase output: metadata plus the optional upstream identity.
pub type ResolvedPdf = (PaperMetadata, Option<(String, i64)>);

/// Fail-fast guard: run BEFORE [`resolve_import_pdf`] so a bad `project_id` is
/// rejected without paying for the network resolve + pdfium parse. `import_pdf`
/// re-checks at commit (the project can vanish between the phases).
pub fn precheck_import_pdf(conn: &Connection, project_id: Option<i64>) -> Result<()> {
    match project_id {
        Some(pid) => crate::service::project::ensure_membership_writable(conn, pid),
        None => Ok(()),
    }
}

/// Phase 1, with NO DB lock held: quota precheck plus the network metadata
/// resolve; hand the result to [`commit_import_pdf`] under the caller's lock.
/// CrossRef mailto and `pdf_import_verify_identity_enabled` are read here so
/// `sources::` stays pure DI; a settings-load failure defaults to `true`.
pub async fn resolve_import_pdf(
    pdf_dir: &Path,
    content: &[u8],
    max_total_bytes: u64,
    data_dir: &Path,
) -> Result<ResolvedPdf> {
    check_pdf_storage_quota(pdf_dir, content.len(), max_total_bytes)?;
    let verify_identity = crate::config::UserSettings::load()
        .map(|s| s.pdf_import_verify_identity_enabled())
        .unwrap_or(true);
    crate::sources::pdf_metadata::resolve_pdf_metadata(
        content,
        data_dir,
        &crate::config::crossref_mailto(),
        verify_identity,
    )
    .await
}

/// PDF bytes → the JSON the out-of-process `pdf-meta` worker prints. Pure and
/// offline (pdfium only); a front door so the CLI avoids `sources::` (ADR-0010).
pub fn extract_pdf_metadata_json(bytes: &[u8]) -> String {
    crate::sources::pdf_metadata::extract_pdf_metadata_json(bytes)
}

/// The worker's CLI subcommand name — same service front door (ADR-0010) so
/// `crates/cli` wires its clap command to the exact string core invokes.
pub use crate::sources::pdf_metadata::PDF_META_SUBCOMMAND;

/// Phase 2, under the caller's DB lock: `import_pdf` (quota re-check, membership
/// guard, rollback matrix) with already-resolved metadata.
pub fn commit_import_pdf(
    conn: &mut Connection,
    pdf_dir: &Path,
    content: &[u8],
    project_id: Option<i64>,
    max_total_bytes: u64,
    resolved: ResolvedPdf,
) -> Result<PaperImportResult> {
    import_pdf(
        conn,
        pdf_dir,
        content,
        project_id,
        max_total_bytes,
        move |_| Ok(resolved.clone()),
    )
}

/// Both phases against one directly-held connection (the CLI's shape — no mutex
/// to keep the await out of).
pub async fn import_pdf_default(
    conn: &mut Connection,
    pdf_dir: &Path,
    content: &[u8],
    project_id: Option<i64>,
    max_total_bytes: u64,
    data_dir: &Path,
) -> Result<PaperImportResult> {
    precheck_import_pdf(conn, project_id)?;
    let resolved = resolve_import_pdf(pdf_dir, content, max_total_bytes, data_dir).await?;
    commit_import_pdf(
        conn,
        pdf_dir,
        content,
        project_id,
        max_total_bytes,
        resolved,
    )
}

/// `POST /api/papers/import/bibtex` receipt; all three surfaces emit it.
/// Counts DISTINCT roots, not input entries — `saved_count == source_ids.len()`.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct BibtexImportReceipt {
    pub saved_count: usize,
    pub source_ids: Vec<String>,
}

/// Import papers from BibTeX text, optionally linking them to a project. Guard
/// runs before parsing; parse errors → `BadRequest`; a project vanishing between
/// guard and link → `PaperLink`, papers kept.
pub fn import_bibtex(
    conn: &mut Connection,
    text: &str,
    project_id: Option<i64>,
) -> Result<BibtexImportReceipt> {
    if let Some(pid) = project_id {
        crate::service::project::ensure_membership_writable(conn, pid)?;
    }
    let metas = crate::formats::bibtex_import(text).map_err(CoreError::BadRequest)?;
    save_and_link(conn, &metas, project_id)
}

/// Zotero CSL JSON twin of [`import_bibtex`]; same guard/parse/save/link order.
pub fn import_zotero(
    conn: &mut Connection,
    text: &str,
    project_id: Option<i64>,
) -> Result<BibtexImportReceipt> {
    if let Some(pid) = project_id {
        crate::service::project::ensure_membership_writable(conn, pid)?;
    }
    let metas = crate::zotero::csl_import(text).map_err(CoreError::BadRequest)?;
    save_and_link(conn, &metas, project_id)
}

fn save_and_link(
    conn: &mut Connection,
    metas: &[PaperMetadata],
    project_id: Option<i64>,
) -> Result<BibtexImportReceipt> {
    let source_ids = crate::service::paper::save_papers_metadata(conn, metas)?;
    if let Some(pid) = project_id {
        if !source_ids.is_empty() {
            if let Err(e) = crate::service::project::link_imported(conn, pid, &source_ids) {
                return Err(CoreError::PaperLink(format!(
                    "{} paper(s) were imported but could not be linked: {e}",
                    source_ids.len()
                )));
            }
        }
    }
    Ok(BibtexImportReceipt {
        saved_count: source_ids.len(),
        source_ids,
    })
}

/// The `pdf_save_limit_mb` TOTAL-storage check: reject `incoming_len` if it would
/// push the PDFs already in `pdf_dir` over `max_total_bytes`. Route/MCP run it in
/// phase 1; `import_pdf` re-runs it. A re-import already on disk is still counted.
pub fn check_pdf_storage_quota(
    pdf_dir: &Path,
    incoming_len: usize,
    max_total_bytes: u64,
) -> Result<()> {
    let existing = crate::service::files::pdf_storage_bytes(pdf_dir);
    let would_be = existing.saturating_add(incoming_len as u64);
    if would_be > max_total_bytes {
        return Err(CoreError::PdfTooLarge(format!(
            "Saving this {incoming_len} byte PDF would put total PDF storage at {would_be} bytes, \
             over the {max_total_bytes} byte limit (pdf_save_limit_mb; currently {existing} bytes saved)."
        )));
    }
    Ok(())
}

/// The DB + FS write section; `st` records what was written for the rollback
/// matrix. Returns the resolved source_id.
fn import_body(
    conn: &mut Connection,
    pdf_dir: &Path,
    tmp_path: &Path,
    mut meta: PaperMetadata,
    external: Option<(String, i64)>,
    st: &mut ImportState,
) -> Result<String> {
    // Whole write section, not just check-then-upsert: a merge holds this same
    // lock end-to-end, and releasing it between the row insert and
    // mark_pdf_saved would let a merge collapse the half-written root.
    let _guard = IMPORT_ROOT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (sid, ver, pre_existing_pdf) = {
        // An upstream identity (arXiv/DOI) is the Paper Root key, not the hash.
        if let Some((ext_id, ext_version)) = external {
            meta.source_id = ext_id;
            meta.version = ext_version;
        }

        let existing_root = store::get_paper_root(conn, &meta.source_id)?;
        if existing_root
            .as_ref()
            .is_some_and(|r| r.status == "deleted")
        {
            // ensure_paper_root will auto-restore; record it for rollback.
            st.restored_deleted_root = true;
        }
        let pre_existing_root = existing_root.is_some();
        let pre_existing_version =
            store::get_paper(conn, &meta.source_id, Some(meta.version))?.is_some();
        // Adopting + the canonical PDF already on disk → preserve the user's copy.
        let pre_existing_pdf = pre_existing_version
            && pdf_dir
                .join(pdf_on_disk_name(&meta.source_id, meta.version))
                .exists();

        let (sid, ver) = store::save_paper_metadata(conn, &meta, None)?;
        st.source_id = Some(sid.clone());
        st.version = Some(ver);
        st.inserted_new_root = !pre_existing_root;
        (sid, ver, pre_existing_pdf)
    };

    let final_path = pdf_dir.join(pdf_on_disk_name(&sid, ver));
    st.final_path = Some(final_path.clone());

    if pre_existing_pdf {
        // Dedupe: keep the existing PDF, drop the upload.
        let _ = fs::remove_file(tmp_path);
    } else {
        fs::rename(tmp_path, &final_path).map_err(|e| {
            CoreError::Internal(format!("import_pdf: move PDF into place failed: {e}"))
        })?;
        crate::service::files::note_pdf_written(
            &final_path,
            fs::metadata(&final_path).map_or(0, |m| m.len()),
        );
        st.wrote_final_path = true;
        store::mark_pdf_saved(conn, &sid, &final_path.to_string_lossy(), ver)?;
    }
    Ok(sid)
}

/// Roll back rows/files after a failed import (the matrix). Best-effort: each
/// step ignores its own error, so it can't mask the original failure.
fn rollback(conn: &mut Connection, tmp_path: &Path, st: &ImportState) {
    let _ = fs::remove_file(tmp_path);

    // Mutually exclusive: restored_deleted_root needs the root to have
    // pre-existed (deleted), inserted_new_root needs it to not have existed.
    if st.restored_deleted_root {
        if let Some(sid) = &st.source_id {
            // Adopt auto-restored a trashed root, then the import failed — re-trash.
            let _ = store::soft_delete_paper(conn, sid);
        }
    } else if st.inserted_new_root {
        if let Some(sid) = &st.source_id {
            // Only delete file + row if no concurrent import has since
            // committed a pdf_path; one guard for both keeps them in step.
            let _guard = IMPORT_ROOT_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            if let Ok(Some(row)) = store::get_paper(conn, sid, st.version) {
                if row.pdf_path.is_none() {
                    if let Some(fp) = &st.final_path {
                        crate::service::files::remove_pdf_counted(fp);
                    }
                    let _ = store::hard_delete_paper(conn, sid);
                }
            }
        }
    }

    // Orphan file the inserted_new_root branch above didn't handle (it has its
    // own lock-guarded unlink). Catches the restored_deleted_root + same-version
    // cell where PDF_PATH was NULL: the re-soft-delete won't unlink.
    if st.wrote_final_path && !st.inserted_new_root {
        if let Some(fp) = &st.final_path {
            crate::service::files::remove_pdf_counted(fp);
        }
    }
    // A stranded PAPER row (new version of a pre-existing root) stays, to
    // protect sibling versions.
}

/// Link a just-imported paper to a project (same write path as add_papers).
/// Re-applies `ensure_membership_writable` (the project may have been deleted
/// since the pre-import check); an unresolvable id is a no-op.
fn link_imported(conn: &mut Connection, project_fk: i64, source_id: &str) -> Result<()> {
    crate::service::project::ensure_membership_writable(conn, project_fk)?;
    if let Some(root) = store::get_paper_root(conn, source_id)? {
        proj_store::add_papers(conn, project_fk, &[root.source_fk])?;
    }
    Ok(())
}

/// Collision-free token for the temp upload filename.
fn unique_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static CTR: AtomicU64 = AtomicU64::new(0);
    let n = CTR.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}_{}_{}", std::process::id(), nanos, n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::paper;
    use crate::test_support::{db, meta};
    use tempfile::tempdir;

    /// A cap no fixture here (a few bytes each) can reach.
    const NO_LIMIT: u64 = 1_000_000;

    /// Only `.pdf` files count, and the comparison is `>`, so landing exactly
    /// on the limit is allowed.
    #[test]
    fn check_pdf_storage_quota_at_under_and_over_the_limit() {
        let dir = tempdir().unwrap();
        let pdf_dir = dir.path();
        // 60 bytes of existing PDFs, plus a non-PDF that must not be counted.
        std::fs::write(pdf_dir.join("a.pdf"), vec![0u8; 40]).unwrap();
        std::fs::write(pdf_dir.join("b.pdf"), vec![0u8; 20]).unwrap();
        std::fs::write(pdf_dir.join("notes.txt"), vec![0u8; 5_000]).unwrap();

        // under: 60 + 30 = 90 < 100
        assert!(check_pdf_storage_quota(pdf_dir, 30, 100).is_ok());
        // exactly at the limit: 60 + 40 = 100, not over
        assert!(check_pdf_storage_quota(pdf_dir, 40, 100).is_ok());
        // over: 60 + 41 = 101
        let err = check_pdf_storage_quota(pdf_dir, 41, 100).unwrap_err();
        assert_eq!(err.http_status(), 413);
        let msg = err.to_string();
        assert!(msg.contains("101"), "reports the would-be total: {msg}");
        assert!(msg.contains("60"), "reports what is already stored: {msg}");

        // A zero limit rejects even an empty write once anything is stored.
        assert!(check_pdf_storage_quota(pdf_dir, 0, 0).is_err());
        // An empty/absent pdf_dir starts the count at zero.
        let empty = tempdir().unwrap();
        assert!(check_pdf_storage_quota(empty.path(), 100, 100).is_ok());
        assert!(check_pdf_storage_quota(empty.path(), 101, 100).is_err());
    }

    /// Resolver that hands back a fixed (meta, external).
    fn resolver(
        m: PaperMetadata,
        external: Option<(String, i64)>,
    ) -> impl Fn(&[u8]) -> Result<ResolvedPdf> {
        move |_| Ok((m.clone(), external.clone()))
    }

    /// The guard rejects a bad project BEFORE the network phase; the regression
    /// would be surfaces paying for the resolve first.
    #[test]
    fn precheck_import_pdf_rejects_missing_project_and_passes_none() {
        let conn = db();
        assert!(matches!(
            precheck_import_pdf(&conn, Some(999)),
            Err(CoreError::ProjectNotFound(999))
        ));
        assert!(precheck_import_pdf(&conn, None).is_ok());
    }

    #[test]
    fn happy_path_new_paper_writes_db_and_file() {
        let mut conn = db();
        let dir = tempdir().unwrap();
        let res = import_pdf(
            &mut conn,
            dir.path(),
            b"%PDF-1.4 fake",
            None,
            NO_LIMIT,
            resolver(meta("local:abc", 1), None),
        )
        .unwrap();

        assert_eq!(res.source_id, "local:abc");
        assert_eq!(res.title, "Title of local:abc v1");

        let p = paper::get(
            &conn,
            &paper::PaperRef::Source {
                source_id: "local:abc".into(),
                version: Some(1),
            },
        )
        .unwrap()
        .unwrap();
        assert!(p.has_pdf);
        let final_path = dir.path().join("local_abcv1.pdf");
        assert_eq!(
            p.pdf_path.as_deref(),
            Some(final_path.to_string_lossy().as_ref())
        );
        assert!(final_path.exists());
        // Temp upload cleaned up; only the canonical file remains.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n.to_string_lossy().starts_with("_upload_"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn import_pdf_within_total_storage_limit_is_saved() {
        let mut conn = db();
        let dir = tempdir().unwrap();
        // Existing PDFs consume part of the total-storage quota.
        let seed = b"already-saved pdf bytes";
        fs::write(dir.path().join("seedv1.pdf"), seed).unwrap();
        let content = b"%PDF-1.4 small";
        let res = import_pdf(
            &mut conn,
            dir.path(),
            content,
            None,
            (seed.len() + content.len()) as u64, // total lands exactly at the limit — not over it
            resolver(meta("local:small", 1), None),
        )
        .unwrap();
        assert_eq!(res.source_id, "local:small");
        assert!(dir.path().join("local_smallv1.pdf").exists());
    }

    #[test]
    fn import_pdf_over_total_storage_limit_is_rejected_and_writes_nothing() {
        let mut conn = db();
        let dir = tempdir().unwrap();
        // The new file alone would fit; existing + new pushes the TOTAL over.
        let seed = b"existing pdf consuming most of the quota";
        fs::write(dir.path().join("seedv1.pdf"), seed).unwrap();
        let content = b"%PDF-1.4 the last straw";
        let err = import_pdf(
            &mut conn,
            dir.path(),
            content,
            None,
            (seed.len() + content.len() - 1) as u64, // one byte under what the total needs
            resolver(meta("local:big", 1), None),
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::PdfTooLarge(_)));
        // Rejected before any DB row or file was written: only the seed remains.
        assert!(paper::list_papers(&conn, false, None, 0, None)
            .unwrap()
            .is_empty());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);

        // Trivial case (existing = 0): a single file bigger than the whole quota.
        let empty = tempdir().unwrap();
        let err = import_pdf(
            &mut conn,
            empty.path(),
            content,
            None,
            (content.len() - 1) as u64,
            resolver(meta("local:big", 1), None),
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::PdfTooLarge(_)));
        assert_eq!(fs::read_dir(empty.path()).unwrap().count(), 0);
    }

    #[test]
    fn resolve_failure_is_pdf_import_and_leaves_nothing() {
        let mut conn = db();
        let dir = tempdir().unwrap();
        let bad = |_: &[u8]| Err(CoreError::Internal("corrupt pdf".into()));
        let err = import_pdf(&mut conn, dir.path(), b"junk", None, NO_LIMIT, bad).unwrap_err();
        assert!(matches!(err, CoreError::PdfImport(_)));
        // No paper saved, temp file cleaned up (dir empty).
        assert!(paper::list_papers(&conn, false, None, 0, None)
            .unwrap()
            .is_empty());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn adopt_existing_active_root_dedupes_identity() {
        let mut conn = db();
        let dir = tempdir().unwrap();
        // Pre-existing arxiv root + v1.
        paper::save_paper_metadata(&mut conn, &meta("arxiv:2204.0001", 1), None).unwrap();

        // Import a PDF whose local meta is local:xyz but external matches the arxiv root.
        let res = import_pdf(
            &mut conn,
            dir.path(),
            b"pdf",
            None,
            NO_LIMIT,
            resolver(meta("local:xyz", 1), Some(("arxiv:2204.0001".into(), 1))),
        )
        .unwrap();
        // Adopted the arxiv identity, not the local one.
        assert_eq!(res.source_id, "arxiv:2204.0001");
        // No local:xyz root was created.
        assert!(store::get_paper_root(&conn, "local:xyz").unwrap().is_none());
        // The arxiv version now has a PDF on disk.
        assert!(dir.path().join("arxiv_2204.0001v1.pdf").exists());
    }

    #[test]
    fn import_resolving_to_new_arxiv_id_converges_with_later_direct_save() {
        // "Imported earlier": the arxiv root does NOT yet exist at import time,
        // so the import keys on the resolved arxiv identity, not the hash.
        let mut conn = db();
        let dir = tempdir().unwrap();

        let res = import_pdf(
            &mut conn,
            dir.path(),
            b"pdf",
            None,
            NO_LIMIT,
            resolver(meta("local:xyz", 1), Some(("arxiv:2308.0001".into(), 1))),
        )
        .unwrap();
        // Keyed on the arxiv identity, no local:<sha> root minted.
        assert_eq!(res.source_id, "arxiv:2308.0001");
        assert!(store::get_paper_root(&conn, "local:xyz").unwrap().is_none());

        // Direct arXiv save of the same paper afterwards.
        paper::save_paper_metadata(&mut conn, &meta("arxiv:2308.0001", 1), None).unwrap();

        // One paper, not two.
        assert_eq!(
            paper::list_papers(&conn, false, None, 0, None)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn reimport_preserves_existing_pdf_on_disk() {
        let mut conn = db();
        let dir = tempdir().unwrap();
        paper::save_paper_metadata(&mut conn, &meta("arxiv:keep", 1), None).unwrap();
        // A PDF already sits at the canonical path with known bytes.
        let canonical = dir.path().join("arxiv_keepv1.pdf");
        fs::write(&canonical, b"ORIGINAL").unwrap();

        import_pdf(
            &mut conn,
            dir.path(),
            b"NEW UPLOAD",
            None,
            NO_LIMIT,
            resolver(meta("arxiv:keep", 1), Some(("arxiv:keep".into(), 1))),
        )
        .unwrap();

        // Existing copy preserved, upload dropped (not overwritten).
        assert_eq!(fs::read(&canonical).unwrap(), b"ORIGINAL");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    // Post-save failure injection: a DIRECTORY at the canonical PDF path makes
    // `fs::rename(tmp -> dir)` fail. Only valid when pre_existing_version is
    // false (else preserve-existing short-circuits the write).
    fn block_final_path(dir: &Path, name: &str) {
        fs::create_dir(dir.join(name)).unwrap();
    }

    #[test]
    fn import_zotero_twice_does_not_double_the_library() {
        let mut conn = db();
        let csl = r#"[{"id":"k1","type":"article-journal","title":"With DOI","DOI":"10.1/x",
            "author":[{"family":"Smith","given":"Jo"}],"issued":{"date-parts":[["2020","3"]]}},
            {"id":"k2","type":"report","title":"No Ids At All"}]"#;
        let first = import_zotero(&mut conn, csl, None).unwrap();
        assert_eq!(first.source_ids[0], "doi:10.1/x");
        assert!(first.source_ids[1].starts_with("local:"));
        let again = import_zotero(&mut conn, csl, None).unwrap();
        assert_eq!(first.source_ids, again.source_ids);
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM latest_papers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
        let p = paper::get(&conn, &paper::PaperRef::source("doi:10.1/x".into()))
            .unwrap()
            .unwrap();
        assert_eq!(p.authors, vec!["Jo Smith".to_string()]);
        assert_eq!(p.published, chrono::NaiveDate::from_ymd_opt(2020, 3, 1));
    }

    #[test]
    fn one_file_with_the_same_identity_twice_reports_one_root() {
        let mut conn = db();
        let csl = r#"[{"id":"a","type":"article-journal","title":"Dup","DOI":"10.1/dup"},
            {"id":"b","type":"article-journal","title":"Dup Again","DOI":"10.1/dup"}]"#;
        let r = import_zotero(&mut conn, csl, None).unwrap();
        assert_eq!(r.source_ids, vec!["doi:10.1/dup".to_string()]);
        assert_eq!(r.saved_count, 1);
    }

    #[test]
    fn rollback_brand_new_root_hard_deletes() {
        let mut conn = db();
        let dir = tempdir().unwrap();
        block_final_path(dir.path(), "local_newv1.pdf");

        let err = import_pdf(
            &mut conn,
            dir.path(),
            b"pdf",
            None,
            NO_LIMIT,
            resolver(meta("local:new", 1), None),
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::Internal(_)));

        // Brand-new root with NULL pdf_path → hard-deleted: paper + root gone.
        assert!(
            paper::get(&conn, &paper::PaperRef::source("local:new".into()))
                .unwrap()
                .is_none()
        );
        assert!(store::get_paper_root(&conn, "local:new").unwrap().is_none());
        // Temp upload cleaned up.
        let uploads = fs::read_dir(dir.path()).unwrap().filter(|e| {
            e.as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("_upload_")
        });
        assert_eq!(uploads.count(), 0);
    }

    #[test]
    fn rollback_restored_deleted_root_re_soft_deletes() {
        let mut conn = db();
        let dir = tempdir().unwrap();
        // No version, so pre_existing_version is false and the injected dir
        // doesn't trip preserve-existing.
        paper::ensure_paper_root(&mut conn, "arxiv:dead").unwrap();
        store::soft_delete_paper(&mut conn, "arxiv:dead").unwrap();
        assert!(store::is_paper_deleted(&conn, "arxiv:dead").unwrap());

        block_final_path(dir.path(), "arxiv_deadv1.pdf");

        let err = import_pdf(
            &mut conn,
            dir.path(),
            b"pdf",
            None,
            NO_LIMIT,
            resolver(meta("local:ignored", 1), Some(("arxiv:dead".into(), 1))),
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::Internal(_)));

        // save_paper_metadata auto-restored the root; rollback re-trashed it.
        assert!(store::is_paper_deleted(&conn, "arxiv:dead").unwrap());
    }

    #[test]
    fn rollback_restored_deleted_local_root_re_soft_deletes() {
        // Same, for a content-hash (external=None) identity: re-importing a
        // trashed local paper auto-restores its root too, so a failed import
        // must re-trash it.
        let mut conn = db();
        let dir = tempdir().unwrap();
        paper::ensure_paper_root(&mut conn, "local:dead").unwrap();
        store::soft_delete_paper(&mut conn, "local:dead").unwrap();

        block_final_path(dir.path(), "local_deadv1.pdf");

        let err = import_pdf(
            &mut conn,
            dir.path(),
            b"pdf",
            None,
            NO_LIMIT,
            resolver(meta("local:dead", 1), None),
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::Internal(_)));

        assert!(store::is_paper_deleted(&conn, "local:dead").unwrap());
    }

    #[tokio::test]
    async fn import_pdf_default_uses_real_resolver_and_mints_local_root() {
        // Wiring: resolve first (an empty but parseable PDF yields no arXiv/DOI/
        // title, so enrichment makes no network call), then mint a local:<sha>.
        let mut conn = db();
        let dir = tempdir().unwrap();
        let data_dir = tempdir().unwrap();
        let res = import_pdf_default(
            &mut conn,
            dir.path(),
            b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n\
              2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n\
              3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 9 9]>>endobj\n\
              trailer<</Root 1 0 R>>\n%%EOF\n",
            None,
            NO_LIMIT,
            data_dir.path(),
        )
        .await
        .unwrap();
        assert!(res.source_id.starts_with("local:"));
        let p = paper::get(&conn, &paper::PaperRef::source(res.source_id.clone()))
            .unwrap()
            .unwrap();
        assert!(p.has_pdf);
    }

    #[test]
    fn project_link_membership_guards() {
        let mut conn = db();
        let dir = tempdir().unwrap();

        // Missing project → ProjectNotFound, before any import work.
        let err = import_pdf(
            &mut conn,
            dir.path(),
            b"pdf",
            Some(999),
            NO_LIMIT,
            resolver(meta("local:p1", 1), None),
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::ProjectNotFound(_)));
        assert!(paper::list_papers(&conn, false, None, 0, None)
            .unwrap()
            .is_empty());

        // Deleted project → ProjectDeleted, also before import work.
        conn.execute(
            "INSERT INTO PROJECT (NAME, STATUS) VALUES ('Gone', 'deleted')",
            [],
        )
        .unwrap();
        let pid = conn.last_insert_rowid();
        let err = import_pdf(
            &mut conn,
            dir.path(),
            b"pdf",
            Some(pid),
            NO_LIMIT,
            resolver(meta("local:p2", 1), None),
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::ProjectDeleted(_)));
        assert!(paper::list_papers(&conn, false, None, 0, None)
            .unwrap()
            .is_empty());

        // Active project → paper imported AND linked.
        conn.execute(
            "INSERT INTO PROJECT (NAME, STATUS) VALUES ('Live', 'active')",
            [],
        )
        .unwrap();
        let pid = conn.last_insert_rowid();
        let res = import_pdf(
            &mut conn,
            dir.path(),
            b"pdf",
            Some(pid),
            NO_LIMIT,
            resolver(meta("local:p3", 1), None),
        )
        .unwrap();
        let root = store::get_paper_root(&conn, &res.source_id)
            .unwrap()
            .unwrap();
        assert_eq!(
            proj_store::get_paper_project_fks(&conn, root.source_fk).unwrap(),
            vec![pid]
        );
    }
}
