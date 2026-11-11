//! `/api/share/live` routes — live text docs: one Automerge text per doc,
//! streamed between peers over the share node's long-lived live sessions.
//! The editor posts its whole text; the merge happens here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use linxiv_share::{LiveState, ShareError, ShareNode, ShareTicket};

use crate::route::share::ShareState;
use crate::route::{to_value, ApiError, ReqCtx};

/// How long a `wait` sync is held open before answering "nothing changed".
const POLL: Duration = Duration::from_secs(25);
/// A joined doc's session hangs up once no editor has synced for this long.
/// Must exceed [`POLL`], the gap between an idle editor's syncs.
const IDLE: Duration = Duration::from_secs(60);
// ponytail: fixed redial pace, no backoff; add one if a dead host's ticket
// left open in an editor shows up as traffic.
const REDIAL: Duration = Duration::from_secs(3);
/// How often quiet cursors are checked for expiry.
const CURSOR_SWEEP: Duration = Duration::from_secs(4);
/// Largest text an editor may post. The diff is superlinear on big rewrites.
const MAX_TEXT: usize = 1024 * 1024;

/// `GET /api/share/live` row.
#[derive(Debug, Serialize, ts_rs::TS)]
pub struct LiveRow {
    id: String,
    /// First non-blank line of the text.
    title: String,
    /// Hosted on this device, as opposed to joined from a ticket.
    hosted: bool,
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
    share: &ShareState,
    ctx: &ReqCtx<'_>,
) -> Option<Result<Value, ApiError>> {
    Some(match (ctx.method, ctx.segs) {
        ("GET", ["api", "share", "live"]) => list(share).await,
        ("POST", ["api", "share", "live"]) => host(share, ctx).await,
        ("POST", ["api", "share", "live", "join"]) => join(share, ctx).await,
        ("GET", ["api", "share", "live", id, "ticket"]) => ticket(share, id).await,
        ("POST", ["api", "share", "live", id, "sync"]) => sync(share, id, ctx).await,
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
                id,
                title,
                hosted: state.hosted,
            })
        })
        .collect();
    to_value(&LiveListing { docs })
}

/// `POST /api/share/live` — start hosting a new live doc.
async fn host(share: &ShareState, ctx: &ReqCtx<'_>) -> Result<Value, ApiError> {
    let body: LiveHostBody = ctx.parse_body()?;
    let text = body.text.unwrap_or_default();
    if text.len() > MAX_TEXT {
        return Err(ApiError::new(413, "live doc text too large"));
    }
    let id = node(share).await?.live_host(&text)?;
    to_value(&LiveOpened { id })
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
async fn sync(share: &ShareState, id: &str, ctx: &ReqCtx<'_>) -> Result<Value, ApiError> {
    let body: LiveSyncBody = ctx.parse_body()?;
    let node = node(share).await?;
    let state = match &body.text {
        Some(text) if text.len() > MAX_TEXT => {
            return Err(ApiError::new(413, "live doc text too large"))
        }
        Some(text) => node.live_edit(id, text, &body.base)?,
        None => node.live_state(id)?,
    };
    keep_dialing(share, &node, id);
    let state = match body.text {
        None if body.wait => {
            node.live_wait(id, &body.base, body.peers, body.rev, POLL)
                .await?
        }
        _ => state,
    };
    to_value(&LiveSynced::from(state))
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
    to_value(&LiveClosed { id: id.to_string() })
}
