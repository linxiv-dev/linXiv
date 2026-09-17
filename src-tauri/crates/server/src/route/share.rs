//! `/api/share` routes — quarantined CRDT "shared projects", a second front door
//! beside `api` (`share_api` command + headless bin). Publishing only READS
//! `papers.db`; the CRDT docs live under the injected share directory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

/// Cap on a single network op (mint ticket / fetch); past it the request returns
/// 504 instead of hanging on an unreachable peer.
pub(crate) const SHARE_NET_TIMEOUT: Duration = Duration::from_secs(30);

use linxiv_core::config;
use linxiv_core::service::paper::{self as paper_svc, pdf_on_disk_name};
use linxiv_core::service::paper_import;
use linxiv_core::service::project as project_svc;
use linxiv_share::{
    build_shared_project, doc_path, e2ee_dir, e2ee_received_dir, member_id_from_hex, member_id_hex,
    received_dir, save, valid_share_id, AutoCommit, CustomRelay, MemberMeta, ProjectInvite, Role,
    ShareError, ShareNode, ShareStore, ShareTicket, SharedProject,
};

use crate::p2p_config::{self, RelaySetting};
use crate::route::{parse_query, path_i64, split_segments, to_value, ApiError, ApiRequest, ReqCtx};
use crate::share_sync;
use crate::state::AppState;

/// Managed beside `AppState` (never a field of it): owns the injected `ShareStore`
/// over the share directory and, in the packaged app, the iroh `ShareNode`.
/// `None` in store-only tests, where the network arms return 503.
pub struct ShareState {
    store: ShareStore,
    // `Option`: store-only tests skip the async bind. `Mutex<Arc>`: a network arm
    // clones the `Arc` and drops the guard before `.await`, and `shutdown` can
    // take the node out of a shared (`tauri::State`) value.
    node: Mutex<Option<Arc<ShareNode>>>,
    // Entries persist for the process lifetime.
    write_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    // Flipped once, by whichever of {startup, a later `rebind`} first finds a
    // bound node — guards against spawning the background interval-sync loop
    // twice (or never, if startup found no node but a reconnect later does).
    sync_started: AtomicBool,
    // Remote Query Mode (headless only): re-applied to every fresh node, so
    // a relay reconnect's rebind doesn't silently drop the api handler.
    api_installer: std::sync::Mutex<Option<ApiInstallFn>>,
}

/// Installs the `linxiv-api/1` handler on a freshly bound node (headless bin;
/// the desktop app never sets one).
pub type ApiInstallFn = Arc<dyn Fn(&ShareNode) + Send + Sync>;

impl ShareState {
    /// Store-only state (no network node). Used by the Phase-0 sync unit tests.
    pub fn new(share_dir: impl Into<PathBuf>) -> Self {
        Self {
            store: ShareStore::new(share_dir),
            node: Mutex::new(None),
            write_locks: Mutex::new(HashMap::new()),
            sync_started: AtomicBool::new(false),
            api_installer: std::sync::Mutex::new(None),
        }
    }

    /// Full state with a live iroh node serving the same share directory.
    pub fn with_node(share_dir: impl Into<PathBuf>, node: ShareNode) -> Self {
        Self {
            store: ShareStore::new(share_dir),
            node: Mutex::new(Some(Arc::new(node))),
            write_locks: Mutex::new(HashMap::new()),
            sync_started: AtomicBool::new(false),
            api_installer: std::sync::Mutex::new(None),
        }
    }

    /// Share directory backing this state (docs + settings/ticket sidecars).
    pub fn share_dir(&self) -> &Path {
        self.store.share_dir()
    }

    /// Clone the live node out from under the lock (`None` while store-only).
    /// `pub`: the app's remote_backend dials linxiv-api/1 over this node.
    pub async fn node(&self) -> Option<Arc<ShareNode>> {
        self.node.lock().await.clone()
    }

    /// This node's iroh endpoint id (`None` while unbound). Status reporting.
    pub async fn endpoint_id(&self) -> Option<String> {
        self.node().await.map(|n| n.endpoint_id())
    }

    /// Acquire the per-share-id write lock.
    pub(crate) async fn lock_writes(&self, share_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let mut locks = self.write_locks.lock().await;
        let arc = locks
            .entry(share_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone();
        drop(locks);
        arc.lock_owned().await
    }

    /// Tear the iroh endpoint + router down explicitly (Drop is not enough — the
    /// async close must run). Idempotent: a second call finds `None` and no-ops.
    pub async fn shutdown(&self) -> Result<(), ShareError> {
        if let Some(node) = self.node.lock().await.take() {
            node.shutdown().await?;
        }
        Ok(())
    }

    /// Flips the interval-sync-loop latch. `true` only for the caller that wins
    /// it, so exactly one loop ever runs.
    pub fn mark_sync_started(&self) -> bool {
        self.sync_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Tears the current node down (if any) and binds a fresh one with `relay` —
    /// the "Save & Reconnect" flow. A bind failure leaves the node unbound
    /// (sharing disabled) rather than silently keeping the previous relay.
    pub async fn rebind(
        &self,
        p2p_dir: &Path,
        dek: Option<[u8; 32]>,
        relay: Option<CustomRelay>,
    ) -> Result<(), ShareError> {
        let mut guard = self.node.lock().await;
        if let Some(old) = guard.take() {
            old.shutdown().await?;
        }
        let fresh = ShareNode::bind_with_dek(self.store.share_dir(), p2p_dir, dek, relay).await?;
        if let Some(install) = self.api_installer.lock().unwrap().clone() {
            install(&fresh);
        }
        *guard = Some(Arc::new(fresh));
        Ok(())
    }

    /// Registers the Remote Query Mode installer and applies it to the
    /// current node (if bound). `rebind` re-applies it to every fresh node.
    pub async fn install_api(&self, install: ApiInstallFn) {
        *self.api_installer.lock().unwrap() = Some(install.clone());
        if let Some(node) = self.node().await {
            install(&node);
        }
    }
}

/// Resolve relay settings + bind the startup share node (app + headless bin).
/// Bind failure or a required-but-missing relay warns and degrades to a
/// store-only state (sharing disabled). `dek` comes from the caller (keychain
/// access is sync). Returns `(state, node_bound)`.
pub async fn startup_share_state(dek: Option<[u8; 32]>) -> std::io::Result<(ShareState, bool)> {
    let share_dir = config::data_dir().join("share");
    std::fs::create_dir_all(&share_dir)?;
    // Persisted device key lives beside (not inside) the served share dir.
    let p2p_dir = config::data_dir().join("p2p");
    Ok(match p2p_config::relay_setting() {
        RelaySetting::RequireCustomButMissing => {
            eprintln!(
                "warning: \"only use this relay\" is on but no valid custom relay is configured; refusing to fall back to the public n0 relay, sharing disabled"
            );
            (ShareState::new(share_dir), false)
        }
        setting => {
            let relay = match setting {
                RelaySetting::Custom(relay) => Some(relay),
                _ => None,
            };
            match ShareNode::bind_with_dek(share_dir.clone(), &p2p_dir, dek, relay).await {
                Ok(node) => (ShareState::with_node(share_dir, node), true),
                Err(e) => {
                    eprintln!(
                        "warning: share node bind failed, sharing (plain and e2ee) and background sync disabled: {e}"
                    );
                    (ShareState::new(share_dir), false)
                }
            }
        }
    })
}

impl From<ShareError> for ApiError {
    fn from(e: ShareError) -> Self {
        let status = match &e {
            ShareError::NotFound(_) => 404,
            ShareError::Core(c) => c.http_status(),
            ShareError::Transport(_) => 502,
            ShareError::TooLarge(_) => 413,
            ShareError::RoleConflict | ShareError::LastReader => 409,
            ShareError::Io(_) | ShareError::Crdt(_) => 500,
        };
        ApiError::new(status, e.to_string())
    }
}

// ── typed envelopes ──────────────────────────────────────────────────────────
// The `ts_rs::TS` ones render into src/types/generated.ts (ts_bindings);
// src/api/share.ts import-aliases them (SummaryRow → SharedSummary, …).
// Serialize field order IS the wire key order (preserve_order) — never reorder.

/// One row of `GET /api/share/{projects,received}` (`SharedSummary` in src/api/share.ts).
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct SummaryRow {
    share_id: String,
    name: String,
    // Omitted (not "") when the project has no description.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    description: Option<String>,
    paper_count: usize,
    note_count: usize,
    tag_count: usize,
    synced_at: Option<String>,
    paused: bool,
    // Always serialized, but optional in the TS contract so partial rows
    // (tests, optimistic caches) can omit it.
    #[ts(optional = nullable)]
    project_fk: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    e2ee: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    member_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pending: Option<bool>,
    // Plain string in Rust; the TS union mirrors MemberRole in src/api/share.ts.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"admin\" | \"co-admin\" | \"editor\" | \"viewer\"")]
    role: Option<&'static str>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct SharedProjectsListing {
    shared_projects: Vec<SummaryRow>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct ReceivedListing {
    received: Vec<SummaryRow>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct ImportedReceipt {
    project_fk: i64,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct UnpublishedReceipt {
    unpublished: bool,
    share_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    e2ee: Option<bool>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LeftReceipt {
    left: bool,
    forgotten: bool,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct UnlinkedReceipt {
    unlinked: bool,
}

/// `GET /api/share/received/{id}` envelope — one mirror's full subgraph.
#[derive(Debug, Serialize)]
struct ReceivedDetail {
    share_id: String,
    name: String,
    description: String,
    color: Option<i64>,
    tags: Vec<String>,
    papers: Vec<Value>,
    notes: Vec<ReceivedNote>,
}

/// One note row in [`ReceivedDetail`] (`id` = the CRDT note uuid).
#[derive(Debug, Serialize)]
struct ReceivedNote {
    id: String,
    title: String,
    body: String,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct PublishedReceipt {
    share_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    e2ee: Option<bool>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct TicketMinted {
    ticket: String,
    share_id: String,
}

#[derive(Debug, Serialize)]
struct JoinedSummary {
    share_id: String,
    name: String,
    paper_count: usize,
    note_count: usize,
    tag_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    e2ee: Option<bool>,
}

#[derive(Debug, Serialize)]
struct JoinPending {
    share_id: String,
    e2ee: bool,
    pending: bool,
    reason: &'static str,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct MemberCode {
    code: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct InviteMinted {
    invite: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct MembersListing {
    members: Vec<MemberRow>,
    /// This device's member id — how the UI finds "this device" in `members`.
    /// Absent on the store-only legacy path (no live node).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "string")]
    self_member_id: Option<String>,
    /// This device's admin-tier standing; member routes require admin-tier.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "\"admin\" | \"co-admin\"")]
    self_role: Option<&'static str>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct MemberRow {
    member_id: String,
    name: Option<String>,
    // Plain string in Rust; the TS union mirrors MemberRole in src/api/share.ts.
    // "admin" is THE ADMIN (singleton, from the doc marker), "co-admin" any
    // other keyhive-Admin member; hosting is a device property, not a role.
    #[ts(type = "\"admin\" | \"co-admin\" | \"editor\" | \"viewer\"")]
    role: String,
    invited_at: String,
    revoked: bool,
    verified: bool,
    /// Re-sendable while the grant stands; `None` once revoked. Only the
    /// device that minted the invite has it (bearer secret, never synced).
    invite: Option<String>,
}

/// `GET /api/share/{id}/presence` — every member's last heartbeat. Open to
/// all members (unlike `members`, which is admin-tier).
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct PresenceListing {
    members: Vec<PresenceRow>,
    self_member_id: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct PresenceRow {
    member_id: String,
    name: Option<String>,
    /// RFC 3339 of the member's last sync pass.
    last_seen: String,
    /// Heartbeat within two sync intervals.
    online: bool,
    /// Shared paper being read (opt-in); `None` unless online.
    reading: Option<String>,
}

/// `POST /api/share/presence` body.
#[derive(Debug, Deserialize, ts_rs::TS)]
pub struct PresenceUpdate {
    /// `source_id` of the paper being read; `None` clears the indicator.
    #[ts(optional = nullable)]
    reading: Option<String>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct AdminTransferred {
    transferred: bool,
    /// The new THE ADMIN's member id (hex).
    admin: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct RoleChanged {
    member_id: String,
    role: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct RevokedReceipt {
    revoked: bool,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct RekeyedReceipt {
    rekeyed: bool,
    members: usize,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct RemovedReceipt {
    removed: bool,
    member_id: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct SharedPdfSaved {
    source_id: String,
    version: i64,
    path: String,
}

/// Tauri-free `/api/share/*` dispatcher: the app's `share_api` command and the
/// headless bin both route through here. `spawn_sync` starts the interval-sync
/// loop when the relay-reconnect arm brings the first node up.
pub async fn dispatch(
    state: &AppState,
    share: &ShareState,
    spawn_sync: &(dyn Fn() + Sync),
    req: ApiRequest,
) -> Result<Value, ApiError> {
    let mutates = nudges_sync(&req.method, &req.path);
    let res = dispatch_inner(state, share, spawn_sync, req).await;
    // Share mutations change journaled content (a received-import creates a
    // whole project) — poke the debounced loops like `route()` does.
    if mutates && res.is_ok() {
        crate::share_sync::nudge();
    }
    res
}

/// Which requests poke the sync loop: mutations, minus the presence POST that
/// fires on every paper open and close. Nudging on it turns ordinary browsing
/// into a full pass (every share dialed, every e2ee doc sealed) every ~3s.
/// ponytail: presence still rides the interval pass, which is its whole SLA.
fn nudges_sync(method: &str, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    method != "GET" && split_segments(path).join("/") != "api/share/presence"
}

async fn dispatch_inner(
    state: &AppState,
    share: &ShareState,
    spawn_sync: &(dyn Fn() + Sync),
    req: ApiRequest,
) -> Result<Value, ApiError> {
    let (raw_path, raw_query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));
    let segs = split_segments(raw_path);
    let query = parse_query(raw_query);
    let s: Vec<&str> = segs.iter().map(String::as_str).collect();
    let ctx = ReqCtx {
        method: req.method.as_str(),
        segs: &s,
        query: &query,
        body: req.body.as_ref(),
    };

    // Arms that `.await` (iroh, the write lock) live here, not in the sync
    // `handle` dispatcher below that the Phase-0 store arms share.
    match (ctx.method, ctx.segs) {
        ("POST", ["api", "share", "project", id, "ticket"]) => {
            return ticket(state, share, id).await
        }
        ("POST", ["api", "share", "join"]) => return join(share, ctx.body).await,
        ("POST", ["api", "share", "project", id, "publish"]) => {
            return publish(state, share, id).await
        }
        ("POST", ["api", "share", id, "unpublish"]) => return unpublish(share, id).await,
        ("POST", ["api", "share", "received", id, "import"]) => {
            if !valid_share_id(id) {
                return Err(ApiError::new(404, format!("share {id:?} not found")));
            }
            let _lock = share.lock_writes(id).await;
            return share_sync::import_received(state, share.share_dir(), id)
                .and_then(|fk| to_value(&ImportedReceipt { project_fk: fk }));
        }
        ("POST", ["api", "share", "received", id, "leave"]) => return leave(share, id).await,
        ("POST", ["api", "share", "received", id, "unlink"]) => {
            return unlink(state, share, id).await
        }
        ("POST", ["api", "share", id, "sync"]) => {
            return share_sync::sync_share(state, share, id).await
        }
        ("PUT" | "POST", ["api", "share", id, "settings"]) => {
            return put_settings(share, id, ctx.body).await
        }
        ("GET", ["api", "share", "member_code"]) => return member_code(share).await,
        ("POST", ["api", "share", "relay", "reconnect"]) => {
            return reconnect_relay(spawn_sync, share).await
        }
        // Shadows the sync arm in `handle` so the live app gets role-stamped
        // summaries; the store-only tests keep dispatching through `handle`.
        ("GET", ["api", "share", "received"]) => {
            return list_received_with_role(state, share).await
        }
        ("POST", ["api", "share", "project", id, "publish_secure"]) => {
            return publish_secure(state, share, id).await
        }
        ("POST", ["api", "share", id, "invite"]) => {
            return invite(state, share, id, ctx.body).await
        }
        ("GET", ["api", "share", id, "members"]) => return members(share, id).await,
        ("GET", ["api", "share", id, "presence"]) => return presence(share, id).await,
        ("POST", ["api", "share", "presence"]) => {
            return set_reading(share, ctx.parse_body()?).await
        }
        ("POST", ["api", "share", id, "member", mid, "role"]) => {
            return set_member_role(state, share, id, mid, ctx.body).await
        }
        ("POST", ["api", "share", id, "revoke"]) => {
            return revoke_member(share, id, ctx.body).await
        }
        ("POST", ["api", "share", id, "transfer_admin"]) => {
            return transfer_admin(share, id, ctx.body).await
        }
        ("POST", ["api", "share", id, "member", mid, "remove"]) => {
            return remove_member(share, id, mid).await
        }
        ("POST", ["api", "share", id, "rekey"]) => return rekey(state, share, id).await,
        ("POST", ["api", "share", id, "pdf"]) => {
            return shared_pdf(state, share, id, ctx.body).await
        }
        _ => {}
    }
    handle(state, share, &ctx).unwrap_or_else(|| Err(ApiError::not_routed()))
}

/// Match a synchronous (no-await) `/api/share/*` request; `None` = no arm.
/// The async network arms are matched in `dispatch` instead.
pub(crate) fn handle(
    state: &AppState,
    share: &ShareState,
    ctx: &ReqCtx<'_>,
) -> Option<Result<Value, ApiError>> {
    // Static segments "projects" and "received" shadow a share literally named as such.
    match (ctx.method, ctx.segs) {
        ("GET", ["api", "share", "projects"]) => Some(list_shared(state, share)),
        ("GET", ["api", "share", "received"]) => Some(list_received(state, share)),
        ("GET", ["api", "share", "received", id]) => Some(get_received(share, id)),
        ("GET", ["api", "share", id, "settings"]) => Some(get_settings(share, id)),
        _ => None,
    }
}

/// Doc-file mtime = the last local save/fetch of the CRDT doc, as ISO 8601.
fn synced_at(doc: &Path) -> Option<String> {
    std::fs::metadata(doc)
        .and_then(|m| m.modified())
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
}

fn summary_row(
    s: &linxiv_share::SharedSummary,
    doc: &Path,
    share_dir: &Path,
    project_fk: Option<i64>,
) -> SummaryRow {
    SummaryRow {
        share_id: s.share_id.clone(),
        name: s.name.clone(),
        description: (!s.description.is_empty()).then(|| s.description.clone()),
        paper_count: s.paper_count,
        note_count: s.note_count,
        tag_count: s.tag_count,
        synced_at: synced_at(doc),
        paused: share_sync::load_settings(share_dir, &s.share_id).paused,
        project_fk,
        e2ee: None,
        member_count: None,
        pending: None,
        role: None,
    }
}

/// `GET /api/share/projects` — summaries of every published shared project.
/// `pub` so the headless bin's status aggregate reuses it.
pub fn list_shared(state: &AppState, share: &ShareState) -> Result<Value, ApiError> {
    let dir = share.store.share_dir();
    let mut out = Vec::new();
    for s in share.store.list_shared()? {
        let fk = state.with_conn(|c| project_svc::find_by_share_id(c, &s.share_id))?;
        out.push(summary_row(&s, &doc_path(dir, &s.share_id), dir, fk));
    }
    for s in ShareNode::list_e2ee(dir)? {
        let fk = state.with_conn(|c| project_svc::find_by_share_id(c, &s.share_id))?;
        let mut row = summary_row(&s, &doc_path(&e2ee_dir(dir), &s.share_id), dir, fk);
        row.e2ee = Some(true);
        row.member_count = Some(live_member_count(dir, &s.share_id));
        out.push(row);
    }
    to_value(&SharedProjectsListing {
        shared_projects: out,
    })
}

/// The `received` rows: every `join`-materialized mirror plus the pending placeholders.
fn received_rows(state: &AppState, share: &ShareState) -> Result<Vec<SummaryRow>, ApiError> {
    let dir = share.store.share_dir();
    let rec = received_dir(dir);
    let mut out = Vec::new();
    for s in linxiv_share::ShareNode::list_received(dir)? {
        let fk = state.with_conn(|c| project_svc::find_by_share_id(c, &s.share_id))?;
        out.push(summary_row(&s, &doc_path(&rec, &s.share_id), dir, fk));
    }
    for s in ShareNode::list_e2ee_received(dir)? {
        let fk = state.with_conn(|c| project_svc::find_by_share_id(c, &s.share_id))?;
        let mut row = summary_row(&s, &doc_path(&e2ee_received_dir(dir), &s.share_id), dir, fk);
        row.e2ee = Some(true);
        out.push(row);
    }
    let pending = pending_received(dir, &out);
    out.extend(pending);
    Ok(out)
}

/// `GET /api/share/received` — every mirror's summary; `pub` for the headless bin.
pub fn list_received(state: &AppState, share: &ShareState) -> Result<Value, ApiError> {
    to_value(&ReceivedListing {
        received: received_rows(state, share)?,
    })
}

/// Mirrors under `e2ee/received` whose doc holds no content yet: `accept_invite`
/// writes an empty placeholder when the host is unreachable, and an empty doc
/// never hydrates, so the listing above drops it and the join vanishes. Surfaced
/// as `pending` so the user can retry the sync (or leave) by hand.
fn pending_received(dir: &Path, listed: &[SummaryRow]) -> Vec<SummaryRow> {
    share_sync::doc_ids(&e2ee_received_dir(dir))
        .into_iter()
        .filter(|id| !listed.iter().any(|r| r.share_id == *id))
        .map(|id| SummaryRow {
            paused: share_sync::load_settings(dir, &id).paused,
            share_id: id,
            name: String::new(),
            description: None,
            paper_count: 0,
            note_count: 0,
            tag_count: 0,
            // The placeholder's mtime is the join, not a sync — report none.
            synced_at: None,
            project_fk: None,
            e2ee: Some(true),
            member_count: None,
            pending: Some(true),
            role: None,
        })
        .collect()
}

/// `list_received` plus the reader's own capability (spec §7): each e2ee entry
/// gets its `role` from a live `query_role` against this device's member id.
/// Absent when the node is offline or on plain mirrors — the GUI treats an
/// unknown role as editable; enforcement is server+crypto, this field is UX only.
async fn list_received_with_role(state: &AppState, share: &ShareState) -> Result<Value, ApiError> {
    let mut rows = received_rows(state, share)?;
    if let Some(node) = share.node().await {
        if let Ok(me) = node.self_member_id() {
            // Pending mirrors are skipped: no content for a role to gate, and
            // one unanswered query each would stall the whole listing.
            let targets: Vec<usize> = rows
                .iter()
                .enumerate()
                .filter(|(_, r)| r.e2ee == Some(true) && r.pending != Some(true))
                .map(|(i, _)| i)
                .collect();
            // Concurrent so a slow relay can't stall the listing by
            // (entries × budget); each query keeps its own timeout budget.
            let roles = futures_util::future::join_all(
                targets
                    .iter()
                    .map(|&i| e2ee_timeout(node.query_role(&rows[i].share_id, me), "role query")),
            )
            .await;
            for (&i, res) in targets.iter().zip(roles) {
                // A failed or empty query leaves `role` unset (degrades editable).
                if let Ok(Some(role)) = res {
                    rows[i].role = match role {
                        Role::Read => Some("viewer"),
                        Role::Edit => Some("editor"),
                        // Admin tier splits on THE-ADMIN standing. Derived
                        // from the same validated path the member routes use
                        // (admin_standing), so the label can't disagree with
                        // enforcement when the marker is garbage or forged.
                        Role::Admin => {
                            let sid = rows[i].share_id.clone();
                            let roster = fetch_roster(&node, share.share_dir(), &sid).await;
                            let the_admin =
                                admin_standing(&node, E2eeSide::Received, &sid, &roster)
                                    .await
                                    .map(|s| s.the_admin)
                                    .unwrap_or(false);
                            Some(if the_admin { "admin" } else { "co-admin" })
                        }
                        Role::Relay => continue,
                    };
                }
            }
        }
    }
    to_value(&ReceivedListing { received: rows })
}

/// A doc file for `id` in any role (plain/e2ee, hosted/received).
fn any_doc_exists(dir: &Path, id: &str) -> bool {
    doc_path(dir, id).is_file()
        || doc_path(&received_dir(dir), id).is_file()
        || doc_path(&e2ee_dir(dir), id).is_file()
        || doc_path(&e2ee_received_dir(dir), id).is_file()
}

/// `GET /api/share/{id}/settings` — the per-share sidecar (defaults if unset).
fn get_settings(share: &ShareState, id: &str) -> Result<Value, ApiError> {
    if !valid_share_id(id) {
        return Err(ApiError::new(404, format!("share {id:?} not found")));
    }
    let dir = share.share_dir();
    if !any_doc_exists(dir, id) {
        return Err(ApiError::new(404, format!("share {id:?} not found")));
    }
    Ok(serde_json::to_value(share_sync::load_settings(dir, id)).unwrap())
}

/// `PUT /api/share/{id}/settings` — partial update over the current sidecar.
async fn put_settings(
    share: &ShareState,
    id: &str,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    if !valid_share_id(id) {
        return Err(ApiError::new(404, format!("share {id:?} not found")));
    }
    let dir = share.share_dir();
    if !any_doc_exists(dir, id) {
        return Err(ApiError::new(404, format!("share {id:?} not found")));
    }
    let _lock = share.lock_writes(id).await;
    let mut s = share_sync::load_settings(dir, id);
    if let Some(p) = body.and_then(|b| b.get("paused")) {
        s.paused = p
            .as_bool()
            .ok_or_else(|| ApiError::new(422, "`paused` must be a boolean"))?;
    }
    if let Some(d) = body.and_then(|b| b.get("direction")) {
        s.direction =
            serde_json::from_value::<share_sync::SyncDirection>(d.clone()).map_err(|_| {
                ApiError::new(
                    422,
                    "direction must be one of two_way, shared_to_local, local_to_shared",
                )
            })?;
    }
    share_sync::save_settings(dir, id, &s)
        .map_err(|e| ApiError::new(500, format!("could not persist share settings: {e}")))?;
    Ok(serde_json::to_value(s).unwrap())
}

// ── e2ee members sidecar (`share_dir/members/<id>.json`) ────────────────────

/// One device invited FROM this device on an e2ee share. The sidecar is the
/// local bookkeeping half of the members list (invite strings live only here);
/// the doc's synced roster covers members invited elsewhere, and `query_role`
/// is the live truth-check for both.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MemberEntry {
    pub member_id_hex: String,
    #[serde(default)]
    pub name: Option<String>,
    /// "hoster" | "editor" | "viewer"
    pub role: String,
    pub invited_at: String,
    #[serde(default)]
    pub revoked: bool,
    /// The last invite string minted for this member, so the host can re-send it
    /// without asking for the member code again. Absent on pre-upgrade sidecars;
    /// cleared when the grant changes (revoke / role change) — it goes stale.
    // ponytail: a bearer capability at rest in the share dir, beside the doc
    // and key store it grants against; upgrade: store it in the key store.
    #[serde(default)]
    pub invite: Option<String>,
}

/// Devices this share is granted to, for the hoster sync line: the local
/// invite sidecar unioned with the roster mirror (see [`fetch_roster`]), so
/// members invited on a co-admin's device still count here. Locally-known
/// revocations and the hoster row are excluded from both sides.
pub(crate) fn live_member_count(share_dir: &Path, share_id: &str) -> usize {
    let sidecar = load_members(share_dir, share_id);
    let dead: std::collections::HashSet<&str> = sidecar
        .iter()
        .filter(|m| m.revoked || m.role == "hoster")
        .map(|m| m.member_id_hex.as_str())
        .collect();
    let mut ids: std::collections::HashSet<String> = sidecar
        .iter()
        .filter(|m| !m.revoked && m.role != "hoster")
        .map(|m| m.member_id_hex.clone())
        .collect();
    for m in load_roster_cache(share_dir, share_id) {
        // The root entry (invited_by: None) is the creator/hosting device,
        // seeded by publish — not a device the share was granted to.
        if m.invited_by.is_some() && !dead.contains(m.member_id.as_str()) {
            ids.insert(m.member_id);
        }
    }
    ids.len()
}

// ── roster mirror (`share_dir/members/<id>.roster.json`) ────────────────────
// The synced roster lives in the beelay doc, reachable only through the live
// node; these keep a local mirror beside the invite sidecar so node-less
// paths (live_member_count) still see members invited on other devices.

fn roster_cache_path(share_dir: &Path, share_id: &str) -> PathBuf {
    share_dir
        .join("members")
        .join(format!("{share_id}.roster.json"))
}

/// Missing or corrupt mirror → empty list.
pub(crate) fn load_roster_cache(share_dir: &Path, share_id: &str) -> Vec<linxiv_share::MemberMeta> {
    std::fs::read(roster_cache_path(share_dir, share_id))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_roster_cache(share_dir: &Path, share_id: &str, roster: &[linxiv_share::MemberMeta]) {
    let path = roster_cache_path(share_dir, share_id);
    let Some(parent) = path.parent() else { return };
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(roster).expect("roster serialize");
    // Best-effort mirror: a failed write only staled the count, never the op.
    let _ = std::fs::create_dir_all(parent)
        .and_then(|()| std::fs::write(&tmp, bytes))
        .and_then(|()| std::fs::rename(&tmp, &path));
}

/// The doc's synced roster via the live node, mirrored to disk on success.
/// Errors read as an empty roster, matching the old call sites.
pub(crate) async fn fetch_roster(
    node: &linxiv_share::ShareNode,
    share_dir: &Path,
    share_id: &str,
) -> Vec<linxiv_share::MemberMeta> {
    match e2ee_timeout(node.member_meta(share_id), "roster").await {
        Ok(roster) => {
            save_roster_cache(share_dir, share_id, &roster);
            roster
        }
        Err(_) => Vec::new(),
    }
}

fn members_path(share_dir: &Path, share_id: &str) -> PathBuf {
    share_dir.join("members").join(format!("{share_id}.json"))
}

/// Missing or corrupt sidecar → empty list.
pub(crate) fn load_members(share_dir: &Path, share_id: &str) -> Vec<MemberEntry> {
    std::fs::read(members_path(share_dir, share_id))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_members(share_dir: &Path, share_id: &str, list: &[MemberEntry]) -> std::io::Result<()> {
    let path = members_path(share_dir, share_id);
    std::fs::create_dir_all(path.parent().expect("members path has a parent"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(list).expect("members serialize"))?;
    std::fs::rename(&tmp, &path)
}

/// 404 unless `share_id` is a hoster-owned e2ee doc.
fn ensure_e2ee_hosted(share_dir: &Path, share_id: &str) -> Result<(), ApiError> {
    if !valid_share_id(share_id) || !doc_path(&e2ee_dir(share_dir), share_id).is_file() {
        return Err(ApiError::new(
            404,
            format!("e2ee share {share_id:?} not found"),
        ));
    }
    Ok(())
}

/// Which side of an e2ee share this device is on. Member-management routes
/// accept both: co-admin devices run keyhive delegation/PCS rotation
/// themselves; only doc hosting stays a device property.
#[derive(Debug, Clone, Copy, PartialEq)]
enum E2eeSide {
    Hosted,
    Received,
}

/// 404 unless `share_id` is an e2ee doc on this device (either side).
fn e2ee_side(share_dir: &Path, share_id: &str) -> Result<E2eeSide, ApiError> {
    if valid_share_id(share_id) {
        if doc_path(&e2ee_dir(share_dir), share_id).is_file() {
            return Ok(E2eeSide::Hosted);
        }
        if doc_path(&e2ee_received_dir(share_dir), share_id).is_file() {
            return Ok(E2eeSide::Received);
        }
    }
    Err(ApiError::new(
        404,
        format!("e2ee share {share_id:?} not found"),
    ))
}

/// The acting device's admin standing on an e2ee share. THE ADMIN is named by
/// the doc's marker; a pre-co-admin doc (no marker, no roster) falls back to
/// "the hosting device is THE ADMIN".
struct Standing {
    self_hex: String,
    /// THE ADMIN's member id, from marker → roster root → hosted-self.
    admin_hex: Option<String>,
    /// Holds keyhive Admin (THE ADMIN or co-admin).
    keyhive_admin: bool,
    the_admin: bool,
}

async fn admin_standing(
    node: &ShareNode,
    side: E2eeSide,
    id: &str,
    roster: &[MemberMeta],
) -> Result<Standing, ApiError> {
    let self_id = node.self_member_id().map_err(fetch_error)?;
    let self_hex = member_id_hex(&self_id);
    // Fail closed: an authorization input that can't be read is an error,
    // never a silent fallback to a weaker answer.
    let marker = e2ee_timeout(node.admin_marker(id), "admin lookup").await?;
    // The register is member-writable, so the marker only counts when its
    // holder actually holds keyhive Admin: a garbage or editor-forged value
    // is ignored (falling back to the creator root = the repair path). A
    // keyhive-Admin holder is indistinguishable from a real transfer here;
    // that residual needs signed transfers (deferred).
    let marker = match marker {
        Some(hex) => {
            if is_keyhive_admin(node, id, &hex).await? {
                Some(hex)
            } else {
                eprintln!("share {id}: admin marker holder {hex} lacks keyhive Admin; ignoring");
                None
            }
        }
        None => None,
    };
    let mut admin_hex = marker;
    if admin_hex.is_none() {
        // Roster root (invited_by: None) is the project creator — but the
        // roster is member-writable too, so the root gets the same
        // keyhive-Admin validation as the marker before it counts.
        if let Some(root) = roster.iter().find(|m| m.invited_by.is_none()) {
            if is_keyhive_admin(node, id, &root.member_id).await? {
                admin_hex = Some(root.member_id.clone());
            } else {
                eprintln!(
                    "share {id}: roster root {} lacks keyhive Admin; ignoring",
                    root.member_id
                );
            }
        }
    }
    let admin_hex = admin_hex.or_else(|| (side == E2eeSide::Hosted).then(|| self_hex.clone()));
    let keyhive_admin = match side {
        // The creator's root delegation is Admin and irrevocable.
        E2eeSide::Hosted => true,
        E2eeSide::Received => matches!(
            e2ee_timeout(node.query_role(id, self_id), "role check").await?,
            Some(Role::Admin)
        ),
    };
    let the_admin = admin_hex.as_deref() == Some(self_hex.as_str());
    Ok(Standing {
        self_hex,
        admin_hex,
        keyhive_admin,
        the_admin,
    })
}

/// Whether `hex` currently holds keyhive Admin on this share. Malformed ids
/// are simply not admins; read failures propagate (fail closed).
async fn is_keyhive_admin(node: &ShareNode, id: &str, hex: &str) -> Result<bool, ApiError> {
    let Some(mid) = member_id_from_hex(hex) else {
        return Ok(false);
    };
    Ok(matches!(
        e2ee_timeout(node.query_role(id, mid), "role check").await?,
        Some(Role::Admin)
    ))
}

impl Standing {
    fn require_admin_tier(&self) -> Result<(), ApiError> {
        if self.keyhive_admin {
            Ok(())
        } else {
            Err(ApiError::new(
                403,
                "only admins and co-admins can manage members",
            ))
        }
    }

    fn role_label(&self) -> &'static str {
        if self.the_admin {
            "admin"
        } else {
            "co-admin"
        }
    }

    /// Wire label for a keyhive role held by `hex`.
    fn label_for(&self, role: Role, hex: &str) -> Option<&'static str> {
        match role {
            Role::Read => Some("viewer"),
            Role::Edit => Some("editor"),
            Role::Admin => Some(if self.admin_hex.as_deref() == Some(hex) {
                "admin"
            } else {
                "co-admin"
            }),
            Role::Relay => None,
        }
    }
}

/// Keyhive revocation (and role change, which revokes + regrants) needs causal
/// seniority: the signer must be an ancestor issuer in the target's delegation
/// lineage. The synced roster's `invited_by` chain mirrors that lineage, so
/// this pre-empts a doomed op with a clear 409 instead of a keyhive NoProof.
/// The hosted device is the creator (every lineage roots at it): always true.
/// Unknown lineage (roster gap) → attempt anyway and let keyhive decide.
fn lineage_allows(
    roster: &[MemberMeta],
    side: E2eeSide,
    actor_hex: &str,
    target_hex: &str,
) -> bool {
    if side == E2eeSide::Hosted {
        return true;
    }
    let mut cur = target_hex.to_string();
    // Bounded walk: a corrupt roster with an invited_by cycle must not spin.
    for _ in 0..roster.len() + 1 {
        let Some(entry) = roster.iter().find(|m| m.member_id == cur) else {
            return true;
        };
        match &entry.invited_by {
            Some(inviter) if inviter == actor_hex => return true,
            Some(inviter) => cur = inviter.clone(),
            None => return false,
        }
    }
    false
}

fn seniority_err() -> ApiError {
    ApiError::new(
        409,
        "keyhive causal seniority: only the device that invited this member \
         (or the project host) can revoke or demote them",
    )
}

/// `<doc>.unpublished` — where `unpublish` parks a doc's CRDT history.
fn unpublished_path(doc: &Path) -> PathBuf {
    let mut p = doc.as_os_str().to_owned();
    p.push(".unpublished");
    PathBuf::from(p)
}

/// Move a parked doc back to the live name when no live doc exists.
fn restore_unpublished(dir: &Path, share_id: &str) {
    let doc = doc_path(dir, share_id);
    if !doc.is_file() {
        let parked = unpublished_path(&doc);
        if parked.is_file() {
            let _ = std::fs::rename(&parked, &doc);
        }
    }
}

/// `POST /api/share/{id}/unpublish` — park the published doc as
/// `<id>.automerge.unpublished` and delete its settings sidecar. An e2ee doc
/// revokes every active member first, which stops the beelay node serving it.
async fn unpublish(share: &ShareState, id: &str) -> Result<Value, ApiError> {
    if !valid_share_id(id) {
        return Err(ApiError::new(404, format!("share {id:?} not found")));
    }
    let dir = share.share_dir();
    let _lock = share.lock_writes(id).await;
    let doc = doc_path(dir, id);
    if doc.is_file() {
        std::fs::rename(&doc, unpublished_path(&doc))
            .map_err(|e| ApiError::new(500, format!("could not unpublish: {e}")))?;
        let _ = std::fs::remove_file(share_sync::settings_path(dir, id));
        return to_value(&UnpublishedReceipt {
            unpublished: true,
            share_id: id.into(),
            e2ee: None,
        });
    }
    let e2ee_doc = doc_path(&e2ee_dir(dir), id);
    if !e2ee_doc.is_file() {
        return Err(ApiError::new(404, format!("share {id:?} not found")));
    }
    // Revocation runs against the live node (content lives in beelay state).
    let node = live_node(share).await?;
    // Unpublish is the delete lever, and only THE ADMIN deletes: a hosting
    // device that transferred the role away is a co-admin and may not revoke
    // the whole membership (including THE ADMIN) on its way out.
    let roster = fetch_roster(&node, dir, id).await;
    let standing = admin_standing(&node, E2eeSide::Hosted, id, &roster).await?;
    if !standing.the_admin {
        return Err(ApiError::new(
            403,
            "only THE ADMIN can unpublish; transfer the admin role back first",
        ));
    }
    let mut list = load_members(dir, id);
    let mut failed = Vec::new();
    for m in list.iter_mut().filter(|m| !m.revoked && m.role != "hoster") {
        let Some(mid) = member_id_from_hex(&m.member_id_hex) else {
            eprintln!(
                "share {id}: marking malformed member id {} revoked",
                m.member_id_hex
            );
            m.revoked = true;
            continue;
        };
        // query_role == None: keyhive already dropped them; just mark the sidecar.
        if matches!(
            e2ee_timeout(node.query_role(id, mid), "member query").await,
            Ok(None)
        ) {
            m.revoked = true;
            continue;
        }
        match e2ee_timeout(node.revoke(id, mid), "revoke").await {
            Ok(_) => m.revoked = true,
            Err(e) => failed.push(format!("{}: {}", m.member_id_hex, e.detail)),
        }
    }
    // Members granted from co-admin devices exist only in the synced roster,
    // not this sidecar — revoke them too, or their keyhive grant outlives the
    // unpublish and a later republish silently serves them again.
    let sidecar_ids: std::collections::HashSet<&str> =
        list.iter().map(|m| m.member_id_hex.as_str()).collect();
    for m in fetch_roster(&node, dir, id).await {
        // invited_by: None is the creator's own root entry — never revocable
        // (and never a granted device), even if the hoster sidecar row was
        // lost to a failed write.
        if m.invited_by.is_none() || sidecar_ids.contains(m.member_id.as_str()) {
            continue;
        }
        let Some(mid) = member_id_from_hex(&m.member_id) else {
            continue;
        };
        if matches!(
            e2ee_timeout(node.query_role(id, mid), "member query").await,
            Ok(None)
        ) {
            continue;
        }
        match e2ee_timeout(node.revoke(id, mid), "revoke").await {
            Ok(_) => {
                let _ = e2ee_timeout(node.remove_member_meta(id, &m.member_id), "roster").await;
            }
            Err(e) => failed.push(format!("{}: {}", m.member_id, e.detail)),
        }
    }
    // Mirror the post-revoke roster so counts don't read the parked members.
    fetch_roster(&node, dir, id).await;
    if let Err(e) = save_members(dir, id, &list) {
        eprintln!("share {id}: could not persist members sidecar: {e}");
    }
    if !failed.is_empty() {
        return Err(ApiError::new(
            502,
            format!("unpublish aborted, could not revoke: {}", failed.join("; ")),
        ));
    }
    std::fs::rename(&e2ee_doc, unpublished_path(&e2ee_doc))
        .map_err(|e| ApiError::new(500, format!("could not unpublish: {e}")))?;
    let _ = std::fs::remove_file(share_sync::settings_path(dir, id));
    let _ = std::fs::remove_file(members_path(dir, id));
    to_value(&UnpublishedReceipt {
        unpublished: true,
        share_id: id.into(),
        e2ee: Some(true),
    })
}

/// `POST /api/share/received/{id}/leave` — delete the mirror + ticket + settings,
/// and drop the beelay registration behind an e2ee mirror so a later rejoin adopts
/// from scratch. `forgotten: false` = node down, so a rejoin reuses the old doc.
async fn leave(share: &ShareState, id: &str) -> Result<Value, ApiError> {
    if !valid_share_id(id) {
        return Err(ApiError::new(404, format!("share {id:?} not found")));
    }
    let dir = share.share_dir();
    let _lock = share.lock_writes(id).await;
    let mirror = doc_path(&received_dir(dir), id);
    let e2ee_mirror = doc_path(&e2ee_received_dir(dir), id);
    let was_e2ee = e2ee_mirror.is_file();
    let target = [&mirror, &e2ee_mirror].into_iter().find(|p| p.is_file());
    let Some(target) = target else {
        return Err(ApiError::new(
            404,
            format!("received share {id:?} not found"),
        ));
    };
    // Beelay first: deleting the mirror while the registration survives is the
    // half-state that makes a rejoin silently reuse the old doc.
    let mut forgotten = !was_e2ee;
    if was_e2ee {
        match share.node().await {
            Some(node) => {
                // THE ADMIN leaving strands the admin tier: unpublish and
                // transfer both need the marker-holder. Transfer first. If
                // standing can't be read (doc missing from beelay — reset
                // p2p dir, parked join), there's nothing to guard: leave is
                // cleanup of this device, and forget_e2ee handles absence.
                let roster = fetch_roster(&node, dir, id).await;
                match admin_standing(&node, E2eeSide::Received, id, &roster).await {
                    Ok(standing) if standing.the_admin => {
                        return Err(ApiError::new(
                            409,
                            "this device holds THE ADMIN role; transfer it before leaving",
                        ));
                    }
                    Ok(_) => {}
                    // Only the doc-absent case skips the guard; a transient
                    // read failure fails closed, or THE ADMIN could leave
                    // during a timeout and strand the marker forever.
                    Err(e) if e.status == 404 => {
                        eprintln!("share {id}: leave admin check skipped: {}", e.detail)
                    }
                    Err(e) => return Err(e),
                }
                e2ee_timeout(node.forget_e2ee(id), "leave share").await?;
                forgotten = true;
            }
            // Not fatal: the user asked to leave, and the files below are what
            // the interval loop reads. The response says the undo is partial.
            // (Offline we also cannot check the admin marker — a marker-holder
            // leaving offline is a known hole, recoverable by rejoining.)
            None => eprintln!("share {id}: leaving with p2p offline; beelay entry survives"),
        }
    }
    std::fs::remove_file(target)
        .map_err(|e| ApiError::new(500, format!("could not leave share: {e}")))?;
    let _ = std::fs::remove_file(share_sync::ticket_path(dir, id));
    let _ = std::fs::remove_file(share_sync::settings_path(dir, id));
    // Re-accepting the same invite in this session merges the host's doc back
    // with our stale `reading` in it; owe that rejoin a fresh boot clear.
    share_sync::forget_presence_pass(id);
    // Deletion-propagation baselines must not outlive the mirror: a stale one
    // would seed bogus local deletions on a later rejoin.
    let _ = std::fs::remove_file(doc_path(&share_sync::applied_dir(&received_dir(dir)), id));
    let _ = std::fs::remove_file(doc_path(
        &share_sync::applied_dir(&e2ee_received_dir(dir)),
        id,
    ));
    to_value(&LeftReceipt {
        left: true,
        forgotten,
    })
}

/// `POST /api/share/received/{id}/unlink` — detach the linked local project
/// from a received share. Membership, mirror, and the project all stay; the
/// interval sync keeps refreshing the mirror but stops importing (its import
/// legs are gated on `find_by_share_id`). Re-importing creates a fresh link.
async fn unlink(state: &AppState, share: &ShareState, id: &str) -> Result<Value, ApiError> {
    if !valid_share_id(id) {
        return Err(ApiError::new(404, format!("share {id:?} not found")));
    }
    let dir = share.share_dir();
    // Received mirrors only: clearing a hoster project's SHARE_ID would drop
    // its publish identity.
    if !doc_path(&received_dir(dir), id).is_file()
        && !doc_path(&e2ee_received_dir(dir), id).is_file()
    {
        return Err(ApiError::new(
            404,
            format!("received share {id:?} not found"),
        ));
    }
    let _lock = share.lock_writes(id).await;
    let unlinked = state.with_conn(|c| project_svc::release_share_id(c, id))?;
    to_value(&UnlinkedReceipt { unlinked })
}

/// `GET /api/share/received/{id}` — the full subgraph of one received mirror
/// (plain, falling back to the e2ee mirror of the same id).
fn get_received(share: &ShareState, id: &str) -> Result<Value, ApiError> {
    let dir = share.store.share_dir();
    let sp = match linxiv_share::ShareNode::received(dir, id) {
        Err(ShareError::NotFound(_)) => linxiv_share::ShareNode::e2ee_received(dir, id)?,
        other => other?,
    };
    to_value(&ReceivedDetail {
        share_id: sp.share_id,
        name: sp.name,
        description: sp.description,
        color: sp.color,
        tags: sp.tags,
        papers: sp.papers.iter().map(|p| p.to_summary_value()).collect(),
        notes: sp
            .notes
            .into_iter()
            .map(|n| ReceivedNote {
                id: n.uuid,
                title: n.title,
                body: n.body,
                created_at: n.created_at,
                updated_at: n.updated_at,
            })
            .collect(),
    })
}

/// `POST /api/share/project/{id}/publish` — snapshot a canonical project into the
/// CRDT store (read-only over the canonical connection) and return its share_id.
async fn publish(state: &AppState, share: &ShareState, id: &str) -> Result<Value, ApiError> {
    let (sp, doc, _lock) = publish_plain(state, share, id).await?;
    if let Some(node) = share.node().await {
        node.register_doc(&sp.share_id, doc)?;
    }
    to_value(&PublishedReceipt {
        share_id: sp.share_id,
        e2ee: None,
    })
}

/// Snapshot the project, refuse ids owned by a received or e2ee share, and save
/// the plain doc under the returned write-lock guard — the shared half of
/// `publish` and `ticket`.
async fn publish_plain(
    state: &AppState,
    share: &ShareState,
    id: &str,
) -> Result<(SharedProject, AutoCommit, tokio::sync::OwnedMutexGuard<()>), ApiError> {
    let project_id = path_i64(id)?;
    let sp = state.with_conn(|conn| build_shared_project(conn, project_id))?;
    let dir = share.store.share_dir();
    if doc_path(&received_dir(dir), &sp.share_id).is_file() {
        return Err(ApiError::new(
            409,
            "project is linked to a received share; leave the share before publishing",
        ));
    }
    if doc_path(&e2ee_dir(dir), &sp.share_id).is_file()
        || doc_path(&e2ee_received_dir(dir), &sp.share_id).is_file()
    {
        return Err(ApiError::new(
            409,
            "project is published as an encrypted share; unpublish it before publishing plain",
        ));
    }
    let lock = share.lock_writes(&sp.share_id).await;
    restore_unpublished(dir, &sp.share_id);
    let doc = save(dir, &sp)?;
    Ok((sp, doc, lock))
}

// Clone the node Arc out from under the lock, then release it: the network
// op must not hold the guard `shutdown()` also needs.
async fn live_node(share: &ShareState) -> Result<Arc<ShareNode>, ApiError> {
    share
        .node()
        .await
        .ok_or_else(|| ApiError::new(503, "share transport not initialized"))
}

/// `POST /api/share/project/{id}/ticket` — publish the project if needed, then
/// mint a pasteable ticket carrying the sender's address + share id. Access is
/// gated by whether that id is currently published, not a per-recipient secret.
async fn ticket(state: &AppState, share: &ShareState, id: &str) -> Result<Value, ApiError> {
    // `_` (not `_doc`): drop the saved doc now rather than holding it across the
    // network call — `ticket` re-reads it from disk anyway.
    let (sp, _, _lock) = publish_plain(state, share, id).await?;

    let node = live_node(share).await?;
    let ticket = tokio::time::timeout(SHARE_NET_TIMEOUT, node.ticket(&sp.share_id))
        .await
        .map_err(|_| ApiError::new(504, "share ticket timed out"))??;
    to_value(&TicketMinted {
        ticket: ticket.to_string(),
        share_id: sp.share_id,
    })
}

/// `POST /api/share/join` — dial the ticket's sender, fetch the CRDT doc, and
/// materialize it as a read-only mirror under the receiver's share dir. Returns
/// the resulting shared-project summary.
async fn join(share: &ShareState, body: Option<&Value>) -> Result<Value, ApiError> {
    let raw = body
        .and_then(|b| b.get("ticket"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(422, "missing `ticket` in body"))?;
    let ticket: ShareTicket = match raw.parse() {
        Ok(t) => t,
        // Not a plain ticket — maybe an e2ee invite.
        Err(ticket_err) => return join_invite(share, raw, ticket_err).await,
    };

    let node = live_node(share).await?;
    // Held across the fetch, covering the mirror write for this share id.
    let _lock = share.lock_writes(ticket.project_id()).await;
    let sp = tokio::time::timeout(
        SHARE_NET_TIMEOUT,
        node.fetch(&ticket, share.store.share_dir()),
    )
    .await
    .map_err(|_| ApiError::new(504, "share join timed out"))?
    .map_err(fetch_error)?;
    // Ticket sidecar: re-sync needs the origin address. Failed write is logged.
    let tpath = share_sync::ticket_path(share.store.share_dir(), &sp.share_id);
    let mut tmp = tpath.clone();
    tmp.set_extension("tmp");
    if let Err(e) = std::fs::write(&tmp, raw).and_then(|_| std::fs::rename(&tmp, &tpath)) {
        eprintln!("share join: could not persist ticket sidecar: {e}");
    }
    to_value(&JoinedSummary {
        share_id: sp.share_id,
        name: sp.name,
        paper_count: sp.papers.len(),
        note_count: sp.notes.len(),
        tag_count: sp.tags.len(),
        e2ee: None,
    })
}

/// `join` fall-through for e2ee invites: accept the invite (adopts + one sync +
/// mirror under `e2ee/received/`) and return the same joined-summary shape. No
/// ticket sidecar — the host address lives in beelay state.
async fn join_invite(
    share: &ShareState,
    raw: &str,
    ticket_err: impl std::fmt::Display,
) -> Result<Value, ApiError> {
    let invite: ProjectInvite = raw.parse().map_err(|invite_err| {
        ApiError::new(
            400,
            format!("not a share ticket or invite: {ticket_err}; {invite_err}"),
        )
    })?;
    if !valid_share_id(invite.project_id()) {
        return Err(ApiError::new(400, "invite has a malformed project id"));
    }
    let node = live_node(share).await?;
    let _lock = share.lock_writes(invite.project_id()).await;
    let dir = share.share_dir();
    let iid = invite.project_id();
    if doc_path(dir, iid).is_file()
        || doc_path(&e2ee_dir(dir), iid).is_file()
        || doc_path(&received_dir(dir), iid).is_file()
        || doc_path(&e2ee_received_dir(dir), iid).is_file()
    {
        return Err(ApiError::new(
            409,
            "share id is already published or mirrored here; unpublish or leave it first",
        ));
    }
    let accepted = e2ee_timeout(node.accept_invite(raw), "share join").await?;
    // Host asleep: the invite is saved and syncs on a later pass — a success with
    // nothing to summarize yet (the mirror is an empty placeholder).
    if accepted.pending {
        return to_value(&JoinPending {
            share_id: accepted.share_id,
            e2ee: true,
            pending: true,
            reason: "host unreachable; the invite is saved and will finish syncing when the host is online",
        });
    }
    let share_id = accepted.share_id;
    let sp = match ShareNode::e2ee_received(share.share_dir(), &share_id) {
        Ok(sp) => sp,
        // Dialled the host, but nothing decrypted into the mirror yet (no key
        // for our epoch). Same shape as the asleep-host case: adopted, pending.
        Err(ShareError::NotFound(_)) => {
            return to_value(&JoinPending {
                share_id,
                e2ee: true,
                pending: true,
                reason: "joined, but no content has decrypted yet; it will finish syncing shortly",
            })
        }
        Err(e) => return Err(e.into()),
    };
    to_value(&JoinedSummary {
        share_id: sp.share_id,
        name: sp.name,
        paper_count: sp.papers.len(),
        note_count: sp.notes.len(),
        tag_count: sp.tags.len(),
        e2ee: Some(true),
    })
}

/// Map a `fetch` failure to a status: refused/unknown capability → 404 (the peer
/// answered, the doc just isn't served to us); typed capability conflicts keep
/// their 409; anything else in the live dial is a transport fault → 502, never 500.
fn fetch_error(e: ShareError) -> ApiError {
    match e {
        ShareError::NotFound(_) => ApiError::new(404, e.to_string()),
        ShareError::RoleConflict | ShareError::LastReader => ApiError::new(409, e.to_string()),
        _ => ApiError::new(502, e.to_string()),
    }
}

// ── W4: e2ee arms ────────────────────────────────────────────────────────────

/// Keyhive/BeeKEM ops run slower than plain sync; e2ee arms double the budget.
async fn e2ee_timeout<T>(
    fut: impl std::future::Future<Output = Result<T, ShareError>>,
    what: &str,
) -> Result<T, ApiError> {
    tokio::time::timeout(SHARE_NET_TIMEOUT * 2, fut)
        .await
        .map_err(|_| ApiError::new(504, format!("{what} timed out")))?
        .map_err(fetch_error)
}

/// `GET /api/share/member_code` — this device's pasteable membership code.
async fn member_code(share: &ShareState) -> Result<Value, ApiError> {
    let node = live_node(share).await?;
    let code = e2ee_timeout(node.member_code(), "member code").await?;
    to_value(&MemberCode { code })
}

/// `POST /api/share/relay/reconnect` — rebind the p2p node against whatever
/// is currently saved under Settings → Sharing, without an app restart. Save
/// the relay settings first (`PATCH /api/settings`), then call this.
async fn reconnect_relay(
    spawn_sync: &(dyn Fn() + Sync),
    share: &ShareState,
) -> Result<Value, ApiError> {
    let p2p_dir = config::data_dir().join("p2p");
    match p2p_config::relay_setting() {
        RelaySetting::RequireCustomButMissing => {
            share.shutdown().await?;
            return Err(ApiError::new(
                400,
                "\"Only use this relay\" is on but no valid relay is configured; refusing to fall back to the public n0 relay",
            ));
        }
        setting => {
            let relay = match setting {
                RelaySetting::Custom(relay) => Some(relay),
                _ => None,
            };
            // Keychain access is sync (the Linux backend block_ons its own
            // runtime and panics on a tokio worker thread), so the DEK resolves
            // off the worker. Join failure degrades to no DEK, as an
            // unavailable keychain would.
            let dek = tokio::task::spawn_blocking(p2p_config::p2p_dek)
                .await
                .unwrap_or(None);
            share.rebind(&p2p_dir, dek, relay).await?;
        }
    }
    if share.mark_sync_started() {
        spawn_sync();
    }
    to_value(&linxiv_core::models::OkReceipt { ok: true })
}

/// `POST /api/share/project/{id}/publish_secure` — snapshot a canonical project
/// into an e2ee share (doc under `share_dir/e2ee`, beelay-registered), sharing
/// PDF blobs for papers with a local file, and seed the members sidecar with
/// this device as hoster.
async fn publish_secure(state: &AppState, share: &ShareState, id: &str) -> Result<Value, ApiError> {
    let project_id = path_i64(id)?;
    let mut sp = state.with_conn(|conn| build_shared_project(conn, project_id))?;
    let dir = share.share_dir().to_path_buf();
    if doc_path(&received_dir(&dir), &sp.share_id).is_file()
        || doc_path(&e2ee_received_dir(&dir), &sp.share_id).is_file()
    {
        return Err(ApiError::new(
            409,
            "project is linked to a received share; leave the share before publishing",
        ));
    }
    if doc_path(&dir, &sp.share_id).is_file() {
        return Err(ApiError::new(
            409,
            "project is published as a plain share; unpublish it before publishing encrypted",
        ));
    }
    let node = live_node(share).await?;
    let _lock = share.lock_writes(&sp.share_id).await;
    restore_unpublished(&e2ee_dir(&dir), &sp.share_id);
    if doc_path(&e2ee_dir(&dir), &sp.share_id).is_file() {
        // Republish: populate reads the doc's tickets before publish overwrites it.
        share_sync::populate_pdf_blobs(state, &node, &dir, &mut sp, false).await?;
        e2ee_timeout(node.publish_secure(&sp), "secure publish").await?;
    } else {
        // Brand-new share: the beelay project must exist before blob storage
        // can succeed. A populate failure after this point still errors the
        // request; the share exists and a retry recovers via the republish arm.
        e2ee_timeout(node.publish_secure(&sp), "secure publish").await?;
        share_sync::populate_pdf_blobs(state, &node, &dir, &mut sp, false).await?;
        if sp.papers.iter().any(|p| p.pdf_blob.is_some()) {
            e2ee_timeout(node.publish_secure(&sp), "secure publish").await?;
        }
    }
    let mut list = load_members(&dir, &sp.share_id);
    if !list.iter().any(|m| m.role == "hoster") {
        list.push(MemberEntry {
            member_id_hex: node
                .self_member_id()
                .map(|m| member_id_hex(&m))
                .unwrap_or_default(),
            name: None,
            role: "hoster".into(),
            invited_at: chrono::Utc::now().to_rfc3339(),
            revoked: false,
            invite: None,
        });
        if let Err(e) = save_members(&dir, &sp.share_id, &list) {
            eprintln!(
                "share {}: could not persist members sidecar: {e}",
                sp.share_id
            );
        }
    }
    // Seed the co-admin metadata riding the doc: THE-ADMIN marker (this
    // device) and the roster root (invited_by: None = the creator). Both
    // best-effort — a missing marker reads as "the hosting device is THE
    // ADMIN" anyway, and the next publish retries.
    if let Ok(self_hex) = node.self_member_id().map(|m| member_id_hex(&m)) {
        match e2ee_timeout(node.admin_marker(&sp.share_id), "admin lookup").await {
            Ok(None) => {
                if let Err(e) =
                    e2ee_timeout(node.set_admin_marker(&sp.share_id, &self_hex), "admin seed").await
                {
                    eprintln!("share {}: seeding admin marker: {}", sp.share_id, e.detail);
                }
            }
            Ok(Some(_)) => {}
            Err(e) => eprintln!("share {}: reading admin marker: {}", sp.share_id, e.detail),
        }
        let roster = fetch_roster(&node, &dir, &sp.share_id).await;
        if !roster.iter().any(|m| m.member_id == self_hex) {
            let meta = MemberMeta {
                member_id: self_hex,
                name: None,
                invited_at: chrono::Utc::now().to_rfc3339(),
                invited_by: None,
            };
            if let Err(e) =
                e2ee_timeout(node.upsert_member_meta(&sp.share_id, meta), "roster").await
            {
                eprintln!("share {}: seeding roster root: {}", sp.share_id, e.detail);
            }
        }
    }
    to_value(&PublishedReceipt {
        share_id: sp.share_id,
        e2ee: Some(true),
    })
}

/// `POST /api/share/{id}/invite {member_code, role: "editor"|"viewer", name?}`
/// — grant a device access to an e2ee share and mint its invite. Admin-tier
/// op from either side: a co-admin's invite points the invitee at the
/// co-admin's own address, and the grant reaches the host via the preamble.
async fn invite(
    state: &AppState,
    share: &ShareState,
    id: &str,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    let dir = share.share_dir().to_path_buf();
    let side = e2ee_side(&dir, id)?;
    let code = body
        .and_then(|b| b.get("member_code"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(422, "missing `member_code` in body"))?;
    if code.is_empty()
        || code.len() % 2 != 0
        || !code.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(ApiError::new(422, "`member_code` must be lowercase hex"));
    }
    let role_s = body
        .and_then(|b| b.get("role"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(422, "missing `role` in body"))?;
    let role = match role_s {
        "editor" => Role::Edit,
        "viewer" => Role::Read,
        "co-admin" | "admin" => {
            return Err(ApiError::new(
                422,
                "invite as \"editor\" or \"viewer\"; promote to co-admin after they join",
            ))
        }
        _ => return Err(ApiError::new(422, "role must be \"editor\" or \"viewer\"")),
    };
    let name = body
        .and_then(|b| b.get("name"))
        .and_then(Value::as_str)
        .map(String::from);
    let node = live_node(share).await?;
    // Standing checks run under the write lock (see set_member_role): a
    // concurrent transfer/demotion must not act on a stale snapshot.
    let _lock = share.lock_writes(id).await;
    // A concurrent unpublish/leave may have parked the doc before the lock.
    e2ee_side(&dir, id)?;
    let roster = fetch_roster(&node, &dir, id).await;
    let standing = admin_standing(&node, side, id, &roster).await?;
    standing.require_admin_tier()?;
    // A typed ShareError::RoleConflict surfaces as 409 via fetch_error.
    let (member, invite) = e2ee_timeout(node.invite_member(id, code, role), "invite").await?;
    // Keyhive accepted the grant, so a sidecar entry disagreeing on role is
    // stale — overwritten below, never a post-grant 409.
    let hex = member_id_hex(&member);
    let mut list = load_members(&dir, id);
    // Active if the local sidecar says so OR the synced roster carries them
    // (invited from another device): the compensating revoke below must never
    // strip access this request didn't create.
    let was_active = list.iter().any(|m| m.member_id_hex == hex && !m.revoked)
        || roster.iter().any(|m| m.member_id == hex);
    // Blobs stored before this grant are keyed to a pre-grant epoch: re-store and
    // republish under the post-grant one. The grant already happened, so a re-key
    // failure must not abort the invite — the interval hoster leg retries. Only
    // the hosting device holds the doc + PDFs; after a co-admin invite the
    // host's Re-key repairs blob epochs if the invitee's PDFs stay locked.
    if side == E2eeSide::Hosted {
        let mut sp = linxiv_share::load(&e2ee_dir(&dir), id).map_err(fetch_error)?;
        if sp.papers.iter().any(|p| p.pdf_blob.is_some()) {
            match share_sync::populate_pdf_blobs(state, &node, &dir, &mut sp, true).await {
                Ok(()) => e2ee_timeout(node.publish_secure(&sp), "secure publish").await?,
                Err(e) => eprintln!("share {id}: blob re-key after invite: {e}"),
            }
        }
    }
    if let Some(m) = list.iter_mut().find(|m| m.member_id_hex == hex) {
        m.role = role_s.into();
        // Blank name on a re-mint keeps the stored one.
        if name.is_some() {
            m.name = name;
        }
        m.revoked = false;
        m.invite = Some(invite.clone());
    } else {
        list.push(MemberEntry {
            member_id_hex: hex.clone(),
            name,
            role: role_s.into(),
            invited_at: chrono::Utc::now().to_rfc3339(),
            revoked: false,
            invite: Some(invite.clone()),
        });
    }
    if let Err(e) = save_members(&dir, id, &list) {
        if !was_active {
            // Undo the fresh grant the sidecar failed to record.
            let _ = e2ee_timeout(node.revoke(id, member), "revoke").await;
        }
        return Err(ApiError::new(
            500,
            format!("could not persist members sidecar: {e}"),
        ));
    }
    // Shared roster entry so other admin-tier devices can list + manage this
    // member; `invited_by` records the delegation lineage revocations need.
    // A re-invite preserves the existing entry's name fallback, timestamp,
    // and lineage — the upsert replaces the whole entry, and rewriting
    // `invited_by` would corrupt the chain `lineage_allows` checks.
    let prior = roster.iter().find(|m| m.member_id == hex);
    let meta = MemberMeta {
        member_id: hex.clone(),
        name: list
            .iter()
            .find(|m| m.member_id_hex == hex)
            .and_then(|m| m.name.clone())
            .or_else(|| prior.and_then(|p| p.name.clone())),
        invited_at: prior
            .map(|p| p.invited_at.clone())
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339()),
        invited_by: match prior {
            Some(p) => p.invited_by.clone(),
            None => Some(standing.self_hex.clone()),
        },
    };
    if let Err(e) = e2ee_timeout(node.upsert_member_meta(id, meta), "roster").await {
        eprintln!("share {id}: roster entry for {hex}: {}", e.detail);
    }
    push_membership_change(&node, side, id, "invite").await;
    to_value(&InviteMinted { invite })
}

/// `GET /api/share/{id}/members` — the roster (synced doc metadata ∪ the local
/// invite sidecar), each entry truth-checked with a live `query_role`.
///
/// Co-admin: management ops run on whichever admin-tier device issues them —
/// keyhive delegation and PCS rotation happen locally and propagate through
/// the session preamble — so this and the other member routes accept hosted
/// AND received e2ee shares. A hosted store-only state (no node; tests)
/// degrades to the sidecar-only legacy listing.
async fn members(share: &ShareState, id: &str) -> Result<Value, ApiError> {
    let dir = share.share_dir().to_path_buf();
    let side = e2ee_side(&dir, id)?;
    let sidecar = load_members(&dir, id);
    let Some(node) = share.node().await else {
        if side == E2eeSide::Received {
            return Err(ApiError::new(503, "share transport not initialized"));
        }
        let out = sidecar
            .into_iter()
            .map(|m| MemberRow {
                member_id: m.member_id_hex,
                name: m.name,
                // No marker readable without the node; the hosting device is
                // THE ADMIN on the legacy path.
                verified: m.role == "hoster",
                role: if m.role == "hoster" {
                    "admin".into()
                } else {
                    m.role
                },
                invited_at: m.invited_at,
                revoked: m.revoked,
                invite: if m.revoked { None } else { m.invite },
            })
            .collect();
        return to_value(&MembersListing {
            members: out,
            self_member_id: None,
            self_role: None,
        });
    };
    let roster = fetch_roster(&node, &dir, id).await;
    let standing = admin_standing(&node, side, id, &roster).await?;
    standing.require_admin_tier()?;

    // Union keyed by member id: roster (synced) first, then sidecar-only rows
    // (pre-roster invites). Local sidecar names win over synced ones.
    struct Entry {
        hex: String,
        name: Option<String>,
        invited_at: String,
        sidecar: Option<MemberEntry>,
        in_roster: bool,
    }
    let mut entries: Vec<Entry> = roster
        .iter()
        .map(|m| Entry {
            hex: m.member_id.clone(),
            name: m.name.clone(),
            invited_at: m.invited_at.clone(),
            sidecar: None,
            in_roster: true,
        })
        .collect();
    for s in sidecar {
        match entries.iter_mut().find(|e| e.hex == s.member_id_hex) {
            Some(e) => {
                if s.name.is_some() {
                    e.name = s.name.clone();
                }
                e.sidecar = Some(s);
            }
            None => entries.push(Entry {
                hex: s.member_id_hex.clone(),
                name: s.name.clone(),
                invited_at: s.invited_at.clone(),
                sidecar: Some(s),
                in_roster: false,
            }),
        }
    }
    if !entries.iter().any(|e| e.hex == standing.self_hex) {
        entries.push(Entry {
            hex: standing.self_hex.clone(),
            name: None,
            invited_at: String::new(),
            sidecar: None,
            in_roster: false,
        });
    }
    // Migration self-heal: hosted sidecar rows predating the synced roster get
    // written into it, so co-admins elsewhere see the full membership.
    if side == E2eeSide::Hosted {
        for e in entries.iter().filter(|e| !e.in_roster) {
            let is_self = e.hex == standing.self_hex;
            if e.sidecar.as_ref().is_some_and(|s| s.revoked) || e.hex.is_empty() {
                continue;
            }
            let meta = MemberMeta {
                member_id: e.hex.clone(),
                name: e.name.clone(),
                invited_at: e.invited_at.clone(),
                invited_by: (!is_self).then(|| standing.self_hex.clone()),
            };
            if let Err(err) = e2ee_timeout(node.upsert_member_meta(id, meta), "roster").await {
                eprintln!("share {id}: roster backfill for {}: {}", e.hex, err.detail);
            }
        }
    }

    // One concurrent truth-check per entry, so budgets don't stack
    // (entries × budget). `Some(role)` = answered; `None` = keep fallbacks.
    let checks = futures_util::future::join_all(entries.iter().map(|e| async {
        let mid = member_id_from_hex(&e.hex)?;
        e2ee_timeout(node.query_role(id, mid), "member query")
            .await
            .ok()
    }))
    .await;
    let mut out = Vec::new();
    for (e, check) in entries.into_iter().zip(checks) {
        let side_role = e.sidecar.as_ref().map(|s| s.role.clone());
        let mut revoked = e.sidecar.as_ref().is_some_and(|s| s.revoked);
        let mut verified = false;
        let mut role = match side_role.as_deref() {
            Some("hoster") => standing
                .label_for(Role::Admin, &e.hex)
                .expect("admin maps")
                .to_string(),
            Some(other) => other.to_string(),
            // Roster-only with no live answer below: least privilege, and
            // `verified: false` says the key layer hasn't confirmed it.
            None => "viewer".to_string(),
        };
        if let Some(live) = check {
            verified = true;
            match live.and_then(|r| standing.label_for(r, &e.hex)) {
                Some(label) => {
                    revoked = false;
                    role = label.to_string();
                }
                None => revoked = true,
            }
        }
        out.push(MemberRow {
            member_id: e.hex,
            name: e.name,
            role,
            invited_at: e.invited_at,
            revoked,
            verified,
            invite: if revoked {
                None
            } else {
                e.sidecar.and_then(|s| s.invite)
            },
        });
    }
    to_value(&MembersListing {
        members: out,
        self_member_id: Some(standing.self_hex.clone()),
        self_role: Some(standing.role_label()),
    })
}

/// Heartbeat freshness window: two interval passes, so one missed pass
/// doesn't flip a member offline.
fn presence_window() -> chrono::Duration {
    chrono::Duration::from_std(share_sync::INTERVAL_SYNC_PERIOD * 2).expect("small duration")
}

/// Online iff `last_seen` is inside the window in the past, or no further than
/// the skew grace in the future. `last_seen` is member-self-reported: symmetric
/// bounds mark a live member with a fast clock offline and mask their reading,
/// unbounded future ones never expire at all.
/// ponytail: fixed grace; a clock more than an hour ahead still reads offline.
fn presence_online(now: chrono::DateTime<chrono::Utc>, last_seen: &str) -> bool {
    let skew_grace = chrono::Duration::hours(1);
    chrono::DateTime::parse_from_rfc3339(last_seen).is_ok_and(|t| {
        let age = now - t.with_timezone(&chrono::Utc);
        age < presence_window() && age > -skew_grace
    })
}

async fn presence(share: &ShareState, id: &str) -> Result<Value, ApiError> {
    let dir = share.share_dir().to_path_buf();
    e2ee_side(&dir, id)?;
    let node = live_node(share).await?;
    let roster = fetch_roster(&node, &dir, id).await;
    let list = e2ee_timeout(node.presence(id), "presence").await?;
    let now = chrono::Utc::now();
    let members = list
        .into_iter()
        .map(|p| {
            let online = presence_online(now, &p.last_seen);
            PresenceRow {
                name: roster
                    .iter()
                    .find(|m| m.member_id == p.member_id)
                    .and_then(|m| m.name.clone()),
                member_id: p.member_id,
                last_seen: p.last_seen,
                online,
                reading: if online { p.reading } else { None },
            }
        })
        .collect();
    to_value(&PresenceListing {
        members,
        self_member_id: member_id_hex(&node.self_member_id().map_err(fetch_error)?),
    })
}

/// `POST /api/share/presence {reading}` — the opt-in "reading ..." indicator.
/// Written only into e2ee docs that contain the paper, so a read outside a
/// share never leaks into it; `null` clears it everywhere. Reaches others on
/// their next sync pass.
async fn set_reading(share: &ShareState, body: PresenceUpdate) -> Result<Value, ApiError> {
    let dir = share.share_dir().to_path_buf();
    let node = live_node(share).await?;
    let ids = share_sync::doc_ids(&e2ee_dir(&dir))
        .into_iter()
        .chain(share_sync::doc_ids(&e2ee_received_dir(&dir)));
    // The opt-in is enforced here, not in the UI. A member who has opted out
    // clears the indicator instead of publishing one, whatever the caller sent.
    let want = body.reading.filter(|_| share_sync::reading_opt_in());
    for id in ids {
        let reading = match &want {
            None => None,
            Some(sid) => {
                let has = e2ee_timeout(node.e2ee_paper_ids(&id), "presence")
                    .await
                    .is_ok_and(|papers| papers.iter().any(|p| p == sid));
                has.then(|| sid.clone())
            }
        };
        // Same lock the sync pass takes: unserialized, a boot clear parked
        // inside beelay lands after this write and wipes it, and the UI effect
        // never re-fires. ponytail: this POST can queue behind a whole pass.
        let _lock = share.lock_writes(&id).await;
        match e2ee_timeout(node.touch_presence(&id, Some(reading)), "presence").await {
            // Claim only on a landed write: a failed one must leave the boot
            // clear owed, or a stale reading stays pinned for the process life.
            Ok(()) => share_sync::commit_presence_pass(&id),
            // A failed write leaves the doc holding the PREVIOUS reading. Put
            // the boot clear back on the debt so the next heartbeat wipes it,
            // instead of pinning "reading X" for the life of the process.
            Err(e) => {
                share_sync::forget_presence_pass(&id);
                eprintln!("share {id}: presence reading: {}", e.detail);
            }
        }
    }
    to_value(&linxiv_core::models::OkReceipt { ok: true })
}

/// `POST /api/share/{id}/member/{mid}/role {role: "editor"|"viewer"|"co-admin"}`
/// — change a member's role on an e2ee share, from any admin-tier device. The
/// capability layer revokes + regrants (a downgrade rotates the project key),
/// so on the hosting device stored PDF blobs re-key + republish afterwards.
/// Admin-tier targets and the co-admin grant are THE ADMIN's alone; THE ADMIN
/// itself only changes role via `transfer_admin`.
async fn set_member_role(
    state: &AppState,
    share: &ShareState,
    id: &str,
    mid: &str,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    let dir = share.share_dir().to_path_buf();
    let side = e2ee_side(&dir, id)?;
    let role_s = body
        .and_then(|b| b.get("role"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(422, "missing `role` in body"))?;
    let role = match role_s {
        "editor" => Role::Edit,
        "viewer" => Role::Read,
        "co-admin" => Role::Admin,
        "admin" => {
            return Err(ApiError::new(
                409,
                "THE ADMIN role moves via POST /api/share/{id}/transfer_admin",
            ))
        }
        "hoster" | "relay" => {
            return Err(ApiError::new(
                422,
                "role must be \"editor\", \"viewer\" or \"co-admin\"",
            ))
        }
        _ => {
            return Err(ApiError::new(
                422,
                "role must be \"editor\", \"viewer\" or \"co-admin\"",
            ))
        }
    };
    let member =
        member_id_from_hex(mid).ok_or_else(|| ApiError::new(422, "malformed member id"))?;
    let canon_hex = member_id_hex(&member);
    let node = live_node(share).await?;
    // Standing and target checks all run under the write lock: a concurrent
    // local transfer_admin must not leave a just-demoted device acting on a
    // stale THE-ADMIN snapshot.
    let _lock = share.lock_writes(id).await;
    // A concurrent unpublish/leave may have parked the doc before the lock.
    e2ee_side(&dir, id)?;
    let roster = fetch_roster(&node, &dir, id).await;
    let standing = admin_standing(&node, side, id, &roster).await?;
    standing.require_admin_tier()?;
    if canon_hex == standing.self_hex {
        return Err(ApiError::new(409, "cannot change your own role"));
    }
    if standing.admin_hex.as_deref() == Some(canon_hex.as_str()) {
        return Err(ApiError::new(
            409,
            "cannot change THE ADMIN's role; transfer the admin role first",
        ));
    }
    if role == Role::Admin && !standing.the_admin {
        return Err(ApiError::new(
            403,
            "only THE ADMIN can promote a member to co-admin",
        ));
    }
    // Live truth under the lock: after a concurrent revoke, set_role on a
    // member with no delegation is a fresh grant, silently re-admitting them.
    let current = e2ee_timeout(node.query_role(id, member), "member query").await?;
    let Some(current) = current else {
        return Err(ApiError::new(404, "member not found on this share"));
    };
    if current == Role::Admin && !standing.the_admin {
        return Err(ApiError::new(403, "only THE ADMIN can demote a co-admin"));
    }
    if current == role {
        // Idempotent no-op: set_role would revoke + regrant (rotating the
        // project key) for no state change, and outside the caller's lineage
        // it would surface as a raw keyhive error instead of a clean 409.
        return to_value(&RoleChanged {
            member_id: canon_hex,
            role: role_s.into(),
        });
    }
    // set_role revokes + regrants, which keyhive only lets causal ancestors do.
    if !lineage_allows(&roster, side, &standing.self_hex, &canon_hex) {
        return Err(seniority_err());
    }
    // ShareError::LastReader surfaces as 409 via fetch_error.
    e2ee_timeout(node.set_role(id, member, role), "role change").await?;
    // A downgrade rotated the project key, so old-epoch blobs must re-key +
    // republish. The role change already happened, so a re-key failure must not
    // abort the request — the interval hoster leg retries (as in `invite`).
    // Only the hosting device holds the doc + PDFs; elsewhere the host's
    // interval leg (or its Re-key button) repairs blob epochs.
    if side == E2eeSide::Hosted {
        let mut sp = linxiv_share::load(&e2ee_dir(&dir), id).map_err(fetch_error)?;
        if sp.papers.iter().any(|p| p.pdf_blob.is_some()) {
            match share_sync::populate_pdf_blobs(state, &node, &dir, &mut sp, true).await {
                Ok(()) => e2ee_timeout(node.publish_secure(&sp), "secure publish").await?,
                Err(e) => eprintln!("share {id}: blob re-key after role change: {e}"),
            }
        }
    }
    let mut list = load_members(&dir, id);
    for m in list.iter_mut().filter(|m| m.member_id_hex == canon_hex) {
        m.role = role_s.into();
        // The regrant behind set_role invalidates the stored invite string.
        m.invite = None;
    }
    if let Err(e) = save_members(&dir, id, &list) {
        eprintln!("share {id}: could not persist members sidecar: {e}");
    }
    // Push the rotation to the host now (received side), so the revoke+regrant
    // and any key rotation don't sit local-only until the interval sync.
    if side == E2eeSide::Received {
        if let Err(e) = e2ee_timeout(node.sync_e2ee(id), "role-change sync").await {
            eprintln!("share {id}: pushing role change to host: {}", e.detail);
        }
    }
    to_value(&RoleChanged {
        member_id: canon_hex,
        role: role_s.into(),
    })
}

/// Shared admission for revoke/remove: parse the target, resolve standing, and
/// run the co-admin role matrix (self/THE-ADMIN/tier/seniority checks).
async fn revocation_checks(
    node: &ShareNode,
    side: E2eeSide,
    id: &str,
    hex: &str,
) -> Result<
    (
        linxiv_share::MemberId,
        String,
        Vec<MemberMeta>,
        Option<Role>,
    ),
    ApiError,
> {
    let mid = member_id_from_hex(hex).ok_or_else(|| ApiError::new(422, "malformed member id"))?;
    let canon_hex = member_id_hex(&mid);
    let roster = e2ee_timeout(node.member_meta(id), "roster")
        .await
        .unwrap_or_default();
    let standing = admin_standing(node, side, id, &roster).await?;
    standing.require_admin_tier()?;
    if canon_hex == standing.self_hex {
        return Err(ApiError::new(409, "cannot revoke yourself"));
    }
    if standing.admin_hex.as_deref() == Some(canon_hex.as_str()) {
        return Err(ApiError::new(
            409,
            "cannot revoke THE ADMIN; transfer the admin role first",
        ));
    }
    let target_role = e2ee_timeout(node.query_role(id, mid), "member query").await?;
    if target_role == Some(Role::Admin) && !standing.the_admin {
        return Err(ApiError::new(403, "only THE ADMIN can revoke a co-admin"));
    }
    if target_role.is_some() && !lineage_allows(&roster, side, &standing.self_hex, &canon_hex) {
        return Err(seniority_err());
    }
    Ok((mid, canon_hex, roster, target_role))
}

/// Push a received-side membership change (and its PCS rotation) to the host
/// now instead of waiting for the interval sync. Best-effort.
async fn push_membership_change(node: &ShareNode, side: E2eeSide, id: &str, what: &str) {
    if side == E2eeSide::Received {
        if let Err(e) = e2ee_timeout(node.sync_e2ee(id), what).await {
            eprintln!("share {id}: pushing {what} to host: {}", e.detail);
        }
    }
}

/// `POST /api/share/{id}/revoke {member_id}` — revoke a member (the project key
/// rotates), mark the sidecar entry, and drop them from the synced roster.
/// Admin-tier op, from the hosting device or a co-admin's.
async fn revoke_member(
    share: &ShareState,
    id: &str,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    let dir = share.share_dir().to_path_buf();
    let side = e2ee_side(&dir, id)?;
    let hex = body
        .and_then(|b| b.get("member_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(422, "missing `member_id` in body"))?;
    let node = live_node(share).await?;
    let _lock = share.lock_writes(id).await;
    // A concurrent unpublish may have parked the doc before the lock.
    e2ee_side(&dir, id)?;
    // The whole matrix runs under the write lock: a concurrent promotion or
    // admin transfer must not let a stale snapshot revoke an admin-tier
    // member (same window set_member_role re-checks under its lock).
    let (mid, canon_hex, _, target_role) = revocation_checks(&node, side, id, hex).await?;
    // query_role == None: keyhive already dropped them (a concurrent revoke
    // elsewhere); skip the revoke and just mark the rows, like remove_member.
    if target_role.is_some() {
        e2ee_timeout(node.revoke(id, mid), "revoke").await?;
    }
    let mut list = load_members(&dir, id);
    for m in list.iter_mut().filter(|m| m.member_id_hex == canon_hex) {
        m.revoked = true;
        m.invite = None;
    }
    if let Err(e) = save_members(&dir, id, &list) {
        eprintln!("share {id}: could not persist members sidecar: {e}");
    }
    if let Err(e) = e2ee_timeout(node.remove_member_meta(id, &canon_hex), "roster").await {
        eprintln!("share {id}: roster removal for {canon_hex}: {}", e.detail);
    }
    // Refresh the mirror so live_member_count stops counting them now, not
    // on the next members fetch.
    fetch_roster(&node, &dir, id).await;
    push_membership_change(&node, side, id, "revoke").await;
    to_value(&RevokedReceipt { revoked: true })
}

/// `POST /api/share/{id}/transfer_admin {member_id}` — hand THE ADMIN role to
/// a co-admin. One marker write in the doc: an automerge LWW register, so two
/// concurrent transfers still converge to exactly one THE ADMIN. The old admin
/// keeps keyhive Admin and is a co-admin from here on — powers travel with the
/// marker, hosting stays where it is.
async fn transfer_admin(
    share: &ShareState,
    id: &str,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    let dir = share.share_dir().to_path_buf();
    let side = e2ee_side(&dir, id)?;
    let hex = body
        .and_then(|b| b.get("member_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(422, "missing `member_id` in body"))?;
    let mid = member_id_from_hex(hex).ok_or_else(|| ApiError::new(422, "malformed `member_id`"))?;
    let canon_hex = member_id_hex(&mid);
    let node = live_node(share).await?;
    // Checked under the write lock, symmetric with revoke_member: a revoke
    // landing between check and marker write would crown a revoked member and
    // strand the admin tier.
    let _lock = share.lock_writes(id).await;
    e2ee_side(&dir, id)?;
    let roster = fetch_roster(&node, &dir, id).await;
    let standing = admin_standing(&node, side, id, &roster).await?;
    // Excluding self keeps THE ADMIN naming itself on the 409 below instead
    // of a pointless full re-seal through the idempotent branch.
    if standing.admin_hex.as_deref() == Some(canon_hex.as_str()) && canon_hex != standing.self_hex {
        // A prior transfer already moved the marker (its flush may have
        // failed): re-flush and report success — true idempotence. Admin-tier
        // only, so non-admins can't probe the marker through this route.
        standing.require_admin_tier()?;
        flush_admin_marker(&node, side, id).await?;
        return to_value(&AdminTransferred {
            transferred: true,
            admin: canon_hex,
        });
    }
    if !standing.the_admin {
        return Err(ApiError::new(403, "only THE ADMIN can transfer the role"));
    }
    if canon_hex == standing.self_hex {
        return Err(ApiError::new(
            409,
            "this device already holds THE ADMIN role",
        ));
    }
    if e2ee_timeout(node.query_role(id, mid), "member query").await? != Some(Role::Admin) {
        return Err(ApiError::new(
            409,
            "the transfer target must be a co-admin; promote them first",
        ));
    }
    e2ee_timeout(node.set_admin_marker(id, &canon_hex), "admin transfer").await?;
    // A flush failure here leaves the transfer effective in memory; the retry
    // takes the marker-already-moved branch above and re-flushes.
    flush_admin_marker(&node, side, id).await?;
    to_value(&AdminTransferred {
        transferred: true,
        admin: canon_hex,
    })
}

/// Make a moved admin marker durable + visible now, not on the next interval
/// pass: member side pushes a sync; the hosting side has no dial target, so
/// it re-seals (the one exposed op that flushes a hosted doc).
async fn flush_admin_marker(node: &ShareNode, side: E2eeSide, id: &str) -> Result<(), ApiError> {
    match side {
        E2eeSide::Received => e2ee_timeout(node.sync_e2ee(id), "admin transfer")
            .await
            .map(|_| ())?,
        E2eeSide::Hosted => e2ee_timeout(node.rekey_e2ee(id), "admin transfer").await?,
    }
    Ok(())
}

/// `POST /api/share/{id}/rekey` — re-encrypt a hosted e2ee share's history
/// under the current epoch, then republish it (and re-key its PDF blobs) so
/// every current member can read everything.
///
/// Invites re-seal on their own; this repairs shares sealed before a member was
/// invited, which leaves them fetching commits they hold no key for
/// (keyhive #136) with no way out but this.
async fn rekey(state: &AppState, share: &ShareState, id: &str) -> Result<Value, ApiError> {
    let dir = share.share_dir().to_path_buf();
    ensure_e2ee_hosted(&dir, id)?;
    let node = live_node(share).await?;
    let _lock = share.lock_writes(id).await;
    ensure_e2ee_hosted(&dir, id)?;
    e2ee_timeout(node.rekey_e2ee(id), "re-key").await?;
    // Blobs are sealed per epoch too, so a doc-only re-key would leave every
    // shared PDF unreadable to the same members.
    let mut sp = linxiv_share::load(&e2ee_dir(&dir), id).map_err(fetch_error)?;
    if sp.papers.iter().any(|p| p.pdf_blob.is_some()) {
        share_sync::populate_pdf_blobs(state, &node, &dir, &mut sp, true)
            .await
            .map_err(fetch_error)?;
    }
    e2ee_timeout(node.publish_secure(&sp), "secure publish").await?;
    println!(
        "share {id}: re-keyed and republished papers={} members={}",
        sp.papers.len(),
        live_member_count(&dir, id),
    );
    to_value(&RekeyedReceipt {
        rekeyed: true,
        members: live_member_count(&dir, id),
    })
}

/// `POST /api/share/{id}/member/{mid}/remove` — revoke, then drop the sidecar
/// row and roster entry entirely, so a re-invite of the same device starts
/// clean (a revoked row keeps its stale role and dead invite string). Revoking
/// is what withdraws the capability; the rows are bookkeeping. Already-revoked
/// members skip to the row delete. Same admin-tier matrix as `revoke_member`.
async fn remove_member(share: &ShareState, id: &str, mid: &str) -> Result<Value, ApiError> {
    let dir = share.share_dir().to_path_buf();
    let side = e2ee_side(&dir, id)?;
    let node = live_node(share).await?;
    let _lock = share.lock_writes(id).await;
    e2ee_side(&dir, id)?;
    // Under the write lock, like revoke_member: the tier/seniority matrix
    // must see any concurrent promotion, not a pre-lock snapshot.
    let (member, canon_hex, roster, target_role) = revocation_checks(&node, side, id, mid).await?;
    let known = load_members(&dir, id)
        .iter()
        .any(|m| m.member_id_hex == canon_hex)
        || roster.iter().any(|m| m.member_id == canon_hex)
        || target_role.is_some();
    if !known {
        return Err(ApiError::new(404, "member not found on this share"));
    }
    // target_role == None: keyhive already dropped them; just clear the rows.
    // (Queried by revocation_checks under this same lock.)
    if target_role.is_some() {
        e2ee_timeout(node.revoke(id, member), "revoke").await?;
    }
    let mut list = load_members(&dir, id);
    list.retain(|m| m.member_id_hex != canon_hex);
    save_members(&dir, id, &list)
        .map_err(|e| ApiError::new(500, format!("could not persist members sidecar: {e}")))?;
    if let Err(e) = e2ee_timeout(node.remove_member_meta(id, &canon_hex), "roster").await {
        eprintln!("share {id}: roster removal for {canon_hex}: {}", e.detail);
    }
    // Refresh the mirror so live_member_count stops counting them now.
    fetch_roster(&node, &dir, id).await;
    push_membership_change(&node, side, id, "remove").await;
    to_value(&RemovedReceipt {
        removed: true,
        member_id: canon_hex,
    })
}

/// `POST /api/share/{id}/pdf {source_id}` — fetch + decrypt a received e2ee
/// share's PDF blob and save it to the managed PDF dir, under the same
/// `pdf_save_limit_mb` total-storage cap the downloader/import paths enforce.
async fn shared_pdf(
    state: &AppState,
    share: &ShareState,
    id: &str,
    body: Option<&Value>,
) -> Result<Value, ApiError> {
    let source_id = body
        .and_then(|b| b.get("source_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::new(422, "missing `source_id` in body"))?
        .to_string();
    let sp = ShareNode::e2ee_received(share.share_dir(), id)?;
    let paper = sp
        .papers
        .iter()
        .find(|p| p.source_id == source_id)
        .ok_or_else(|| ApiError::new(404, format!("paper {source_id:?} not in share")))?;
    let ticket = paper
        .pdf_blob
        .clone()
        .ok_or_else(|| ApiError::new(404, "no PDF shared for this paper"))?;
    let version = paper.version;
    let pdf_dir = state.pdf_dir.clone();
    let dest = pdf_dir.join(pdf_on_disk_name(&source_id, version));
    // The paper row only exists once the share has been imported; the
    // crash-recovery re-register below needs it too.
    let row_exists = state
        .with_conn(|c| {
            paper_svc::get(
                c,
                &paper_svc::PaperRef::Source {
                    source_id: source_id.clone(),
                    version: Some(version),
                },
            )
        })?
        .is_some();
    if !row_exists {
        return Err(ApiError::new(
            409,
            "import the share before downloading PDFs",
        ));
    }
    if dest.is_file() {
        let path = dest.to_string_lossy().into_owned();
        // Re-registers a file left by a crash between rename and mark.
        state.with_conn(|c| paper_svc::mark_pdf_saved(c, &source_id, &path, version))?;
        return to_value(&SharedPdfSaved {
            source_id,
            version,
            path,
        });
    }
    let node = live_node(share).await?;
    // Remaining pdf quota caps the transport fetch (413 past it).
    let max = config::UserSettings::load()?.pdf_save_limit_bytes();
    let remaining = max.saturating_sub(linxiv_core::service::files::pdf_storage_bytes(&pdf_dir));
    let bytes = tokio::time::timeout(
        SHARE_NET_TIMEOUT * 2,
        node.read_pdf_blob(id, &ticket, remaining),
    )
    .await
    .map_err(|_| ApiError::new(504, "shared PDF fetch timed out"))??;
    let _lock = share.lock_writes(id).await;
    let mut wrote = false;
    if !dest.is_file() {
        paper_import::check_pdf_storage_quota(&pdf_dir, bytes.len(), max)?;
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(&pdf_dir)?;
            let tmp = dest.with_extension(format!("pdf.{id}.tmp"));
            std::fs::write(&tmp, &bytes)?;
            std::fs::rename(&tmp, &dest)
        };
        write().map_err(|e| ApiError::new(500, format!("could not save shared PDF: {e}")))?;
        linxiv_core::service::files::note_pdf_written(&dest, bytes.len() as u64);
        wrote = true;
    }
    let path = dest.to_string_lossy().into_owned();
    if let Err(e) = state.with_conn(|c| paper_svc::mark_pdf_saved(c, &source_id, &path, version)) {
        // Only clean up a file this request wrote, not one a concurrent request saved.
        if wrote {
            linxiv_core::service::files::remove_pdf_counted(&dest);
        }
        return Err(ApiError::new(500, e.to_string()));
    }
    to_value(&SharedPdfSaved {
        source_id,
        version,
        path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    use chrono::NaiveDate;
    use linxiv_core::models::{PaperIn, ProjectIn};

    /// A fast clock stays online (its reading would otherwise be masked), a far
    /// future one does not (it would never expire), and the past window holds.
    #[test]
    fn presence_online_tolerates_clock_skew_but_not_forever() {
        let now = chrono::Utc::now();
        let at = |d: chrono::Duration| (now + d).to_rfc3339();
        assert!(presence_online(now, &at(chrono::Duration::minutes(15))));
        assert!(!presence_online(now, &at(chrono::Duration::hours(2))));
        assert!(presence_online(now, &at(-chrono::Duration::minutes(7))));
        assert!(!presence_online(now, &at(-chrono::Duration::minutes(30))));
        assert!(!presence_online(now, "not a timestamp"));
    }

    /// Presence POSTs fire on every paper open/close: they must not drive a
    /// sync pass. Every other share mutation still does.
    #[test]
    fn presence_post_does_not_nudge_sync() {
        assert!(!nudges_sync("POST", "/api/share/presence"));
        assert!(!nudges_sync("POST", "api/share/presence/"));
        assert!(!nudges_sync("GET", "/api/share/abc/presence"));
        assert!(nudges_sync("POST", "/api/share/join"));
        assert!(nudges_sync("POST", "/api/share/abc/sync"));
        assert!(nudges_sync("POST", "/api/share/received/abc/import"));
    }
    use linxiv_core::service::{
        annotation as annotation_svc, note as note_svc, paper as paper_svc,
    };
    use linxiv_core::storage;

    // Seed a canonical in-memory DB via the real service WRITE APIs. Returns
    // (AppState, project_id).
    fn seeded_state() -> (AppState, i64) {
        let mut conn = storage::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();

        let pin = |sid: &str, title: &str, authors: &[&str], tags: &[&str]| PaperIn {
            title: title.into(),
            published: NaiveDate::from_ymd_opt(2024, 1, 1).unwrap(),
            source_id: Some(sid.into()),
            version: None,
            authors: Some(authors.iter().map(|s| s.to_string()).collect()),
            summary: Some(format!("summary of {title}")),
            category: Some("cs.LG".into()),
            doi: None,
            url: None,
            tags: Some(tags.iter().map(|s| s.to_string()).collect()),
            source: Some("arxiv".into()),
        };
        paper_svc::upsert(
            &mut conn,
            &pin("arxiv:1", "First", &["Alice"], &["ml"]),
            None,
        )
        .unwrap();
        paper_svc::upsert(
            &mut conn,
            &pin("arxiv:2", "Second", &["Bob"], &["cv"]),
            None,
        )
        .unwrap();
        let fk1 = paper_svc::ensure_paper_root(&mut conn, "arxiv:1").unwrap();
        let fk2 = paper_svc::ensure_paper_root(&mut conn, "arxiv:2").unwrap();

        let project_id = project_svc::create(
            &mut conn,
            &ProjectIn {
                name: "My Project".into(),
                description: "a project".into(),
                color: Some(0x00ff00),
                tags: vec!["RL".into(), "Robotics".into()],
                source_fks: vec![fk1, fk2],
            },
        )
        .unwrap();

        let state = AppState::from_parts(conn, std::env::temp_dir(), std::env::temp_dir());
        (state, project_id)
    }

    fn dispatch(
        state: &AppState,
        share: &ShareState,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, ApiError> {
        let segs = split_segments(path);
        let query: HashMap<String, String> = HashMap::new();
        let s: Vec<&str> = segs.iter().map(String::as_str).collect();
        let ctx = ReqCtx {
            method,
            segs: &s,
            query: &query,
            body,
        };
        handle(state, share, &ctx).expect("share arm matched")
    }

    /// Wire-shape pin: optional tail keys keep legacy order and vanish when unset.
    #[test]
    fn summary_row_wire_shape() {
        let hosted = SummaryRow {
            share_id: "s-1".into(),
            name: "P".into(),
            description: Some("d".into()),
            paper_count: 2,
            note_count: 1,
            tag_count: 3,
            synced_at: None,
            paused: false,
            project_fk: Some(7),
            e2ee: Some(true),
            member_count: Some(1),
            pending: None,
            role: None,
        };
        assert_eq!(
            serde_json::to_string(&hosted).unwrap(),
            r#"{"share_id":"s-1","name":"P","description":"d","paper_count":2,"note_count":1,"tag_count":3,"synced_at":null,"paused":false,"project_fk":7,"e2ee":true,"member_count":1}"#
        );
        let pending = SummaryRow {
            share_id: "s-2".into(),
            name: String::new(),
            description: None,
            paper_count: 0,
            note_count: 0,
            tag_count: 0,
            synced_at: None,
            paused: true,
            project_fk: None,
            e2ee: Some(true),
            member_count: None,
            pending: Some(true),
            role: Some("viewer"),
        };
        assert_eq!(
            serde_json::to_string(&pending).unwrap(),
            r#"{"share_id":"s-2","name":"","paper_count":0,"note_count":0,"tag_count":0,"synced_at":null,"paused":true,"project_fk":null,"e2ee":true,"pending":true,"role":"viewer"}"#
        );
    }

    #[tokio::test]
    async fn list_publish_list_envelopes() {
        let (state, pid) = seeded_state();
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());

        // Empty before any publish.
        assert_eq!(
            dispatch(&state, &share, "GET", "/api/share/projects", None).unwrap(),
            json!({ "shared_projects": [] })
        );

        // Publish (async arm; nodeless state skips the registry refresh) returns
        // the persisted uuid share_id.
        let resp = publish(&state, &share, &pid.to_string()).await.unwrap();
        let share_id = resp["share_id"].as_str().unwrap().to_string();
        assert_eq!(share_id.len(), 36, "uuid v4 share_id");

        // The summary now lists the published project with sync status fields.
        let listed = dispatch(&state, &share, "GET", "/api/share/projects", None).unwrap();
        let entry = &listed["shared_projects"][0];
        assert_eq!(entry["share_id"], json!(share_id));
        assert_eq!(entry["name"], json!("My Project"));
        assert_eq!(entry["paper_count"], json!(2));
        assert_eq!(entry["note_count"], json!(0));
        assert_eq!(entry["tag_count"], json!(2));
        assert_eq!(entry["paused"], json!(false));
        assert!(
            entry["synced_at"].as_str().is_some(),
            "doc mtime as ISO8601"
        );
        assert!(
            entry.get("project_fk").is_some(),
            "project_fk field present"
        );
    }

    #[tokio::test]
    async fn publish_missing_project_is_404() {
        let (state, _pid) = seeded_state();
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());

        let err = publish(&state, &share, "9999").await.unwrap_err();
        assert_eq!(err.status, 404);
    }

    /// A placeholder mirror from an offline join holds an empty doc that never
    /// hydrates; it must still list, flagged pending, or the join is invisible.
    #[test]
    fn pending_mirror_is_listed() {
        let (state, _pid) = seeded_state();
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());
        let id = "11111111-2222-4333-8444-555555555555";
        let rec = e2ee_received_dir(dir.path());
        std::fs::create_dir_all(&rec).unwrap();
        std::fs::write(doc_path(&rec, id), automerge::AutoCommit::new().save()).unwrap();

        let listed = list_received(&state, &share).unwrap();
        let entries = listed["received"].as_array().unwrap();
        assert_eq!(entries.len(), 1, "pending mirror must surface");
        assert_eq!(entries[0]["share_id"], json!(id));
        assert_eq!(entries[0]["pending"], json!(true));
        assert_eq!(entries[0]["synced_at"], Value::Null);
    }

    // Needs one bound endpoint for its own loopback addr; relays/discovery are off
    // (bind_offline), so it never contacts an external host. Gated like the
    // crate's network tests: multi-thread runtime, no n0 relay.
    #[tokio::test(flavor = "multi_thread")]
    async fn ticket_route_mints_parseable_ticket() {
        let (state, pid) = seeded_state();
        let dir = tempfile::tempdir().unwrap();
        let node = ShareNode::bind_offline(dir.path(), &dir.path().join("p2p"))
            .await
            .unwrap();
        let share = ShareState::with_node(dir.path(), node);

        let resp = ticket(&state, &share, &pid.to_string()).await.unwrap();
        let encoded = resp.get("ticket").and_then(Value::as_str).unwrap();
        // The minted ticket round-trips through the pasteable encoding.
        let parsed: ShareTicket = encoded.parse().unwrap();
        assert_eq!(parsed.to_string(), encoded);

        share.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn join_rejects_bad_ticket_with_400() {
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());

        let body = json!({ "ticket": "not-a-valid-ticket" });
        let err = join(&share, Some(&body)).await.unwrap_err();
        assert_eq!(err.status, 400);
    }

    // ── W3: import / sync / settings / leave / unpublish ────────────────────

    const ANCHOR: &str = r##"{"v":1,"version":1,"page":1,"color":"#ffd400","quote":"q","rects":[{"x":0,"y":0,"w":0.5,"h":0.1}]}"##;

    const SID: &str = "33333333-3333-4333-8333-333333333333";

    fn empty_state() -> AppState {
        let conn = storage::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        AppState::from_parts(conn, std::env::temp_dir(), std::env::temp_dir())
    }

    // A remote doc as a reader would have mirrored it after join.
    fn remote_shared(share_id: &str, note_body: &str) -> linxiv_share::SharedProject {
        linxiv_share::SharedProject {
            share_id: share_id.into(),
            name: "Shared P".into(),
            description: "from remote".into(),
            color: Some(0x123456),
            tags: vec!["RL".into()],
            papers: vec![linxiv_share::SharedPaper {
                source_id: "arxiv:9".into(),
                version: 1,
                published: None,
                title: "Remote Paper".into(),
                summary: "s".into(),
                authors: vec!["Zed".into()],
                tags: vec!["remote-tag".into()],
                pdf_blob: None,
                author_orcids: vec![],
            }],
            notes: vec![linxiv_share::SharedNote {
                uuid: "11111111-1111-4111-8111-111111111111".into(),
                paper_source_id: Some("arxiv:9".into()),
                title: "remote note".into(),
                body: note_body.into(),
                created_at: None,
                updated_at: None,
            }],
            annotations: vec![linxiv_share::SharedAnnotation {
                uuid: "22222222-2222-4222-8222-222222222222".into(),
                paper_source_id: "arxiv:9".into(),
                anchor: ANCHOR.into(),
                comment: "remote highlight".into(),
                created_at: None,
                updated_at: None,
            }],
        }
    }

    #[test]
    fn import_creates_project_papers_notes_tags_canonically() {
        let state = empty_state();
        let dir = tempfile::tempdir().unwrap();
        save(
            &received_dir(dir.path()),
            &remote_shared(SID, "remote body"),
        )
        .unwrap();

        let fk = share_sync::import_received(&state, dir.path(), SID).unwrap();

        state.with_conn(|c| {
            assert_eq!(project_svc::find_by_share_id(c, SID).unwrap(), Some(fk));
            let p = project_svc::get(
                c,
                &project_svc::Project {
                    project_fk: Some(fk),
                },
            )
            .unwrap()
            .unwrap();
            assert_eq!(p.name, "Shared P");
            assert_eq!(p.project_tags, vec!["RL".to_string()]);
            assert_eq!(p.source_fks.len(), 1, "paper linked to project");

            let paper = paper_svc::get(c, &paper_svc::PaperRef::source("arxiv:9".into()))
                .unwrap()
                .expect("paper row created");
            assert_eq!(paper.title, "Remote Paper");
            assert_eq!(paper.tags, vec!["remote-tag".to_string()]);

            let notes = note_svc::get_many(
                c,
                &note_svc::Notes {
                    project_fk: Some(fk),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].content, "remote body");

            let anns = annotation_svc::get_many(
                c,
                &annotation_svc::Annotations {
                    project_fk: Some(fk),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(anns.len(), 1);
            assert_eq!(anns[0].comment, "remote highlight");
        });
    }

    #[test]
    fn reimport_updates_changed_note_without_duplicating() {
        let state = empty_state();
        let dir = tempfile::tempdir().unwrap();
        let rec = received_dir(dir.path());
        save(&rec, &remote_shared(SID, "v1 body")).unwrap();
        let fk = share_sync::import_received(&state, dir.path(), SID).unwrap();

        // Remote edit arrives: same uuid, new body.
        save(&rec, &remote_shared(SID, "v2 body")).unwrap();
        let fk2 = share_sync::import_received(&state, dir.path(), SID).unwrap();
        assert_eq!(fk, fk2, "re-import links the same project");

        state.with_conn(|c| {
            let notes = note_svc::get_many(
                c,
                &note_svc::Notes {
                    project_fk: Some(fk),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(notes.len(), 1, "matched by uuid, not duplicated");
            assert_eq!(notes[0].content, "v2 body");
            let p = project_svc::get(
                c,
                &project_svc::Project {
                    project_fk: Some(fk),
                },
            )
            .unwrap()
            .unwrap();
            assert_eq!(p.source_fks.len(), 1, "paper not re-linked twice");
        });
    }

    #[tokio::test]
    async fn unlink_clears_link_keeps_project_and_mirror() {
        let state = empty_state();
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());
        save(&received_dir(dir.path()), &remote_shared(SID, "b")).unwrap();
        let fk = share_sync::import_received(&state, dir.path(), SID).unwrap();

        let v = unlink(&state, &share, SID).await.unwrap();

        assert_eq!(v["unlinked"], json!(true));
        state.with_conn(|c| {
            assert_eq!(project_svc::find_by_share_id(c, SID).unwrap(), None);
            // The project itself survives the unlink.
            assert!(project_svc::get(
                c,
                &project_svc::Project {
                    project_fk: Some(fk)
                },
            )
            .unwrap()
            .is_some());
        });
        assert!(doc_path(&received_dir(dir.path()), SID).exists());
        // Idempotent: a second unlink reports no link; unknown id → 404.
        let v = unlink(&state, &share, SID).await.unwrap();
        assert_eq!(v["unlinked"], json!(false));
        assert_eq!(
            unlink(&state, &share, "44444444-4444-4444-8444-444444444444")
                .await
                .unwrap_err()
                .status,
            404
        );
    }

    #[tokio::test]
    async fn unlink_refuses_hoster_share() {
        // A hosted doc lives at the share-dir root, not under received/ —
        // unlink must 404 and leave the publish-identity link intact.
        let mut conn = storage::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        let fk = project_svc::create(
            &mut conn,
            &linxiv_core::models::ProjectIn {
                name: "Hosted".into(),
                description: String::new(),
                color: None,
                tags: vec![],
                source_fks: vec![],
            },
        )
        .unwrap();
        project_svc::adopt_share_id(&conn, fk, SID).unwrap();
        let state = AppState::from_parts(conn, std::env::temp_dir(), std::env::temp_dir());
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());
        save(dir.path(), &remote_shared(SID, "b")).unwrap();

        assert_eq!(unlink(&state, &share, SID).await.unwrap_err().status, 404);
        state.with_conn(|c| {
            assert_eq!(project_svc::find_by_share_id(c, SID).unwrap(), Some(fk));
        });
    }

    #[tokio::test]
    async fn leave_removes_mirror_ticket_and_settings() {
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());
        save(&received_dir(dir.path()), &remote_shared("s-1", "b")).unwrap();
        std::fs::write(share_sync::ticket_path(dir.path(), "s-1"), "tkt").unwrap();
        share_sync::save_settings(dir.path(), "s-1", &share_sync::ShareSettings::default())
            .unwrap();

        leave(&share, "s-1").await.unwrap();

        assert!(!doc_path(&received_dir(dir.path()), "s-1").exists());
        assert!(!share_sync::ticket_path(dir.path(), "s-1").exists());
        assert!(!share_sync::settings_path(dir.path(), "s-1").exists());
        // Second leave: mirror is gone → 404.
        assert_eq!(leave(&share, "s-1").await.unwrap_err().status, 404);
    }

    #[tokio::test]
    async fn settings_roundtrip_and_validation() {
        let state = empty_state();
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());
        save(&received_dir(dir.path()), &remote_shared("s-1", "b")).unwrap();

        // Defaults before any write.
        assert_eq!(
            dispatch(&state, &share, "GET", "/api/share/s-1/settings", None).unwrap(),
            json!({ "paused": false, "direction": "two_way" })
        );

        let body = json!({ "paused": true, "direction": "shared_to_local" });
        put_settings(&share, "s-1", Some(&body)).await.unwrap();
        assert_eq!(
            dispatch(&state, &share, "GET", "/api/share/s-1/settings", None).unwrap(),
            json!({ "paused": true, "direction": "shared_to_local" })
        );

        let bad = json!({ "direction": "upstream" });
        let err = put_settings(&share, "s-1", Some(&bad)).await.unwrap_err();
        assert_eq!(err.status, 422);
    }

    // Route-level revocation: unpublish parks the doc file, so a held ticket's
    // fetch is refused (existence-based access check) — offline loopback only.
    #[tokio::test(flavor = "multi_thread")]
    async fn unpublish_then_fetch_is_not_found() {
        let (state, pid) = seeded_state();
        let a_dir = tempfile::tempdir().unwrap();
        let node = ShareNode::bind_offline(a_dir.path(), &a_dir.path().join("p2p"))
            .await
            .unwrap();
        let share = ShareState::with_node(a_dir.path(), node);

        let resp = ticket(&state, &share, &pid.to_string()).await.unwrap();
        let parsed: ShareTicket = resp["ticket"].as_str().unwrap().parse().unwrap();
        let share_id = resp["share_id"].as_str().unwrap().to_string();

        let resp = unpublish(&share, &share_id).await.unwrap();
        assert_eq!(resp["unpublished"], json!(true));
        // Unpublishing twice is a 404 (doc already gone).
        assert_eq!(unpublish(&share, &share_id).await.unwrap_err().status, 404);

        let b_dir = tempfile::tempdir().unwrap();
        let b = ShareNode::bind_offline(b_dir.path(), &b_dir.path().join("p2p"))
            .await
            .unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            b.fetch(&parsed, b_dir.path()),
        )
        .await
        .expect("loopback fetch should not hang");
        assert!(
            matches!(result, Err(ShareError::NotFound(_))),
            "unpublished share must refuse fetch, got {result:?}"
        );

        b.shutdown().await.unwrap();
        share.shutdown().await.unwrap();
    }

    // ── W4: e2ee arms ────────────────────────────────────────────────────────

    // Keyhive/BeeKEM ops are slow in debug builds; generous per-op budget.
    async fn slow<T>(fut: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(60), fut)
            .await
            .expect("e2ee op should not hang on loopback")
    }

    #[test]
    fn members_sidecar_corruption_is_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_members(dir.path(), "s-1").is_empty());
        std::fs::create_dir_all(dir.path().join("members")).unwrap();
        std::fs::write(members_path(dir.path(), "s-1"), b"{ not json").unwrap();
        assert!(load_members(dir.path(), "s-1").is_empty());
    }

    #[tokio::test]
    async fn join_garbage_is_400_with_both_parse_errors() {
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());
        let err = join(&share, Some(&json!({ "ticket": "garbage" })))
            .await
            .unwrap_err();
        assert_eq!(err.status, 400);
        assert!(
            err.detail.contains("not a share ticket or invite"),
            "{}",
            err.detail
        );
    }

    // Role-route input validation, cheap (no node, store-only state).
    #[tokio::test]
    async fn set_member_role_validates_before_network() {
        let state = empty_state();
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());
        let viewer = json!({ "role": "viewer" });

        // Not an e2ee share on this device → 404.
        let err = set_member_role(&state, &share, SID, "ab", Some(&viewer))
            .await
            .unwrap_err();
        assert_eq!(err.status, 404);

        save(&e2ee_dir(dir.path()), &remote_shared(SID, "b")).unwrap();
        // THE ADMIN never moves through the role route — transfer only.
        let err = set_member_role(&state, &share, SID, "ab", Some(&json!({ "role": "admin" })))
            .await
            .unwrap_err();
        assert_eq!(err.status, 409);
        assert!(err.detail.contains("transfer_admin"), "{}", err.detail);
        // Unknown / unsupported role words → 422.
        for word in ["owner", "hoster", "relay"] {
            let err = set_member_role(&state, &share, SID, "ab", Some(&json!({ "role": word })))
                .await
                .unwrap_err();
            assert_eq!(err.status, 422, "role {word:?}");
        }
        // Malformed member id → 422.
        let err = set_member_role(&state, &share, SID, "zz", Some(&viewer))
            .await
            .unwrap_err();
        assert_eq!(err.status, 422);
        // Any real change (co-admin promotion included) needs the live key
        // layer — membership truth is keyhive, not the sidecar → 503 here.
        let hex = "aa".repeat(32);
        for role in ["viewer", "co-admin"] {
            let err = set_member_role(&state, &share, SID, &hex, Some(&json!({ "role": role })))
                .await
                .unwrap_err();
            assert_eq!(err.status, 503, "role {role:?}");
        }
        // Received-side e2ee docs take the same route (co-admin devices manage
        // members too): validation reaches the node requirement, not a 404.
        let dir2 = tempfile::tempdir().unwrap();
        let share2 = ShareState::new(dir2.path());
        save(&e2ee_received_dir(dir2.path()), &remote_shared(SID, "b")).unwrap();
        let err = set_member_role(&state, &share2, SID, &hex, Some(&viewer))
            .await
            .unwrap_err();
        assert_eq!(err.status, 503);
    }

    // Transfer-route input validation, cheap (no node, store-only state).
    #[tokio::test]
    async fn transfer_admin_validates_before_network() {
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());

        let body = json!({ "member_id": "aa".repeat(32) });
        // Not an e2ee share on this device → 404.
        let err = transfer_admin(&share, SID, Some(&body)).await.unwrap_err();
        assert_eq!(err.status, 404);

        save(&e2ee_dir(dir.path()), &remote_shared(SID, "b")).unwrap();
        // Missing / malformed member id → 422.
        let err = transfer_admin(&share, SID, Some(&json!({})))
            .await
            .unwrap_err();
        assert_eq!(err.status, 422);
        let err = transfer_admin(&share, SID, Some(&json!({ "member_id": "zz" })))
            .await
            .unwrap_err();
        assert_eq!(err.status, 422);
        // The marker lives in the live doc → 503 on a store-only state.
        let err = transfer_admin(&share, SID, Some(&body)).await.unwrap_err();
        assert_eq!(err.status, 503);
    }

    /// Wire pins: members-listing self fields vanish on the legacy path and
    /// append after `members`; the transfer receipt shape.
    #[test]
    fn members_listing_and_transfer_wire_shapes() {
        let legacy = MembersListing {
            members: vec![],
            self_member_id: None,
            self_role: None,
        };
        assert_eq!(serde_json::to_string(&legacy).unwrap(), r#"{"members":[]}"#);
        let live = MembersListing {
            members: vec![],
            self_member_id: Some("aa".into()),
            self_role: Some("co-admin"),
        };
        assert_eq!(
            serde_json::to_string(&live).unwrap(),
            r#"{"members":[],"self_member_id":"aa","self_role":"co-admin"}"#
        );
        let receipt = AdminTransferred {
            transferred: true,
            admin: "bb".into(),
        };
        assert_eq!(
            serde_json::to_string(&receipt).unwrap(),
            r#"{"transferred":true,"admin":"bb"}"#
        );
    }

    #[tokio::test]
    async fn shared_pdf_without_blob_is_404() {
        let state = empty_state();
        let dir = tempfile::tempdir().unwrap();
        let share = ShareState::new(dir.path());
        save(&e2ee_received_dir(dir.path()), &remote_shared(SID, "b")).unwrap();

        let body = json!({ "source_id": "arxiv:9" });
        let err = shared_pdf(&state, &share, SID, Some(&body))
            .await
            .unwrap_err();
        assert_eq!(err.status, 404);
        assert!(err.detail.contains("no PDF"), "{}", err.detail);

        let body = json!({ "source_id": "nope" });
        let err = shared_pdf(&state, &share, SID, Some(&body))
            .await
            .unwrap_err();
        assert_eq!(err.status, 404);
    }

    // Full e2ee arm flow over loopback: publish_secure (storing the PDF blob),
    // invite, join-by-invite through the shared join arm, members truth-check,
    // shared_pdf save on the reader, revoke.
    #[tokio::test(flavor = "multi_thread")]
    async fn e2ee_arms_roundtrip_over_loopback() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let a_pdf = tempfile::tempdir().unwrap();
        let b_pdf = tempfile::tempdir().unwrap();

        // A's canonical project: one paper whose managed PDF is on disk.
        let mut conn = storage::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        let pid = linxiv_share::import_shared_project(&mut conn, &remote_shared(SID, "b")).unwrap();
        let state_a = AppState::from_parts(conn, a_pdf.path().to_path_buf(), std::env::temp_dir());
        let pdf_bytes = b"%PDF-1.7 shared".to_vec();
        std::fs::write(
            a_pdf.path().join(pdf_on_disk_name("arxiv:9", 1)),
            &pdf_bytes,
        )
        .unwrap();
        let mut conn_b = storage::open_in_memory().unwrap();
        storage::init_db(&conn_b).unwrap();
        // B's row for the shared paper, as `join` + import would leave it, so the
        // download gate in `shared_pdf` finds it.
        linxiv_share::import_shared_project(&mut conn_b, &remote_shared(SID, "b")).unwrap();
        let state_b =
            AppState::from_parts(conn_b, b_pdf.path().to_path_buf(), std::env::temp_dir());

        let node_a = ShareNode::bind_offline(a_dir.path(), &a_dir.path().join("p2p"))
            .await
            .unwrap();
        let node_b = ShareNode::bind_offline(b_dir.path(), &b_dir.path().join("p2p"))
            .await
            .unwrap();
        let share_a = ShareState::with_node(a_dir.path(), node_a);
        let share_b = ShareState::with_node(b_dir.path(), node_b);

        // publish_secure: e2ee doc with the blob ticket + hoster sidecar entry.
        let resp = slow(publish_secure(&state_a, &share_a, &pid.to_string()))
            .await
            .unwrap();
        assert_eq!(resp["share_id"], json!(SID));
        assert_eq!(resp["e2ee"], json!(true));
        let doc = linxiv_share::load(&linxiv_share::e2ee_dir(a_dir.path()), SID).unwrap();
        assert!(doc.papers[0].pdf_blob.is_some(), "pdf blob ticket stored");
        let sidecar = load_members(a_dir.path(), SID);
        assert_eq!(sidecar.len(), 1);
        assert_eq!(sidecar[0].role, "hoster");

        // Summary carries the e2ee flag + member_count (invited members only,
        // hoster excluded).
        let listed = list_shared(&state_a, &share_a).unwrap();
        let entry = &listed["shared_projects"][0];
        assert_eq!(entry["e2ee"], json!(true));
        assert_eq!(entry["member_count"], json!(0));

        // Invite B as viewer using B's member code.
        let code = member_code(&share_b).await.unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string();
        let body = json!({ "member_code": code, "role": "viewer", "name": "Bee" });
        let inv = slow(invite(&state_a, &share_a, SID, Some(&body)))
            .await
            .unwrap()["invite"]
            .as_str()
            .unwrap()
            .to_string();

        // B pastes the invite into the SAME join arm the plain flow uses.
        let joined = slow(join(&share_b, Some(&json!({ "ticket": inv }))))
            .await
            .unwrap();
        assert_eq!(joined["share_id"], json!(SID));
        assert_eq!(joined["e2ee"], json!(true));

        // B's received listing annotates the live-checked role (spec §7).
        let listed = slow(list_received_with_role(&state_b, &share_b))
            .await
            .unwrap();
        let entry = &listed["received"][0];
        assert_eq!(entry["e2ee"], json!(true));
        assert_eq!(entry["role"], json!("viewer"));

        // members: hoster + live-checked viewer. The hoster device is THE
        // ADMIN (marker seeded at publish), so its row and self_role say so.
        let m = slow(members(&share_a, SID)).await.unwrap();
        assert_eq!(m["self_role"], json!("admin"));
        let list = m["members"].as_array().unwrap().clone();
        assert_eq!(list.len(), 2);
        let admin = list.iter().find(|m| m["role"] == json!("admin")).unwrap();
        assert_eq!(admin["member_id"], m["self_member_id"]);
        let viewer = list.iter().find(|m| m["role"] == json!("viewer")).unwrap();
        assert_eq!(viewer["name"], json!("Bee"));
        assert_eq!(viewer["revoked"], json!(false));
        let member_id = viewer["member_id"].as_str().unwrap().to_string();

        // §3.3 role route: promote the viewer to editor and back; the
        // sidecar reflects each change (query_role verified via members()).
        for target in ["editor", "viewer"] {
            let changed = slow(set_member_role(
                &state_a,
                &share_a,
                SID,
                &member_id,
                Some(&json!({ "role": target })),
            ))
            .await
            .unwrap();
            assert_eq!(changed["role"], json!(target));
            let m = slow(members(&share_a, SID)).await.unwrap();
            let bee = m["members"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["member_id"] == json!(member_id.clone()))
                .unwrap()
                .clone();
            assert_eq!(bee["role"], json!(target));
            assert_eq!(bee["revoked"], json!(false));
        }

        // B saves the shared PDF through the cap-checked path.
        let body = json!({ "source_id": "arxiv:9" });
        let saved = slow(shared_pdf(&state_b, &share_b, SID, Some(&body)))
            .await
            .unwrap();
        let path = saved["path"].as_str().unwrap();
        assert_eq!(std::fs::read(path).unwrap(), pdf_bytes);
        assert!(path.starts_with(b_pdf.path().to_str().unwrap()));

        // Revoke the viewer; the members list reports it.
        let body = json!({ "member_id": member_id });
        slow(revoke_member(&share_a, SID, Some(&body)))
            .await
            .unwrap();
        let m = slow(members(&share_a, SID)).await.unwrap();
        let viewer = m["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == json!("viewer"))
            .unwrap()
            .clone();
        assert_eq!(viewer["revoked"], json!(true));

        share_a.shutdown().await.unwrap();
        share_b.shutdown().await.unwrap();
    }

    // The co-admin role matrix end-to-end over loopback: promotion, a
    // co-admin device inviting a third member itself (keyhive delegation off
    // the hosting device — the distributed-admin core), the THE-ADMIN
    // transfer with its demote-to-co-admin semantics, a co-admin-side revoke
    // with local PCS rotation, and the seniority/tier refusals.
    // Three devices' worth of delegations + reseals make keyhive's event-graph
    // rebuild recurse past the default 2 MiB thread stacks in debug builds, so
    // the scenario gets its own runtime with roomier threads.
    #[test]
    fn co_admin_promote_transfer_and_manage_over_loopback() {
        std::thread::Builder::new()
            .stack_size(32 * 1024 * 1024)
            .spawn(|| {
                tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .thread_stack_size(16 * 1024 * 1024)
                    .build()
                    .unwrap()
                    .block_on(co_admin_scenario())
            })
            .unwrap()
            .join()
            .unwrap();
    }

    async fn co_admin_scenario() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let c_dir = tempfile::tempdir().unwrap();

        let mut conn = storage::open_in_memory().unwrap();
        storage::init_db(&conn).unwrap();
        let pid = linxiv_share::import_shared_project(&mut conn, &remote_shared(SID, "b")).unwrap();
        let state_a = AppState::from_parts(conn, std::env::temp_dir(), std::env::temp_dir());
        let state_b = empty_state();
        let state_c = empty_state();

        let share_a = ShareState::with_node(
            a_dir.path(),
            ShareNode::bind_offline(a_dir.path(), &a_dir.path().join("p2p"))
                .await
                .unwrap(),
        );
        let share_b = ShareState::with_node(
            b_dir.path(),
            ShareNode::bind_offline(b_dir.path(), &b_dir.path().join("p2p"))
                .await
                .unwrap(),
        );
        let share_c = ShareState::with_node(
            c_dir.path(),
            ShareNode::bind_offline(c_dir.path(), &c_dir.path().join("p2p"))
                .await
                .unwrap(),
        );

        slow(publish_secure(&state_a, &share_a, &pid.to_string()))
            .await
            .unwrap();

        // Invite B as editor and join.
        let code_b = member_code(&share_b).await.unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string();
        let body = json!({ "member_code": code_b, "role": "editor", "name": "Bee" });
        let inv = slow(invite(&state_a, &share_a, SID, Some(&body)))
            .await
            .unwrap()["invite"]
            .as_str()
            .unwrap()
            .to_string();
        slow(join(&share_b, Some(&json!({ "ticket": inv }))))
            .await
            .unwrap();
        let m = slow(members(&share_a, SID)).await.unwrap();
        let b_hex = m["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["name"] == json!("Bee"))
            .unwrap()["member_id"]
            .as_str()
            .unwrap()
            .to_string();

        // An editor is not admin-tier: B cannot list or manage members yet.
        let err = slow(members(&share_b, SID)).await.unwrap_err();
        assert_eq!(err.status, 403);

        // Promote B to co-admin; B learns its Admin delegation on sync.
        let changed = slow(set_member_role(
            &state_a,
            &share_a,
            SID,
            &b_hex,
            Some(&json!({ "role": "co-admin" })),
        ))
        .await
        .unwrap();
        assert_eq!(changed["role"], json!("co-admin"));
        slow(share_sync::sync_share(&state_b, &share_b, SID))
            .await
            .unwrap();
        let m = slow(members(&share_b, SID)).await.unwrap();
        assert_eq!(m["self_role"], json!("co-admin"));
        assert_eq!(m["self_member_id"], json!(b_hex.clone()));

        // The distributed-admin core: B (co-admin, NOT the hosting device)
        // invites C itself — keyhive delegation runs on B and the invite
        // points C at B's own address.
        let code_c = member_code(&share_c).await.unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string();
        let body = json!({ "member_code": code_c, "role": "viewer", "name": "Cee" });
        let inv_c = slow(invite(&state_b, &share_b, SID, Some(&body)))
            .await
            .unwrap()["invite"]
            .as_str()
            .unwrap()
            .to_string();
        let joined = slow(join(&share_c, Some(&json!({ "ticket": inv_c }))))
            .await
            .unwrap();
        assert_eq!(joined["share_id"], json!(SID));
        assert_eq!(joined["paper_count"], json!(1), "content served by B");
        let m = slow(members(&share_b, SID)).await.unwrap();
        let c_hex = m["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["name"] == json!("Cee"))
            .unwrap()["member_id"]
            .as_str()
            .unwrap()
            .to_string();

        // A co-admin cannot mint co-admins or transfer THE ADMIN.
        let err = slow(set_member_role(
            &state_b,
            &share_b,
            SID,
            &c_hex,
            Some(&json!({ "role": "co-admin" })),
        ))
        .await
        .unwrap_err();
        assert_eq!(err.status, 403);
        let err = slow(transfer_admin(
            &share_b,
            SID,
            Some(&json!({ "member_id": c_hex })),
        ))
        .await
        .unwrap_err();
        assert_eq!(err.status, 403);

        // Transfer THE ADMIN to B: the marker moves, A demotes to co-admin.
        slow(transfer_admin(
            &share_a,
            SID,
            Some(&json!({ "member_id": b_hex })),
        ))
        .await
        .unwrap();
        let m = slow(members(&share_a, SID)).await.unwrap();
        assert_eq!(m["self_role"], json!("co-admin"), "old admin demoted");
        let a_hex = m["self_member_id"].as_str().unwrap().to_string();
        slow(share_sync::sync_share(&state_b, &share_b, SID))
            .await
            .unwrap();
        let m = slow(members(&share_b, SID)).await.unwrap();
        assert_eq!(
            m["self_role"],
            json!("admin"),
            "powers travel with the role"
        );

        // A (now co-admin) cannot touch the admin tier.
        let err = slow(set_member_role(
            &state_a,
            &share_a,
            SID,
            &b_hex,
            Some(&json!({ "role": "editor" })),
        ))
        .await
        .unwrap_err();
        assert_eq!(err.status, 409, "THE ADMIN only changes via transfer");
        let err = slow(revoke_member(
            &share_a,
            SID,
            Some(&json!({ "member_id": b_hex })),
        ))
        .await
        .unwrap_err();
        assert_eq!(err.status, 409);
        // A (now co-admin) cannot transfer the role onward…
        let err = slow(transfer_admin(
            &share_a,
            SID,
            Some(&json!({ "member_id": c_hex })),
        ))
        .await
        .unwrap_err();
        assert_eq!(err.status, 403);
        // …but re-requesting the transfer that already happened is an
        // idempotent success (the retry path after a failed flush).
        let again = slow(transfer_admin(
            &share_a,
            SID,
            Some(&json!({ "member_id": b_hex })),
        ))
        .await
        .unwrap();
        assert_eq!(again["admin"], *b_hex);

        // B (THE ADMIN) revokes C from B's device: keyhive revocation + PCS
        // rotation run on the co-admin side. C's next sync is refused.
        slow(revoke_member(
            &share_b,
            SID,
            Some(&json!({ "member_id": c_hex })),
        ))
        .await
        .unwrap();
        let err = slow(share_sync::sync_share(&state_c, &share_c, SID))
            .await
            .unwrap_err();
        assert_eq!(err.status, 404, "revoked member is refused");

        // B (THE ADMIN) revoking A pre-empts on keyhive causal seniority: A's
        // root delegation is not in B's subtree, so the op cannot succeed and
        // the route says so instead of surfacing a NoProof transport error.
        let err = slow(revoke_member(
            &share_b,
            SID,
            Some(&json!({ "member_id": a_hex })),
        ))
        .await
        .unwrap_err();
        assert_eq!(err.status, 409);
        assert!(err.detail.contains("seniority"), "{}", err.detail);

        share_a.shutdown().await.unwrap();
        share_b.shutdown().await.unwrap();
        share_c.shutdown().await.unwrap();
    }
}
