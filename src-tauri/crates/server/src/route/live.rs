//! `/api/share/live` routes — live text docs: one Automerge text per doc,
//! streamed between peers over the share node's long-lived live sessions.
//! The editor posts its whole text; the merge happens here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use linxiv_core::models::NoteUpdateIn;
use linxiv_core::service::note as svc_note;
use linxiv_share::{live_dir, valid_live_id, LiveState, ShareError, ShareNode, ShareTicket};

use crate::route::share::ShareState;
use crate::route::{path_i64, to_value, ApiError, ReqCtx};
use crate::state::AppState;

/// How long a `wait` sync is held open before answering "nothing changed".
const POLL: Duration = Duration::from_secs(25);
/// A joined doc's session hangs up once no editor has synced for this long.
/// Must exceed [`POLL`], the gap between an idle editor's syncs.
const IDLE: Duration = Duration::from_secs(60);
// ponytail: fixed redial pace, no backoff; add one if a dead host's ticket
// left open in an editor shows up as traffic.
const REDIAL: Duration = Duration::from_secs(3);
/// Least time between two passes of a doc's source bridge.
const BRIDGE_EVERY: Duration = Duration::from_secs(1);
/// How often quiet cursors are checked for expiry.
const CURSOR_SWEEP: Duration = Duration::from_secs(4);
/// Largest text an editor may post. The diff is superlinear on big rewrites.
const MAX_TEXT: usize = 1024 * 1024;

/// What a hosted live doc mirrors: its text is seeded from the source and
/// written back to it. `kind` picks the adapter; `key` is the adapter's own id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct LiveSource {
    /// `note` today.
    kind: String,
    /// For `note`: the note id.
    key: String,
}

/// `GET /api/share/live` row.
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LiveRow {
    id: String,
    /// First non-blank line of the text.
    title: String,
    /// Hosted on this device, as opposed to joined from a ticket.
    hosted: bool,
    /// Set when the doc mirrors something in this library.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    source: Option<LiveSource>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LiveListing {
    docs: Vec<LiveRow>,
}

/// `POST /api/share/live` body.
#[derive(Debug, Deserialize, ts_rs::TS)]
pub struct LiveHostBody {
    /// Initial text.
    #[serde(default)]
    #[ts(optional)]
    text: Option<String>,
    /// Mirror this instead: seeds the text from it and keeps it updated. One
    /// doc per source; asking again returns the existing doc.
    #[serde(default)]
    #[ts(optional)]
    source: Option<LiveSource>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LiveStored {
    /// False when the doc mirrors nothing.
    bound: bool,
}

/// `POST /api/share/live/join` body.
#[derive(Debug, Deserialize, ts_rs::TS)]
pub struct LiveJoinBody {
    ticket: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LiveOpened {
    id: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LiveTicket {
    ticket: String,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LiveClosed {
    id: String,
}

/// `POST /api/share/live/{id}/sync` body.
#[derive(Debug, Deserialize, ts_rs::TS)]
pub struct LiveSyncBody {
    /// The editor's whole text, when it changed; absent to just read.
    #[serde(default)]
    #[ts(optional)]
    text: Option<String>,
    /// Version the editor's text was typed on: the last `heads` or `own` it got.
    base: Vec<String>,
    /// With no `text`: hold the request until the doc moves past `base` or the
    /// peer count leaves `peers`.
    #[serde(default)]
    wait: bool,
    #[serde(default)]
    peers: usize,
    /// The cursor `rev` last seen; `wait` also returns when it moves.
    #[serde(default)]
    rev: u32,
}

/// `POST /api/share/live/{id}/cursor` body.
#[derive(Debug, Deserialize, ts_rs::TS)]
pub struct LiveCursorBody {
    /// Selection ends as UTF-16 offsets into the text; both absent when the
    /// editor has no selection (blurred).
    #[serde(default)]
    #[ts(optional)]
    anchor: Option<u32>,
    #[serde(default)]
    #[ts(optional)]
    focus: Option<u32>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LiveCursorSent {
    sent: bool,
}

/// A peer's selection in `LiveSynced.text`, as UTF-16 offsets.
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LiveCursorRow {
    /// The peer's node id; stable, so it can key a color.
    peer: String,
    anchor: u32,
    focus: u32,
}

#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LiveSynced {
    /// False until a joined doc's first sync lands; not editable before.
    ready: bool,
    /// The merged text, at `heads`.
    text: String,
    heads: Vec<String>,
    /// Version holding exactly the posted `text`; the next `base` if the
    /// editor has typed on since posting.
    own: Vec<String>,
    /// Open live sessions: joiners when hosted, 1 when connected to the host.
    peers: usize,
    hosted: bool,
    /// Where other people's selections are.
    cursors: Vec<LiveCursorRow>,
    /// Version of `cursors`; echo it in the next `wait`.
    rev: u32,
}

impl From<LiveState> for LiveSynced {
    fn from(s: LiveState) -> Self {
        Self {
            ready: s.ready,
            text: s.text,
            heads: s.heads,
            own: s.own,
            peers: s.peers,
            hosted: s.hosted,
            cursors: s
                .cursors
                .into_iter()
                .map(|c| LiveCursorRow {
                    peer: c.peer,
                    anchor: c.anchor,
                    focus: c.focus,
                })
                .collect(),
            rev: s.rev,
        }
    }
}

// --- sources: what a live doc mirrors ---------------------------------------
//
// The whole contract is `load` and `store` on plain text. `bridge` does the
// merging, so a new kind (a file, a LaTeX source) is one arm in each.

fn load(state: &AppState, source: &LiveSource) -> Result<String, ApiError> {
    match source.kind.as_str() {
        "note" => {
            let id = path_i64(&source.key)?;
            let note = state.with_conn(|conn| svc_note::get_required(conn, id))?;
            Ok(note.content)
        }
        kind => Err(ApiError::new(
            422,
            format!("unknown live source kind {kind:?}"),
        )),
    }
}

fn store(state: &AppState, source: &LiveSource, text: &str) -> Result<(), ApiError> {
    match source.kind.as_str() {
        "note" => {
            let note_id = path_i64(&source.key)?;
            let update = NoteUpdateIn {
                note_id,
                title: None,
                content: Some(text.to_string()),
            };
            state
                .with_conn(|conn| svc_note::update(conn, &update))?
                .ok_or_else(|| svc_note::not_found(note_id))?;
            Ok(())
        }
        kind => Err(ApiError::new(
            422,
            format!("unknown live source kind {kind:?}"),
        )),
    }
}

/// `<id>.source` sidecar: the source, and the doc version it last matched.
#[derive(Serialize, Deserialize)]
struct Binding {
    source: LiveSource,
    heads: Vec<String>,
}

fn binding_path(share: &ShareState, id: &str) -> std::path::PathBuf {
    live_dir(share.share_dir()).join(format!("{id}.source"))
}

fn read_binding(share: &ShareState, id: &str) -> Option<Binding> {
    if !valid_live_id(id) {
        return None;
    }
    serde_json::from_slice(&std::fs::read(binding_path(share, id)).ok()?).ok()
}

fn write_binding(share: &ShareState, id: &str, binding: &Binding) -> Result<(), ApiError> {
    let path = binding_path(share, id);
    let tmp = path.with_extension("tmp");
    let bytes = serde_json::to_vec(binding).map_err(|e| ApiError::new(500, e.to_string()))?;
    std::fs::write(&tmp, bytes)
        .and_then(|_| std::fs::rename(&tmp, &path))
        .map_err(|e| ApiError::new(500, format!("live source sidecar: {e}")))
}

/// When each bound doc's bridge last ran.
pub(crate) type Bridged = Mutex<HashMap<String, Instant>>;

/// Reconciles a bound doc with its source, both ways: whatever the source
/// holds now is merged in as an edit on top of the version the two last
/// agreed on, then the merged text is written back. So an outside change to
/// the source and live typing both survive. `false` when the doc is unbound.
fn bridge(
    state: &AppState,
    share: &ShareState,
    node: &ShareNode,
    id: &str,
    force: bool,
) -> Result<bool, ApiError> {
    let Some(mut binding) = read_binding(share, id) else {
        return Ok(false);
    };
    {
        let mut bridged = share.live_bridged.lock().unwrap();
        if !force && bridged.get(id).is_some_and(|t| t.elapsed() < BRIDGE_EVERY) {
            return Ok(true);
        }
        bridged.insert(id.to_string(), Instant::now());
    }
    let outside = load(state, &binding.source)?;
    let doc = node.live_state(id)?;
    // Already equal (also the state after a crash between the two writes
    // below): replaying `outside` on the old version would double the edit.
    let merged = if doc.text == outside {
        doc
    } else {
        let merged = node.live_edit(id, &outside, &binding.heads)?;
        if merged.text != outside {
            store(state, &binding.source, &merged.text)?;
        }
        merged
    };
    if merged.heads != binding.heads {
        binding.heads = merged.heads;
        write_binding(share, id, &binding)?;
    }
    Ok(true)
}

/// One joined doc's redial task, and when an editor last synced it.
pub(crate) struct Dial {
    task: tokio::task::JoinHandle<()>,
    node: Weak<ShareNode>,
    touched: Arc<Mutex<Instant>>,
}

pub(crate) type Dials = Mutex<HashMap<String, Dial>>;

/// Keeps a joined doc connected to its host while an editor has it open.
/// Idempotent per sync; a hosted doc's task finds nobody to dial and ends.
fn keep_dialing(share: &ShareState, node: &Arc<ShareNode>, id: &str) {
    let mut dials = share.live_dials.lock().unwrap();
    if let Some(dial) = dials.get(id) {
        // A relay reconnect swaps the node; sessions on the old one are dead.
        if !dial.task.is_finished() && Weak::ptr_eq(&dial.node, &Arc::downgrade(node)) {
            *dial.touched.lock().unwrap() = Instant::now();
            return;
        }
        dial.task.abort();
    }
    let touched = Arc::new(Mutex::new(Instant::now()));
    let task = tokio::spawn({
        let (node, id, touched) = (node.clone(), id.to_string(), touched.clone());
        async move {
            let idle = async {
                loop {
                    let since = touched.lock().unwrap().elapsed();
                    match IDLE.checked_sub(since) {
                        Some(left) => tokio::time::sleep(left).await,
                        None => return,
                    }
                }
            };
            let redial = async {
                loop {
                    match node.live_dial(&id).await {
                        Ok(false) | Err(ShareError::NotFound(_)) => return,
                        _ => tokio::time::sleep(REDIAL).await,
                    }
                }
            };
            tokio::select! {
                _ = idle => {}
                _ = redial => {}
            }
        }
    });
    dials.insert(
        id.to_string(),
        Dial {
            task,
            node: Arc::downgrade(node),
            touched,
        },
    );
}

/// Per-node background work for live docs, for the node's lifetime: writes
/// changed docs to disk a beat later, and keeps peers' cursors current.
pub(crate) fn spawn_tasks(node: &Arc<ShareNode>) {
    let (weak, mut ticks) = (Arc::downgrade(node), node.changes());
    tokio::spawn(async move {
        while ticks.changed().await.is_ok() {
            // ponytail: whole-doc rewrite per burst; switch to incremental
            // saves if long docs make this show up.
            tokio::time::sleep(Duration::from_secs(1)).await;
            ticks.borrow_and_update();
            let Some(node) = weak.upgrade() else { return };
            if let Err(e) = node.live_save() {
                eprintln!("live docs: save failed: {e}");
            }
        }
    });
    let (weak, mut inbox) = (Arc::downgrade(node), node.live_messages());
    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            let msg = tokio::time::timeout(CURSOR_SWEEP, inbox.recv()).await;
            let Some(node) = weak.upgrade() else { return };
            match msg {
                Ok(Ok(msg)) => node.live_cursor_received(&msg),
                Ok(Err(RecvError::Lagged(_))) => {}
                Ok(Err(RecvError::Closed)) => return,
                Err(_) => node.live_expire_cursors(),
            }
        }
    });
}

async fn node(share: &ShareState) -> Result<Arc<ShareNode>, ApiError> {
    share
        .node()
        .await
        .ok_or_else(|| ApiError::new(503, "share transport not initialized"))
}

/// Match a `/api/share/live/*` request; `None` = no arm.
pub(crate) async fn dispatch(
    state: &AppState,
    share: &ShareState,
    ctx: &ReqCtx<'_>,
) -> Option<Result<Value, ApiError>> {
    Some(match (ctx.method, ctx.segs) {
        ("GET", ["api", "share", "live"]) => list(share).await,
        ("POST", ["api", "share", "live"]) => host(state, share, ctx).await,
        ("POST", ["api", "share", "live", id, "store"]) => store_now(state, share, id).await,
        ("POST", ["api", "share", "live", "join"]) => join(share, ctx).await,
        ("GET", ["api", "share", "live", id, "ticket"]) => ticket(share, id).await,
        ("POST", ["api", "share", "live", id, "sync"]) => sync(state, share, id, ctx).await,
        ("POST", ["api", "share", "live", id, "cursor"]) => cursor(share, id, ctx).await,
        ("DELETE", ["api", "share", "live", id]) => close(share, id).await,
        _ => return None,
    })
}

/// `GET /api/share/live` — every live doc on this device, hosted or joined.
async fn list(share: &ShareState) -> Result<Value, ApiError> {
    let node = node(share).await?;
    let docs = node
        .live_ids()
        .into_iter()
        .filter_map(|id| {
            let state = node.live_state(&id).ok()?;
            let title = state
                .text
                .lines()
                .map(|l| l.trim_start_matches('#').trim())
                .find(|l| !l.is_empty())
                .unwrap_or_default()
                .chars()
                .take(80)
                .collect();
            Some(LiveRow {
                source: read_binding(share, &id).map(|b| b.source),
                id,
                title,
                hosted: state.hosted,
            })
        })
        .collect();
    to_value(&LiveListing { docs })
}

/// `POST /api/share/live` — start hosting a new live doc, blank, from
/// `text`, or mirroring a `source` (which then wins over `text`).
async fn host(state: &AppState, share: &ShareState, ctx: &ReqCtx<'_>) -> Result<Value, ApiError> {
    let body: LiveHostBody = ctx.parse_body()?;
    let node = node(share).await?;
    if let Some(source) = &body.source {
        let open = node
            .live_ids()
            .into_iter()
            .find(|id| read_binding(share, id).is_some_and(|b| &b.source == source));
        if let Some(id) = open {
            return to_value(&LiveOpened { id });
        }
    }
    let text = match &body.source {
        Some(source) => load(state, source)?,
        None => body.text.unwrap_or_default(),
    };
    if text.len() > MAX_TEXT {
        return Err(ApiError::new(413, "live doc text too large"));
    }
    let id = node.live_host(&text)?;
    if let Some(source) = body.source {
        let heads = node.live_state(&id)?.heads;
        write_binding(share, &id, &Binding { source, heads })?;
    }
    to_value(&LiveOpened { id })
}

/// `POST /api/share/live/{id}/store` — reconcile the doc with its source now
/// instead of on the next sync. For an editor about to close.
async fn store_now(state: &AppState, share: &ShareState, id: &str) -> Result<Value, ApiError> {
    let node = node(share).await?;
    node.live_state(id)?;
    let bound = bridge(state, share, &node, id, true)?;
    to_value(&LiveStored { bound })
}

/// `POST /api/share/live/join` — adopt a live doc from its host's ticket. The
/// first sync connects; the doc reports `ready` once the host's text arrives.
async fn join(share: &ShareState, ctx: &ReqCtx<'_>) -> Result<Value, ApiError> {
    let body: LiveJoinBody = ctx.parse_body()?;
    let ticket: ShareTicket = body
        .ticket
        .trim()
        .parse()
        .map_err(|e| ApiError::new(400, format!("not a live doc ticket: {e}")))?;
    let id = node(share).await?.live_join(&ticket).map_err(|e| match e {
        ShareError::NotFound(_) => ApiError::new(400, "not a live doc ticket"),
        e => e.into(),
    })?;
    to_value(&LiveOpened { id })
}

/// `GET /api/share/live/{id}/ticket` — the pasteable invite. Anyone holding it
/// can read and edit the doc.
async fn ticket(share: &ShareState, id: &str) -> Result<Value, ApiError> {
    let ticket = node(share).await?.live_ticket(id)?;
    to_value(&LiveTicket { ticket })
}

/// `POST /api/share/live/{id}/sync` — the editor's one call: post text typed
/// on `base` and get the merged doc back, or `wait` for a peer's edit.
async fn sync(
    state: &AppState,
    share: &ShareState,
    id: &str,
    ctx: &ReqCtx<'_>,
) -> Result<Value, ApiError> {
    let body: LiveSyncBody = ctx.parse_body()?;
    let node = node(share).await?;
    // A source that fails to load or store must not take the editor down.
    if let Err(e) = bridge(state, share, &node, id, false) {
        eprintln!("live doc {id}: source bridge failed: {}", e.detail);
    }
    let live = match &body.text {
        Some(text) if text.len() > MAX_TEXT => {
            return Err(ApiError::new(413, "live doc text too large"))
        }
        Some(text) => node.live_edit(id, text, &body.base)?,
        None => node.live_state(id)?,
    };
    keep_dialing(share, &node, id);
    let live = match body.text {
        None if body.wait => {
            // Edits not yet written to the source: come back within a beat
            // so the next call's bridge stores them, even if nobody types.
            let unstored = read_binding(share, id).is_some_and(|b| b.heads != live.heads);
            let hold = if unstored { BRIDGE_EVERY } else { POLL };
            node.live_wait(id, &body.base, body.peers, body.rev, hold)
                .await?
        }
        _ => live,
    };
    to_value(&LiveSynced::from(live))
}

/// `POST /api/share/live/{id}/cursor` — tell live peers where this editor's
/// selection is. Never stored; repeat it every few seconds or it expires.
async fn cursor(share: &ShareState, id: &str, ctx: &ReqCtx<'_>) -> Result<Value, ApiError> {
    let body: LiveCursorBody = ctx.parse_body()?;
    node(share)
        .await?
        .live_set_cursor(id, body.anchor.zip(body.focus))?;
    to_value(&LiveCursorSent { sent: true })
}

/// `DELETE /api/share/live/{id}` — stop hosting (peers are cut off) or leave,
/// and delete the local copy.
async fn close(share: &ShareState, id: &str) -> Result<Value, ApiError> {
    node(share).await?.live_close(id)?;
    if let Some(dial) = share.live_dials.lock().unwrap().remove(id) {
        dial.task.abort();
    }
    share.live_bridged.lock().unwrap().remove(id);
    to_value(&LiveClosed { id: id.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::route::share::dispatch as share_dispatch;
    use crate::route::testutil::{req, state};
    use crate::route::ApiRequest;
    use linxiv_core::service::paper as svc_paper;
    use serde_json::json;

    async fn live(
        st: &AppState,
        share: &ShareState,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, ApiError> {
        let req = ApiRequest {
            method: method.into(),
            path: format!("/api/share/live{path}"),
            body,
        };
        share_dispatch(st, share, &|| {}, req).await
    }

    async fn note_content(st: &AppState, note: i64) -> String {
        let got = req(st, "GET", &format!("/api/notes/{note}"), None)
            .await
            .unwrap();
        got["note"]["content"].as_str().unwrap().to_string()
    }

    /// A doc bound to a note is seeded from it, writes live edits back, and
    /// merges an edit made to the note elsewhere instead of overwriting it.
    #[tokio::test]
    async fn note_source_bridges_both_ways() {
        let st = state();
        st.with_conn(|conn| svc_paper::ensure_paper_root(conn, "arxiv:1"))
            .unwrap();
        let created = req(
            &st,
            "POST",
            "/api/notes",
            Some(json!({ "source_id": "arxiv:1", "title": "t", "content": "alpha\nbeta" })),
        )
        .await
        .unwrap();
        let note = created["id"].as_i64().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let node = ShareNode::bind_offline(dir.path(), &dir.path().join("p2p"))
            .await
            .unwrap();
        let share = ShareState::with_node(dir.path(), node);

        let source = json!({ "kind": "note", "key": note.to_string() });
        let host = Some(json!({ "source": source }));
        let opened = live(&st, &share, "POST", "", host.clone()).await.unwrap();
        let id = opened["id"].as_str().unwrap().to_string();
        // One doc per source.
        let again = live(&st, &share, "POST", "", host).await.unwrap();
        assert_eq!(again["id"], opened["id"]);
        let listed = live(&st, &share, "GET", "", None).await.unwrap();
        assert_eq!(listed["docs"][0]["source"], source);

        let sync_path = format!("/{id}/sync");
        let sync = |body: Value| live(&st, &share, "POST", &sync_path, Some(body));
        let seeded = sync(json!({ "base": [] })).await.unwrap();
        assert_eq!(seeded["text"], "alpha\nbeta");

        // Live typing reaches the note.
        sync(json!({ "text": "alpha!\nbeta", "base": seeded["heads"] }))
            .await
            .unwrap();
        let stored = live(&st, &share, "POST", &format!("/{id}/store"), None)
            .await
            .unwrap();
        assert_eq!(stored, json!({ "bound": true }));
        assert_eq!(note_content(&st, note).await, "alpha!\nbeta");

        // The note is edited elsewhere while someone types in the doc: both land.
        let before = sync(json!({ "base": [] })).await.unwrap();
        req(
            &st,
            "PATCH",
            &format!("/api/notes/{note}"),
            Some(json!({ "content": "alpha!\nbeta\ngamma" })),
        )
        .await
        .unwrap();
        sync(json!({ "text": ">alpha!\nbeta", "base": before["heads"] }))
            .await
            .unwrap();
        live(&st, &share, "POST", &format!("/{id}/store"), None)
            .await
            .unwrap();
        let merged = sync(json!({ "base": [] })).await.unwrap();
        assert_eq!(merged["text"], ">alpha!\nbeta\ngamma");
        assert_eq!(note_content(&st, note).await, ">alpha!\nbeta\ngamma");

        // An unbound doc reports so; an unknown kind is refused up front.
        let plain = live(&st, &share, "POST", "", Some(json!({ "text": "x" })))
            .await
            .unwrap();
        let plain_id = plain["id"].as_str().unwrap();
        let unbound = live(&st, &share, "POST", &format!("/{plain_id}/store"), None)
            .await
            .unwrap();
        assert_eq!(unbound, json!({ "bound": false }));
        let bad = json!({ "source": { "kind": "nope", "key": "1" } });
        let err = live(&st, &share, "POST", "", Some(bad)).await.unwrap_err();
        assert_eq!(err.status, 422);

        // Closing removes the binding with the doc; the note stays.
        live(&st, &share, "DELETE", &format!("/{id}"), None)
            .await
            .unwrap();
        assert!(!binding_path(&share, &id).exists());
        assert_eq!(note_content(&st, note).await, ">alpha!\nbeta\ngamma");
        share.shutdown().await.unwrap();
    }
}
