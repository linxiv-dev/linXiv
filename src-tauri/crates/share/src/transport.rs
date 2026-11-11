//! Share transport over the vendored `linxiv-p2p` node: on the share ALPN a
//! [`ShareNode`] serves only top-level `share_dir/<id>.automerge` docs (access
//! needs the file there); received mirrors are quarantined in `received/`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use automerge::Automerge;
use linxiv_p2p::sync::JoinError;
use linxiv_p2p::DeviceIdentity;

#[cfg(feature = "sync-beelay")]
pub use linxiv_p2p::{MemberId, ProjectInvite, Role};
pub use linxiv_p2p::{ShareTicket, ALPN};

use crate::{load, save, ShareError, SharedProject};
pub use linxiv_core::service::export_import::valid_share_id;

const RECEIVED_SUBDIR: &str = "received";
const DEVICE_KEY_FILE: &str = "device.key";
#[cfg(feature = "sync-beelay")]
const E2EE_SUBDIR: &str = "e2ee";

type Result<T> = std::result::Result<T, ShareError>;

fn net<E: std::fmt::Display>(e: E) -> ShareError {
    ShareError::Transport(format!("share transport: {e}"))
}

/// The directory received mirrors are materialized under.
pub fn received_dir(share_dir: &Path) -> PathBuf {
    share_dir.join(RECEIVED_SUBDIR)
}

/// Hoster-published e2ee docs: `share_dir/e2ee/<id>.automerge`.
#[cfg(feature = "sync-beelay")]
pub fn e2ee_dir(share_dir: &Path) -> PathBuf {
    share_dir.join(E2EE_SUBDIR)
}

/// Reader mirrors of e2ee shares: `share_dir/e2ee/received/<id>.automerge`.
#[cfg(feature = "sync-beelay")]
pub fn e2ee_received_dir(share_dir: &Path) -> PathBuf {
    e2ee_dir(share_dir).join(RECEIVED_SUBDIR)
}

/// What one [`ShareNode::accept_invite`] achieved.
#[cfg(feature = "sync-beelay")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedInvite {
    pub share_id: String,
    /// Host unreachable, so the join is half done: parked invite, empty
    /// placeholder mirror, finished by the interval sync.
    pub pending: bool,
}

/// What one [`ShareNode::sync_e2ee`] changed locally.
#[cfg(feature = "sync-beelay")]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct E2eeSyncOutcome {
    /// Decrypted changes newly applied to the local doc.
    pub applied: usize,
    /// Commits with no key for their epoch: revoked, or not yet keyed.
    pub no_key: usize,
    /// Commits that failed to decrypt for any other reason.
    pub failed: usize,
}

#[cfg(feature = "sync-beelay")]
impl From<linxiv_p2p::SyncOutcome> for E2eeSyncOutcome {
    fn from(o: linxiv_p2p::SyncOutcome) -> Self {
        use linxiv_p2p::DecryptError;
        let no_key = o
            .undecryptable
            .iter()
            .filter(|e| matches!(e, DecryptError::KeyNotFound))
            .count();
        Self {
            applied: o.applied,
            no_key,
            failed: o.undecryptable.len() - no_key,
        }
    }
}

/// Raw doc bytes to `dir/<share_id>.automerge` via tmp+rename (mirror writes
/// preserve remote CRDT history byte-for-byte, unlike `save`'s reconcile).
fn write_doc_bytes(dir: &Path, share_id: &str, bytes: Vec<u8>) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{share_id}.automerge.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, super::doc_path(dir, share_id))?;
    Ok(())
}

#[cfg(feature = "sync-beelay")]
fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.is_ascii() || !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Lowercase hex of a member id — the form member ids take on the wire and in
/// the members sidecar.
#[cfg(feature = "sync-beelay")]
pub fn member_id_hex(m: &MemberId) -> String {
    m.0.iter().map(|b| format!("{b:02x}")).collect()
}

/// Inverse of [`member_id_hex`]; `None` unless `s` is 64 hex chars.
#[cfg(feature = "sync-beelay")]
pub fn member_id_from_hex(s: &str) -> Option<MemberId> {
    Some(MemberId(decode_hex(s)?.try_into().ok()?))
}

/// Owns the p2p node for the share ALPN. One node both serves its own published
/// docs (via [`ShareNode::ticket`]) and fetches others' (via [`ShareNode::fetch`]).
pub struct ShareNode {
    inner: linxiv_p2p::ShareNode,
    share_dir: PathBuf,
    // None when the keyhive auth state failed to load.
    #[cfg(feature = "sync-beelay")]
    beelay: Option<linxiv_p2p::BeelayNode>,
    // Heads of each live doc as last written, so `live_save` skips clean ones.
    live_saved: std::sync::Mutex<std::collections::HashMap<String, Vec<automerge::ChangeHash>>>,
    // Peers' selections per live doc, by peer id. Memory only.
    live_cursors: std::sync::Mutex<
        std::collections::HashMap<String, std::collections::HashMap<String, PeerCursor>>,
    >,
    // Bumped whenever `live_cursors` changes; wakes waiting editors.
    live_rev: tokio::sync::watch::Sender<u32>,
}

impl ShareNode {
    /// Production node: iroh n0 defaults (relay + discovery). Serves only
    /// `share_dir`; `p2p_dir` holds the key files + keyhive/beelay state.
    pub async fn bind(share_dir: impl Into<PathBuf>, p2p_dir: &Path) -> Result<Self> {
        Self::bind_inner(share_dir.into(), p2p_dir, false, None, None).await
    }

    /// Like [`Self::bind`]; `Some(dek)` AEAD-wraps the at-rest key files under the
    /// 32-byte DEK (legacy plaintext migrates once), `None` keeps plaintext.
    /// `relay` swaps in a self-hosted relay; `None` keeps n0 defaults.
    #[cfg(feature = "sync-beelay")]
    pub async fn bind_with_dek(
        share_dir: impl Into<PathBuf>,
        p2p_dir: &Path,
        dek: Option<[u8; 32]>,
        relay: Option<linxiv_p2p::CustomRelay>,
    ) -> Result<Self> {
        Self::bind_inner(share_dir.into(), p2p_dir, false, relay, dek).await
    }

    /// Offline/hermetic test node: no relays or discovery, direct addrs only.
    pub async fn bind_offline(share_dir: impl Into<PathBuf>, p2p_dir: &Path) -> Result<Self> {
        Self::bind_inner(share_dir.into(), p2p_dir, true, None, None).await
    }

    // `_dek` is only read with the beelay stack; the underscore keeps the
    // plain-sync build warning-free.
    async fn bind_inner(
        share_dir: PathBuf,
        p2p_dir: &Path,
        offline: bool,
        relay: Option<linxiv_p2p::CustomRelay>,
        _dek: Option<[u8; 32]>,
    ) -> Result<Self> {
        std::fs::create_dir_all(p2p_dir)?;
        #[cfg(feature = "sync-beelay")]
        let identity = DeviceIdentity::load_or_generate_with_dek(
            p2p_dir.join(DEVICE_KEY_FILE),
            _dek.as_ref(),
        )?;
        #[cfg(not(feature = "sync-beelay"))]
        let identity = DeviceIdentity::load_or_generate(p2p_dir.join(DEVICE_KEY_FILE))?;
        #[cfg(feature = "sync-beelay")]
        let (inner, beelay) =
            Self::bind_stack(&identity, p2p_dir, offline, relay, _dek.as_ref()).await?;
        #[cfg(not(feature = "sync-beelay"))]
        let inner = Self::bind_plain(&identity, offline, relay).await?;
        let node = Self {
            inner,
            share_dir,
            #[cfg(feature = "sync-beelay")]
            beelay,
            live_saved: Default::default(),
            live_cursors: Default::default(),
            live_rev: tokio::sync::watch::channel(0).0,
        };
        // Serve only what is published at the top level of share_dir; received/
        // mirrors land in the p2p registry after a join.
        let allowed_dir = node.share_dir.clone();
        node.inner.set_access_check(Arc::new(move |_peer, id| {
            valid_share_id(id) && super::doc_path(&allowed_dir, id).is_file()
        }));
        // Live peers write, so they reach live docs only, never a share.
        let live_dir = node.share_dir.clone();
        node.inner
            .set_live_access_check(Arc::new(move |_peer, id| live_hosted(&live_dir, id)));
        node.register_published().await?;
        node.register_live();
        Ok(node)
    }

    async fn bind_plain(
        identity: &DeviceIdentity,
        offline: bool,
        relay: Option<linxiv_p2p::CustomRelay>,
    ) -> Result<linxiv_p2p::ShareNode> {
        if offline {
            linxiv_p2p::ShareNode::bind_local(identity).await
        } else if let Some(relay) = relay {
            linxiv_p2p::ShareNode::bind_custom_relay(identity, relay).await
        } else {
            linxiv_p2p::ShareNode::bind(identity).await
        }
        .map_err(net)
    }

    /// Plain sync + beelay + blobs on ONE endpoint. Corrupt keyhive state (or an
    /// auth key that won't decrypt) falls back to a plain bind with no beelay node.
    #[cfg(feature = "sync-beelay")]
    async fn bind_stack(
        identity: &DeviceIdentity,
        p2p_dir: &Path,
        offline: bool,
        relay: Option<linxiv_p2p::CustomRelay>,
        dek: Option<&[u8; 32]>,
    ) -> Result<(linxiv_p2p::ShareNode, Option<linxiv_p2p::BeelayNode>)> {
        let auth_identity = match linxiv_p2p::AuthIdentity::load_or_generate_with_dek(
            p2p_dir.join("auth.key"),
            dek,
        ) {
            Ok(identity) => identity,
            Err(e) => {
                tracing::warn!("keyhive auth key failed to load, e2ee sharing disabled: {e}");
                return Ok((Self::bind_plain(identity, offline, relay).await?, None));
            }
        };
        let auth = match linxiv_p2p::ProjectAuth::load_or_new_with_dek(
            &auth_identity,
            &p2p_dir.join("keyhive"),
            dek,
        )
        .await
        {
            Ok(auth) => auth,
            Err(e) => {
                tracing::warn!("keyhive auth state failed to load, e2ee sharing disabled: {e}");
                return Ok((Self::bind_plain(identity, offline, relay).await?, None));
            }
        };
        let beelay_dir = p2p_dir.join("beelay");
        let stack = if offline {
            linxiv_p2p::bind_stack_local(identity, &auth_identity, auth, Some(&beelay_dir)).await
        } else if let Some(relay) = relay.clone() {
            linxiv_p2p::bind_stack_custom_relay(
                identity,
                &auth_identity,
                auth,
                Some(&beelay_dir),
                relay,
            )
            .await
        } else {
            linxiv_p2p::bind_stack(identity, &auth_identity, auth, Some(&beelay_dir)).await
        };
        match stack {
            Ok((inner, beelay)) => Ok((inner, Some(beelay))),
            Err(e) => {
                tracing::warn!("beelay/blob stack failed to bind, e2ee sharing disabled: {e}");
                Ok((Self::bind_plain(identity, offline, relay).await?, None))
            }
        }
    }

    /// Register every published doc (top-level `*.automerge` only). A corrupt
    /// doc is skipped, mirroring `list_shared`.
    async fn register_published(&self) -> Result<()> {
        let entries = match std::fs::read_dir(&self.share_dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("automerge") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let _ = self.refresh(id).await;
        }
        Ok(())
    }

    /// (Re-)register `share_id` from its doc file so the registry serves the
    /// latest bytes; missing file → `NotFound`. Reads/decodes via `spawn_blocking`.
    pub async fn refresh(&self, share_id: &str) -> Result<()> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        let doc_path = super::doc_path(&self.share_dir, share_id);
        let id = share_id.to_string();
        let doc = tokio::task::spawn_blocking(move || -> Result<Automerge> {
            let bytes = match std::fs::read(&doc_path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(ShareError::NotFound(id))
                }
                Err(e) => return Err(e.into()),
            };
            Automerge::load(&bytes).map_err(super::crdt)
        })
        .await
        .map_err(net)??;
        self.inner.register(share_id, doc);
        Ok(())
    }

    /// Register `share_id` from the doc `save()` returned, skipping
    /// [`Self::refresh`]'s re-read. Callers must `save()` first, or the access
    /// check refuses to serve it.
    pub fn register_doc(&self, share_id: &str, mut doc: automerge::AutoCommit) -> Result<()> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        self.inner.register(share_id, doc.document().clone());
        Ok(())
    }

    /// Build a pasteable ticket for a published share. Refreshes the registered
    /// doc from disk first; an unpublished id errors.
    pub async fn ticket(&self, share_id: &str) -> Result<ShareTicket> {
        self.refresh(share_id).await?;
        self.inner.ticket(share_id).map_err(net)
    }

    /// Dial the ticket's host, sync the doc, and materialize a READ-ONLY mirror
    /// under `dest_share_dir/received`.
    pub async fn fetch(
        &self,
        ticket: &ShareTicket,
        dest_share_dir: &Path,
    ) -> Result<SharedProject> {
        let share_id = ticket.project_id();
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(
                "share not found or revoked".to_string(),
            ));
        }
        self.inner.join(ticket).await.map_err(|e| match e {
            JoinError::Refused => ShareError::NotFound("share not found or revoked".to_string()),
            JoinError::Other(e) => net(e),
        })?;
        let doc = self
            .inner
            .doc(share_id)
            .ok_or_else(|| net("synced doc missing from registry"))?;
        let sp: SharedProject = autosurgeon::hydrate(&doc).map_err(super::crdt)?;
        // The doc-internal share_id is host-controlled and feeds caller paths.
        if !valid_share_id(&sp.share_id) {
            return Err(net(format!("remote share_id is unsafe: {:?}", sp.share_id)));
        }
        if sp.share_id != share_id {
            return Err(net(format!(
                "remote share_id {:?} does not match ticket id {share_id:?}",
                sp.share_id
            )));
        }
        // Namespaced mirror dir; raw bytes so the host's actors/timestamps
        // survive instead of being re-authored as this device.
        write_doc_bytes(&received_dir(dest_share_dir), share_id, doc.save())?;
        Ok(sp)
    }
    /// Hydrate a received mirror by id from `dest_share_dir/received`.
    pub fn received(dest_share_dir: &Path, share_id: &str) -> Result<SharedProject> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        load(&received_dir(dest_share_dir), share_id)
    }

    /// Summaries of every received mirror under `dest_share_dir/received`.
    pub fn list_received(dest_share_dir: &Path) -> Result<Vec<crate::SharedSummary>> {
        crate::list_shared(&received_dir(dest_share_dir))
    }

    /// This node's iroh endpoint id (the device's share identity), as hex.
    pub fn endpoint_id(&self) -> String {
        self.inner.endpoint_id().to_string()
    }

    /// The underlying iroh endpoint — Remote Query Mode's client half dials
    /// remote nodes from it (one endpoint, never a second bind).
    pub fn endpoint(&self) -> &linxiv_p2p::Endpoint {
        self.inner.endpoint()
    }

    /// Remote Query Mode: installs the `linxiv-api/1` handler on this endpoint.
    /// Headless-only; until installed, api-ALPN connections are refused.
    pub fn set_api_protocol(&self, handler: Box<dyn linxiv_p2p::DynProtocolHandler>) {
        self.inner.set_api_protocol(handler);
    }

    pub async fn shutdown(&self) -> Result<()> {
        // Shared router under bind_stack.
        #[cfg(feature = "sync-beelay")]
        let beelay_res = match &self.beelay {
            Some(beelay) => beelay.shutdown().await.map_err(net),
            None => Ok(()),
        };
        let inner_res = self.inner.shutdown().await.map_err(net);
        #[cfg(feature = "sync-beelay")]
        beelay_res?;
        inner_res
    }
}

// --- live text docs ----------------------------------------------------------

const LIVE_SUBDIR: &str = "live";
const LIVE_TEXT: &str = "text";

/// Live text docs: `share_dir/live/<id>.automerge`, plus a `.ticket` sidecar
/// naming the host for the ones joined rather than hosted here.
pub fn live_dir(share_dir: &Path) -> PathBuf {
    share_dir.join(LIVE_SUBDIR)
}

/// `live-` + 32 lowercase hex: the unguessable part is the whole capability.
pub fn valid_live_id(id: &str) -> bool {
    id.strip_prefix("live-").is_some_and(|hex| {
        hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

fn live_path(share_dir: &Path, id: &str, ext: &str) -> PathBuf {
    live_dir(share_dir).join(format!("{id}.{ext}"))
}

/// Served to peers only when hosted here; a joined doc is its host's to serve.
fn live_hosted(share_dir: &Path, id: &str) -> bool {
    valid_live_id(id)
        && live_path(share_dir, id, "automerge").is_file()
        && !live_path(share_dir, id, "ticket").is_file()
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// One editor's view of a live doc. `heads` names the version `text` is at;
/// `own` names the version holding exactly the text the editor sent.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LiveState {
    /// False until a joined doc's first sync lands; `text` is not editable before.
    pub ready: bool,
    pub text: String,
    pub heads: Vec<String>,
    pub own: Vec<String>,
    pub peers: usize,
    pub hosted: bool,
    pub cursors: Vec<LiveCursor>,
    /// Version of `cursors`; moves whenever a peer's selection does.
    pub rev: u32,
}

/// A peer's selection, as UTF-16 offsets into the accompanying text.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveCursor {
    pub peer: String,
    pub anchor: u32,
    pub focus: u32,
}

/// A peer's selection as received: automerge cursors, so it stays put while
/// text around it changes.
struct PeerCursor {
    anchor: automerge::Cursor,
    focus: automerge::Cursor,
    seen: std::time::Instant,
}

/// The ephemeral cursor message. `None` ends clear the sender's selection.
#[derive(serde::Serialize, serde::Deserialize)]
struct CursorWire {
    peer: String,
    anchor: Option<String>,
    focus: Option<String>,
}

/// A selection not refreshed for this long is gone (its owner left).
const CURSOR_TTL: std::time::Duration = std::time::Duration::from_secs(12);
/// Bounds what forged peer ids can make a doc remember.
const MAX_CURSORS: usize = 64;

// Editors count UTF-16 units; automerge text here indexes code points.
fn utf16_to_index(text: &str, utf16: u32) -> usize {
    let mut units = 0;
    for (i, c) in text.chars().enumerate() {
        if units >= utf16 {
            return i;
        }
        units += c.len_utf16() as u32;
    }
    text.chars().count()
}

fn index_to_utf16(text: &str, index: usize) -> u32 {
    text.chars().take(index).map(|c| c.len_utf16() as u32).sum()
}

/// The text object and its content, once the doc has one.
fn live_text(doc: &Automerge) -> Option<(automerge::ObjId, String)> {
    use automerge::ReadDoc;
    let (_, obj) = doc.get(automerge::ROOT, LIVE_TEXT).ok()??;
    let text = doc.text(&obj).ok()?;
    Some((obj, text))
}

fn hex_heads(doc: &Automerge) -> Vec<String> {
    doc.get_heads().iter().map(|h| h.to_string()).collect()
}

fn live_read(doc: &Automerge) -> Result<LiveState> {
    use automerge::ReadDoc;
    let Some((_, obj)) = doc.get(automerge::ROOT, LIVE_TEXT).map_err(super::crdt)? else {
        return Ok(LiveState::default());
    };
    Ok(LiveState {
        ready: true,
        text: doc.text(&obj).map_err(super::crdt)?,
        heads: hex_heads(doc),
        ..LiveState::default()
    })
}

/// Rewrites the doc's text to `text`, as an edit made on top of `base`.
/// Returns the heads of the version holding exactly `text`.
fn live_write(doc: &mut Automerge, text: &str, base: &[String]) -> Result<Vec<String>> {
    use automerge::{transaction::Transactable, ReadDoc};
    let (_, obj) = doc
        .get(automerge::ROOT, LIVE_TEXT)
        .map_err(super::crdt)?
        .ok_or_else(|| ShareError::Transport("live doc has not synced yet".into()))?;
    let put = |d: &mut Automerge| {
        d.transact(|tx| tx.update_text(&obj, text))
            .map(|_| ())
            .map_err(|e| super::crdt(e.error))
    };
    let mut sorted = base.to_vec();
    sorted.sort();
    if hex_heads(doc) == sorted {
        if doc.text(&obj).map_err(super::crdt)? != text {
            put(doc)?;
        }
        return Ok(hex_heads(doc));
    }
    // The editor typed against an older version: replay its text there, then
    // merge, so edits that landed meanwhile survive.
    let base = base
        .iter()
        .map(|h| h.parse::<automerge::ChangeHash>().map_err(super::crdt))
        .collect::<Result<Vec<_>>>()?;
    let mut fork = doc.fork_at(&base).map_err(super::crdt)?;
    put(&mut fork)?;
    let own = hex_heads(&fork);
    doc.merge(&mut fork).map_err(super::crdt)?;
    Ok(own)
}

impl ShareNode {
    /// Ids of every live doc on disk, hosted or joined.
    pub fn live_ids(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(live_dir(&self.share_dir)) else {
            return Vec::new();
        };
        let mut ids: Vec<String> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == "automerge"))
            .filter_map(|p| Some(p.file_stem()?.to_str()?.to_string()))
            .filter(|id| valid_live_id(id))
            .collect();
        ids.sort();
        ids
    }

    fn register_live(&self) {
        for id in self.live_ids() {
            let loaded = std::fs::read(live_path(&self.share_dir, &id, "automerge"))
                .map_err(ShareError::from)
                .and_then(|bytes| Automerge::load(&bytes).map_err(super::crdt));
            match loaded {
                Ok(doc) => self.inner.register(id, doc),
                Err(e) => tracing::warn!("live doc {id} failed to load, skipped: {e}"),
            }
        }
    }

    fn live_known(&self, id: &str) -> Result<()> {
        if valid_live_id(id) && live_path(&self.share_dir, id, "automerge").is_file() {
            Ok(())
        } else {
            Err(ShareError::NotFound(id.to_string()))
        }
    }

    /// Starts hosting a new live doc seeded with `text`; returns its id.
    pub fn live_host(&self, text: &str) -> Result<String> {
        use automerge::transaction::Transactable;
        let id = format!("live-{}", automerge::ActorId::random().to_hex_string());
        let mut doc = Automerge::new();
        doc.transact(|tx| {
            let obj = tx.put_object(automerge::ROOT, LIVE_TEXT, automerge::ObjType::Text)?;
            tx.splice_text(&obj, 0, 0, text)
        })
        .map_err(|e| super::crdt(e.error))?;
        std::fs::create_dir_all(live_dir(&self.share_dir))?;
        // File first: the access check serves only docs that have one.
        write_atomic(&live_path(&self.share_dir, &id, "automerge"), &doc.save())?;
        self.inner.register(id.clone(), doc);
        Ok(id)
    }

    /// The pasteable ticket for a live doc: minted when hosted here, the
    /// host's own when joined.
    pub fn live_ticket(&self, id: &str) -> Result<String> {
        self.live_known(id)?;
        match std::fs::read_to_string(live_path(&self.share_dir, id, "ticket")) {
            Ok(ticket) => Ok(ticket),
            Err(_) => Ok(self.inner.ticket(id).map_err(net)?.to_string()),
        }
    }

    /// Adopts a live doc from its host's ticket; [`Self::live_dial`] then
    /// connects. Re-joining keeps the local copy. Returns the doc id.
    pub fn live_join(&self, ticket: &ShareTicket) -> Result<String> {
        let id = ticket.project_id();
        if !valid_live_id(id) {
            return Err(ShareError::NotFound(id.to_string()));
        }
        if live_hosted(&self.share_dir, id) {
            return Ok(id.to_string());
        }
        std::fs::create_dir_all(live_dir(&self.share_dir))?;
        let doc_path = live_path(&self.share_dir, id, "automerge");
        if !doc_path.is_file() {
            // Empty until the first sync: the host's text object must arrive
            // before anything is typed, or two rival objects would diverge.
            let doc = Automerge::new();
            write_atomic(&doc_path, &doc.save())?;
            self.inner.register(id, doc);
        }
        write_atomic(
            &live_path(&self.share_dir, id, "ticket"),
            ticket.to_string().as_bytes(),
        )?;
        Ok(id.to_string())
    }

    /// Holds a live session to a joined doc's host until it drops; `Ok(false)`
    /// when the doc is hosted here and there is nobody to dial.
    pub async fn live_dial(&self, id: &str) -> Result<bool> {
        self.live_known(id)?;
        let Ok(raw) = std::fs::read_to_string(live_path(&self.share_dir, id, "ticket")) else {
            return Ok(false);
        };
        let ticket: ShareTicket = raw.trim().parse().map_err(net)?;
        self.inner.live(&ticket).await.map_err(net)?;
        Ok(true)
    }

    /// Stops hosting (or leaves) a live doc and deletes the local copy.
    pub fn live_close(&self, id: &str) -> Result<()> {
        self.live_known(id)?;
        self.inner.unregister(id);
        self.live_saved.lock().unwrap().remove(id);
        for ext in ["automerge", "ticket"] {
            let _ = std::fs::remove_file(live_path(&self.share_dir, id, ext));
        }
        Ok(())
    }

    /// The doc as it stands, without touching it.
    pub fn live_state(&self, id: &str) -> Result<LiveState> {
        self.live_known(id)?;
        let state = self
            .inner
            .read_doc(id, |doc| {
                Ok::<_, ShareError>(LiveState {
                    cursors: self.live_cursors_in(id, doc),
                    ..live_read(doc)?
                })
            })
            .ok_or_else(|| ShareError::NotFound(id.to_string()))??;
        Ok(self.live_stamp(id, state))
    }

    fn live_stamp(&self, id: &str, state: LiveState) -> LiveState {
        LiveState {
            peers: self.inner.live_peers(id),
            hosted: live_hosted(&self.share_dir, id),
            rev: *self.live_rev.borrow(),
            ..state
        }
    }

    /// Peers' selections resolved against `doc` as it stands.
    fn live_cursors_in(&self, id: &str, doc: &Automerge) -> Vec<LiveCursor> {
        use automerge::ReadDoc;
        let Some((obj, text)) = live_text(doc) else {
            return Vec::new();
        };
        let at = |c: &automerge::Cursor| {
            let index = doc.get_cursor_position(&obj, c, None).ok()?;
            Some(index_to_utf16(&text, index))
        };
        let cursors = self.live_cursors.lock().unwrap();
        let mut out: Vec<LiveCursor> = cursors
            .get(id)
            .into_iter()
            .flatten()
            .filter_map(|(peer, c)| {
                Some(LiveCursor {
                    peer: peer.clone(),
                    anchor: at(&c.anchor)?,
                    focus: at(&c.focus)?,
                })
            })
            .collect();
        out.sort_by(|a, b| a.peer.cmp(&b.peer));
        out
    }

    /// Tells live peers where this editor's selection is (UTF-16 offsets into
    /// the doc's text), or that it has none.
    pub fn live_set_cursor(&self, id: &str, selection: Option<(u32, u32)>) -> Result<()> {
        use automerge::ReadDoc;
        self.live_known(id)?;
        let ends = selection.and_then(|(anchor, focus)| {
            self.inner.read_doc(id, |doc| {
                let (obj, text) = live_text(doc)?;
                let pin = |utf16: u32| {
                    let index = utf16_to_index(&text, utf16);
                    let position = if index >= text.chars().count() {
                        automerge::CursorPosition::End
                    } else {
                        automerge::CursorPosition::Index(index)
                    };
                    Some(doc.get_cursor(&obj, position, None).ok()?.to_string())
                };
                Some((pin(anchor)?, pin(focus)?))
            })?
        });
        let wire = CursorWire {
            peer: self.endpoint_id(),
            anchor: ends.as_ref().map(|e| e.0.clone()),
            focus: ends.map(|e| e.1),
        };
        self.inner
            .live_send(id, serde_json::to_vec(&wire).map_err(super::crdt)?);
        Ok(())
    }

    /// Ephemeral messages crossing this node; feed them to
    /// [`Self::live_cursor_received`].
    pub fn live_messages(&self) -> tokio::sync::broadcast::Receiver<linxiv_p2p::LiveMessage> {
        self.inner.live_messages()
    }

    /// Records a peer's selection from its ephemeral message. Junk is ignored:
    /// the sender is an admitted peer, but nothing here is trusted.
    pub fn live_cursor_received(&self, msg: &linxiv_p2p::LiveMessage) {
        if !msg.is_remote() || !valid_live_id(&msg.project_id) {
            return;
        }
        let Ok(wire) = serde_json::from_slice::<CursorWire>(&msg.bytes) else {
            return;
        };
        if wire.peer.is_empty() || wire.peer.len() > 128 || wire.peer == self.endpoint_id() {
            return;
        }
        let parse = |s: Option<String>| automerge::Cursor::try_from(s?).ok();
        let mut cursors = self.live_cursors.lock().unwrap();
        let doc = cursors.entry(msg.project_id.clone()).or_default();
        match (parse(wire.anchor), parse(wire.focus)) {
            (Some(anchor), Some(focus)) => {
                if doc.len() >= MAX_CURSORS && !doc.contains_key(&wire.peer) {
                    return;
                }
                let seen = std::time::Instant::now();
                doc.insert(
                    wire.peer,
                    PeerCursor {
                        anchor,
                        focus,
                        seen,
                    },
                );
            }
            _ => {
                doc.remove(&wire.peer);
            }
        }
        drop(cursors);
        self.live_rev.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Drops selections whose owner went quiet or whose doc has no peers left.
    pub fn live_expire_cursors(&self) {
        let mut cursors = self.live_cursors.lock().unwrap();
        let before: usize = cursors.values().map(|d| d.len()).sum();
        cursors.retain(|id, doc| {
            doc.retain(|_, c| c.seen.elapsed() < CURSOR_TTL);
            !doc.is_empty() && self.inner.live_peers(id) > 0
        });
        let after: usize = cursors.values().map(|d| d.len()).sum();
        drop(cursors);
        if after != before {
            self.live_rev.send_modify(|n| *n = n.wrapping_add(1));
        }
    }

    /// Applies an editor's full `text`, typed on top of version `base`, and
    /// returns the merged doc; live peers get the edit at once.
    pub fn live_edit(&self, id: &str, text: &str, base: &[String]) -> Result<LiveState> {
        self.live_known(id)?;
        let state = self
            .inner
            .with_doc(id, |doc| {
                let own = live_write(doc, text, base)?;
                Ok::<_, ShareError>(LiveState {
                    own,
                    cursors: self.live_cursors_in(id, doc),
                    ..live_read(doc)?
                })
            })
            .ok_or_else(|| ShareError::NotFound(id.to_string()))??;
        Ok(self.live_stamp(id, state))
    }

    /// Resolves once the doc differs from what the editor last saw (`heads`,
    /// `peers`, cursor `rev`), or after `timeout` with the unchanged state.
    pub async fn live_wait(
        &self,
        id: &str,
        heads: &[String],
        peers: usize,
        rev: u32,
        timeout: std::time::Duration,
    ) -> Result<LiveState> {
        let mut ticks = self.inner.changes();
        let mut revs = self.live_rev.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            ticks.borrow_and_update();
            revs.borrow_and_update();
            let state = self.live_state(id)?;
            if state.heads != heads || state.peers != peers || state.rev != rev {
                return Ok(state);
            }
            let moved = async {
                tokio::select! {
                    r = ticks.changed() => r.is_ok(),
                    r = revs.changed() => r.is_ok(),
                }
            };
            if !matches!(tokio::time::timeout_at(deadline, moved).await, Ok(true)) {
                return Ok(state);
            }
        }
    }

    /// Ticks when any doc on this node may have changed; drives the saver.
    pub fn changes(&self) -> tokio::sync::watch::Receiver<u64> {
        self.inner.changes()
    }

    /// Writes every live doc whose heads moved since its last write.
    pub fn live_save(&self) -> Result<()> {
        for id in self.live_ids() {
            let Some((heads, bytes)) = self
                .inner
                .read_doc(&id, |doc| {
                    let heads = doc.get_heads();
                    let clean = self.live_saved.lock().unwrap().get(&id) == Some(&heads);
                    (!clean).then(|| (heads, doc.save()))
                })
                .flatten()
            else {
                continue;
            };
            // Closed between the listing and here: don't resurrect the file.
            let path = live_path(&self.share_dir, &id, "automerge");
            if path.is_file() {
                write_atomic(&path, &bytes)?;
                self.live_saved.lock().unwrap().insert(id, heads);
            }
        }
        Ok(())
    }
}

/// E2EE sharing over the beelay + keyhive stack. Docs live under
/// `share_dir/e2ee` (hoster) and `share_dir/e2ee/received` (reader mirrors).
#[cfg(feature = "sync-beelay")]
impl ShareNode {
    fn beelay(&self) -> Result<&linxiv_p2p::BeelayNode> {
        self.beelay.as_ref().ok_or_else(|| {
            ShareError::Transport(
                "e2ee sharing unavailable: keyhive auth state failed to load".to_string(),
            )
        })
    }

    /// Publish (or republish) a project as an e2ee share: evolve the doc under
    /// `share_dir/e2ee`, then register/merge in beelay; encrypts at invite/sync.
    pub async fn publish_secure(&self, sp: &SharedProject) -> Result<()> {
        let beelay = self.beelay()?;
        if !valid_share_id(&sp.share_id) {
            return Err(ShareError::NotFound(sp.share_id.clone()));
        }
        let dir = e2ee_dir(&self.share_dir);
        let sp_owned = sp.clone();
        let mut doc = tokio::task::spawn_blocking(move || -> Result<Automerge> {
            save(&dir, &sp_owned)?;
            let bytes = std::fs::read(super::doc_path(&dir, &sp_owned.share_id))?;
            Automerge::load(&bytes).map_err(super::crdt)
        })
        .await
        .map_err(net)??;
        if beelay.auth().doc_id(&sp.share_id).is_some() {
            beelay
                .with_doc(&sp.share_id, |d| d.merge(&mut doc).map(|_| ()))
                .await
                .ok_or_else(|| net("e2ee project missing from beelay registry"))?
                .map_err(super::crdt)?;
        } else {
            beelay
                .create_shared_project(&sp.share_id, doc)
                .await
                .map_err(net)?;
        }
        Ok(())
    }

    /// This device's own keyhive member id — how the hoster itself appears in
    /// a members listing.
    pub fn self_member_id(&self) -> Result<MemberId> {
        Ok(self.beelay()?.auth().member_id())
    }

    /// This device's pasteable membership code (its keyhive contact card,
    /// hex). Give it to a hoster so they can [`ShareNode::invite_member`] you.
    pub async fn member_code(&self) -> Result<String> {
        let card = self.beelay()?.auth().contact_card().await.map_err(net)?;
        Ok(card.iter().map(|b| format!("{b:02x}")).collect())
    }

    /// Grant the device behind `member_code` `role` on an e2ee share and mint
    /// its invite. Returns the member id (the revoke/query_role handle) + invite.
    pub async fn invite_member(
        &self,
        share_id: &str,
        member_code: &str,
        role: Role,
    ) -> Result<(MemberId, String)> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        let beelay = self.beelay()?;
        let card = decode_hex(member_code).ok_or_else(|| net("malformed member code"))?;
        let member = beelay
            .auth()
            .receive_contact_card(&card)
            .await
            .map_err(net)?;
        match beelay
            .auth()
            .query_access(share_id, member)
            .await
            .map_err(net)?
        {
            // Same role already granted: just re-mint the invite string.
            Some(existing) if existing == role => {
                return beelay
                    .invite(share_id, member)
                    .await
                    .map(|invite| (member, invite))
                    .map_err(net);
            }
            Some(_) => {
                return Err(ShareError::RoleConflict);
            }
            None => {}
        }
        beelay
            .auth()
            .add_member(share_id, member, role)
            .await
            .map_err(net)?;
        match beelay.invite(share_id, member).await {
            Ok(invite) => Ok((member, invite)),
            Err(e) => {
                if let Err(re) = beelay.auth().revoke_member(share_id, member).await {
                    let hex = member_id_hex(&member);
                    tracing::warn!(
                        "compensating revoke after failed invite also failed for member {hex}: {re}"
                    );
                    return Err(net(format!(
                        "invite failed: {e}; compensating revoke of member {hex} also failed: {re}; revoke it manually"
                    )));
                }
                Err(net(e))
            }
        }
    }

    /// The member's effective role on an e2ee share; `None` = no access.
    pub async fn query_role(&self, share_id: &str, member: MemberId) -> Result<Option<Role>> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        self.beelay()?
            .auth()
            .query_access(share_id, member)
            .await
            .map_err(net)
    }

    /// Change a member's role. A downgrade rotates the project key (PCS) — re-key
    /// stored blobs afterwards. Dropping the doc's last reader surfaces as
    /// [`ShareError::LastReader`].
    pub async fn set_role(&self, share_id: &str, member: MemberId, role: Role) -> Result<()> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        self.beelay()?
            .auth()
            .set_role(share_id, member, role)
            .await
            .map_err(|e| match e.downcast_ref::<linxiv_p2p::SetRoleError>() {
                Some(linxiv_p2p::SetRoleError::LastReader) => ShareError::LastReader,
                None => net(e),
            })
    }

    /// Revoke a member; the project key rotates (PCS).
    pub async fn revoke(&self, share_id: &str, member: MemberId) -> Result<()> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        self.beelay()?
            .auth()
            .revoke_member(share_id, member)
            .await
            .map_err(net)
    }

    /// Encrypt `bytes` under the share key and serve them as a blob; returns a
    /// pasteable ticket. Size caps are the caller's job (no size before fetch).
    pub async fn store_pdf_blob(&self, share_id: &str, bytes: &[u8]) -> Result<String> {
        self.beelay()?
            .store_blob(share_id, bytes)
            .await
            .map_err(net)
    }

    /// Read + decrypt a blob, fetching it from its host first when not local.
    /// `max_bytes` bounds the transferred/decrypted size (caller's quota).
    pub async fn read_pdf_blob(
        &self,
        share_id: &str,
        ticket: &str,
        max_bytes: u64,
    ) -> Result<Vec<u8>> {
        use linxiv_p2p::beelay::BlobError;
        let beelay = self.beelay()?;
        let classify = |e: linxiv_p2p::AnyError| match e.downcast_ref::<BlobError>() {
            Some(BlobError::Decrypt { .. }) => {
                ShareError::NotFound("access revoked or removed".to_string())
            }
            Some(be @ BlobError::TooLarge) => ShareError::TooLarge(be.to_string()),
            _ => net(e),
        };
        if beelay.has_blob(ticket).await {
            return beelay
                .read_blob(share_id, ticket, max_bytes)
                .await
                .map_err(classify);
        }
        beelay
            .fetch_blob(ticket, max_bytes)
            .await
            .map_err(classify)?;
        beelay
            .read_blob(share_id, ticket, max_bytes)
            .await
            .map_err(classify)
    }

    /// Accept an e2ee invite: adopt the share, sync once, and mirror it under
    /// `share_dir/e2ee/received`. An unreachable host is not an error.
    pub async fn accept_invite(&self, invite: &str) -> Result<AcceptedInvite> {
        let beelay = self.beelay()?;
        // The invite's project id feeds file paths below; reject it first.
        let parsed: linxiv_p2p::ProjectInvite = invite.parse().map_err(net)?;
        if !valid_share_id(parsed.project_id()) {
            return Err(net(format!(
                "invite share_id is unsafe: {:?}",
                parsed.project_id()
            )));
        }
        let share_id = beelay.accept_invite(invite).await.map_err(net)?;
        // Mirror before the first sync so the interval loop retries on failure.
        if let Some(doc) = beelay.doc(&share_id).await {
            // Validate the host-controlled doc-internal share_id BEFORE the
            // mirror lands: a prior failed sync can leave a hostile merge in
            // the in-memory doc. A fresh adopt is empty — nothing to validate.
            if !doc.get_heads().is_empty() {
                let doc_id = doc_share_id(&doc)?;
                if doc_id != share_id {
                    return Err(net(format!(
                        "remote share_id {doc_id:?} does not match invite id {share_id:?}"
                    )));
                }
            }
            let dir = e2ee_received_dir(&self.share_dir);
            let id = share_id.clone();
            tokio::task::spawn_blocking(move || write_doc_bytes(&dir, &id, doc.save()))
                .await
                .map_err(net)??;
        }
        // Host never answered: the adoption is parked, so a sync against the
        // same dead host is pointless; the interval loop finds the placeholder.
        if beelay.join_pending(&share_id) {
            return Ok(AcceptedInvite {
                share_id,
                pending: true,
            });
        }
        self.sync_e2ee(&share_id).await?;
        Ok(AcceptedInvite {
            share_id,
            pending: false,
        })
    }

    /// Sync a received e2ee mirror and persist it under `e2ee/received/`. A hosted
    /// share_id errors (hosted docs update via [`ShareNode::publish_secure`] only);
    /// a host refusal (revoked/removed) surfaces as `NotFound`.
    pub async fn sync_e2ee(&self, share_id: &str) -> Result<E2eeSyncOutcome> {
        let beelay = self.beelay()?;
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        if super::doc_path(&e2ee_dir(&self.share_dir), share_id).is_file() {
            return Err(net(format!(
                "sync_e2ee on hosted share {share_id}: hosted docs update via publish_secure"
            )));
        }
        let outcome: E2eeSyncOutcome = beelay
            .sync_project(share_id)
            .await
            .map_err(|e| match e {
                JoinError::Refused => ShareError::NotFound("access revoked or removed".to_string()),
                JoinError::Other(e) => net(e),
            })?
            .into();
        let doc = beelay
            .doc(share_id)
            .await
            .ok_or_else(|| net("synced doc missing from beelay registry"))?;
        // Nothing decrypted yet — host asleep at join time, or every commit came
        // back no-key (revoked / not yet keyed). Nothing to mirror; the outcome
        // carries the counts and a later pass fills it in, as in accept_invite.
        if doc.get_heads().is_empty() {
            return Ok(outcome);
        }
        // The doc-internal share_id is host-controlled; same check as fetch().
        let doc_id = doc_share_id(&doc)?;
        if doc_id != share_id {
            return Err(net(format!(
                "remote share_id {doc_id:?} does not match invite id {share_id:?}"
            )));
        }
        let dir = e2ee_received_dir(&self.share_dir);
        let id = share_id.to_string();
        tokio::task::spawn_blocking(move || write_doc_bytes(&dir, &id, doc.save()))
            .await
            .map_err(net)??;
        Ok(outcome)
    }

    /// Re-encrypt a hosted e2ee share's whole history under the current epoch —
    /// repairs shares invited before invites did this themselves.
    pub async fn rekey_e2ee(&self, share_id: &str) -> Result<()> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        if !super::doc_path(&e2ee_dir(&self.share_dir), share_id).is_file() {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        self.beelay()?.reseal_project(share_id).await.map_err(net)
    }

    /// Undo a join: drop the beelay registration, cached doc, and parked invite
    /// so a re-accept adopts from scratch. Returns whether beelay had it; the
    /// caller deletes the on-disk mirror.
    pub async fn forget_e2ee(&self, share_id: &str) -> Result<bool> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        if super::doc_path(&e2ee_dir(&self.share_dir), share_id).is_file() {
            return Err(net(format!(
                "forget_e2ee on hosted share {share_id}: unpublish it instead"
            )));
        }
        self.beelay()?.forget_project(share_id).await.map_err(net)
    }

    /// Summaries of locally-published e2ee shares (`share_dir/e2ee`).
    pub fn list_e2ee(share_dir: &Path) -> Result<Vec<crate::SharedSummary>> {
        crate::list_shared(&e2ee_dir(share_dir))
    }

    /// Summaries of received e2ee mirrors (`share_dir/e2ee/received`).
    pub fn list_e2ee_received(share_dir: &Path) -> Result<Vec<crate::SharedSummary>> {
        crate::list_shared(&e2ee_received_dir(share_dir))
    }

    /// Hydrate a received e2ee mirror by id.
    pub fn e2ee_received(share_dir: &Path, share_id: &str) -> Result<SharedProject> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        load(&e2ee_received_dir(share_dir), share_id)
    }
}

// ── distributed admin metadata (co-admin spec) ──────────────────────────────
// Two root props ride the e2ee doc BESIDE the SharedProject fields (a struct
// reconcile only touches its own keys, pinned by lib.rs tests), so membership
// metadata syncs to every member through the ordinary beelay path:
//  - `admin_member`: THE ADMIN's member id (hex). An automerge LWW register,
//    so two concurrent admin transfers converge to exactly one THE ADMIN.
//  - `member_meta`: the shared roster ([`MemberMeta`]), keyed by member id.

#[cfg(feature = "sync-beelay")]
const ADMIN_PROP: &str = "admin_member";
#[cfg(feature = "sync-beelay")]
const MEMBER_META_PROP: &str = "member_meta";
/// `presence`: per-member [`crate::PresenceMeta`], same shape of prop as the roster.
#[cfg(feature = "sync-beelay")]
const PRESENCE_PROP: &str = "presence";

/// The doc's THE-ADMIN marker; `None` on pre-co-admin docs.
#[cfg(feature = "sync-beelay")]
pub fn doc_admin_marker(doc: &Automerge) -> Option<String> {
    autosurgeon::hydrate_path(doc, &automerge::ROOT, [ADMIN_PROP.into()])
        .ok()
        .flatten()
}

/// The doc's shared member roster; empty on pre-co-admin docs.
#[cfg(feature = "sync-beelay")]
pub fn doc_member_meta(doc: &Automerge) -> Vec<crate::MemberMeta> {
    autosurgeon::hydrate_path(doc, &automerge::ROOT, [MEMBER_META_PROP.into()])
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// The doc's presence list; empty on docs nobody has heartbeated into.
#[cfg(feature = "sync-beelay")]
pub fn doc_presence(doc: &Automerge) -> Vec<crate::PresenceMeta> {
    autosurgeon::hydrate_path(doc, &automerge::ROOT, [PRESENCE_PROP.into()])
        .ok()
        .flatten()
        .unwrap_or_default()
}

#[cfg(feature = "sync-beelay")]
fn write_prop<R: autosurgeon::Reconcile>(doc: &mut Automerge, prop: &str, value: R) -> Result<()> {
    let mut tx = doc.transaction();
    autosurgeon::reconcile_prop(&mut tx, automerge::ROOT, prop, value).map_err(super::crdt)?;
    tx.commit();
    Ok(())
}

#[cfg(feature = "sync-beelay")]
impl ShareNode {
    /// THE ADMIN's member id (hex) from the live beelay doc (hosted or
    /// adopted). `None` = pre-co-admin doc, where the hoster is THE ADMIN.
    pub async fn admin_marker(&self, share_id: &str) -> Result<Option<String>> {
        let doc = self.e2ee_doc(share_id).await?;
        Ok(doc_admin_marker(&doc))
    }

    /// Point the THE-ADMIN marker at `member_hex`. The transfer op: powers
    /// travel with the marker, the old admin keeps keyhive Admin (= co-admin).
    pub async fn set_admin_marker(&self, share_id: &str, member_hex: &str) -> Result<()> {
        self.with_e2ee_doc(share_id, |doc| {
            write_prop(doc, ADMIN_PROP, member_hex.to_owned())
        })
        .await
    }

    /// The shared member roster from the live beelay doc.
    pub async fn member_meta(&self, share_id: &str) -> Result<Vec<crate::MemberMeta>> {
        let doc = self.e2ee_doc(share_id).await?;
        Ok(doc_member_meta(&doc))
    }

    /// Insert or update `entry` in the shared roster (matched by member id).
    pub async fn upsert_member_meta(&self, share_id: &str, entry: crate::MemberMeta) -> Result<()> {
        self.with_e2ee_doc(share_id, |doc| {
            let mut list = doc_member_meta(doc);
            match list.iter_mut().find(|m| m.member_id == entry.member_id) {
                Some(m) => *m = entry,
                None => list.push(entry),
            }
            write_prop(doc, MEMBER_META_PROP, list)
        })
        .await
    }

    /// Drop `member_hex` from the shared roster (revoke/remove bookkeeping).
    pub async fn remove_member_meta(&self, share_id: &str, member_hex: &str) -> Result<()> {
        self.with_e2ee_doc(share_id, |doc| {
            let mut list = doc_member_meta(doc);
            list.retain(|m| m.member_id != member_hex);
            write_prop(doc, MEMBER_META_PROP, list)
        })
        .await
    }

    /// The doc's presence list from the live beelay doc.
    pub async fn presence(&self, share_id: &str) -> Result<Vec<crate::PresenceMeta>> {
        let doc = self.e2ee_doc(share_id).await?;
        Ok(doc_presence(&doc))
    }

    // ponytail: heartbeats commit at most once per HEARTBEAT_MIN (~288 sealed
    // commits per member per day in the e2ee history), and viewer writes
    // never land; upgrade: host-observed last_seen at beelay accept.
    /// Insert or update this device's presence entry: `last_seen` = now, and
    /// `reading` replaced when `Some`, kept when `None` (a heartbeat must not
    /// clobber an opted-in reading indicator). Skips the doc write when the
    /// entry was touched within [`HEARTBEAT_MIN`] and `reading` is unchanged.
    pub async fn touch_presence(
        &self,
        share_id: &str,
        reading: Option<Option<String>>,
    ) -> Result<()> {
        let me = member_id_hex(&self.self_member_id()?);
        let now = chrono::Utc::now();
        self.with_e2ee_doc(share_id, |doc| {
            let mut list = doc_presence(doc);
            if !bump_presence(&mut list, me, now, reading) {
                return Ok(());
            }
            write_prop(doc, PRESENCE_PROP, list)
        })
        .await
    }

    /// `source_id`s of the papers in the live beelay doc (hosted or adopted);
    /// hydrates just the ids, never the full subgraph.
    pub async fn e2ee_paper_ids(&self, share_id: &str) -> Result<Vec<String>> {
        #[derive(autosurgeon::Hydrate)]
        struct Id {
            source_id: String,
        }
        let doc = self.e2ee_doc(share_id).await?;
        let ids: Option<Vec<Id>> =
            autosurgeon::hydrate_path(&doc, &automerge::ROOT, ["papers".into()])
                .map_err(super::crdt)?;
        Ok(ids
            .unwrap_or_default()
            .into_iter()
            .map(|i| i.source_id)
            .collect())
    }

    async fn e2ee_doc(&self, share_id: &str) -> Result<Automerge> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        self.beelay()?
            .doc(share_id)
            .await
            .ok_or_else(|| ShareError::NotFound(share_id.to_string()))
    }

    async fn with_e2ee_doc(
        &self,
        share_id: &str,
        f: impl FnOnce(&mut Automerge) -> Result<()>,
    ) -> Result<()> {
        if !valid_share_id(share_id) {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        self.beelay()?
            .with_doc(share_id, f)
            .await
            .ok_or_else(|| ShareError::NotFound(share_id.to_string()))?
    }

    /// Push this device's SQLite edits into a received e2ee doc: union `local`
    /// into the live doc and reconcile. Only an editor/admin should call this —
    /// the host drops a viewer's writes from its scratch core. The next
    /// [`Self::sync_e2ee`] flushes the merged doc to the host.
    pub async fn merge_received_edits(&self, share_id: &str, local: &SharedProject) -> Result<()> {
        self.with_e2ee_doc(share_id, |doc| {
            let mut merged = if doc.get_heads().is_empty() {
                local.clone()
            } else {
                autosurgeon::hydrate(doc).map_err(super::crdt)?
            };
            crate::merge_shared_project(&mut merged, local);
            let mut tx = doc.transaction();
            autosurgeon::reconcile(&mut tx, &merged).map_err(super::crdt)?;
            tx.commit();
            Ok(())
        })
        .await
    }
}

/// Minimum gap between two heartbeat commits for one member; a reading
/// change always writes.
#[cfg(feature = "sync-beelay")]
const HEARTBEAT_MIN: chrono::TimeDelta = chrono::TimeDelta::minutes(5);

/// [`ShareNode::touch_presence`]'s list edit, split out for its unit test.
/// Returns whether the list changed (false: recent heartbeat, same reading).
#[cfg(feature = "sync-beelay")]
fn bump_presence(
    list: &mut Vec<crate::PresenceMeta>,
    me: String,
    now: chrono::DateTime<chrono::Utc>,
    reading: Option<Option<String>>,
) -> bool {
    match list.iter_mut().find(|p| p.member_id == me) {
        Some(p) => {
            let recent = chrono::DateTime::parse_from_rfc3339(&p.last_seen)
                .is_ok_and(|t| now.signed_duration_since(t).abs() < HEARTBEAT_MIN);
            if recent && reading.as_ref().is_none_or(|r| *r == p.reading) {
                return false;
            }
            p.last_seen = now.to_rfc3339();
            if let Some(r) = reading {
                p.reading = r;
            }
        }
        None => list.push(crate::PresenceMeta {
            member_id: me,
            last_seen: now.to_rfc3339(),
            reading: reading.flatten(),
        }),
    }
    true
}

/// The doc-internal `share_id`, hydrated alone — the host-controlled-id guard's
/// one input, so the check never materializes the full SharedProject subgraphs.
#[cfg(feature = "sync-beelay")]
fn doc_share_id(doc: &Automerge) -> Result<String> {
    #[derive(autosurgeon::Hydrate)]
    struct Meta {
        share_id: String,
    }
    let meta: Meta = autosurgeon::hydrate(doc).map_err(super::crdt)?;
    Ok(meta.share_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A heartbeat (`reading: None`) keeps the opted-in indicator; an explicit
    /// `Some(None)` clears it; the prop rides beside the project fields.
    /// Heartbeats inside `HEARTBEAT_MIN` are skipped unless the reading changes.
    #[cfg(feature = "sync-beelay")]
    #[test]
    fn presence_heartbeat_keeps_reading() {
        let t1 = chrono::Utc::now();
        let t2 = t1 + HEARTBEAT_MIN * 2;
        let t3 = t2 + chrono::TimeDelta::seconds(30);
        let mut doc = Automerge::new();
        let mut list = doc_presence(&doc);
        assert!(bump_presence(
            &mut list,
            "a".into(),
            t1,
            Some(Some("p1".into()))
        ));
        // stale heartbeat: written
        assert!(bump_presence(&mut list, "a".into(), t2, None));
        assert!(bump_presence(&mut list, "b".into(), t2, None));
        // recent heartbeat, same reading: skipped (both None and Some(same))
        assert!(!bump_presence(&mut list, "a".into(), t3, None));
        assert!(!bump_presence(
            &mut list,
            "a".into(),
            t3,
            Some(Some("p1".into()))
        ));
        write_prop(&mut doc, PRESENCE_PROP, list).unwrap();
        let got = doc_presence(&doc);
        assert_eq!(got.len(), 2);
        assert_eq!(
            (got[0].last_seen.as_str(), got[0].reading.as_deref()),
            (t2.to_rfc3339().as_str(), Some("p1"))
        );
        assert_eq!(got[1].reading, None);
        // recent but reading changed: written
        let mut list = got;
        assert!(bump_presence(&mut list, "a".into(), t3, Some(None)));
        assert_eq!(
            (list[0].last_seen.as_str(), list[0].reading.as_deref()),
            (t3.to_rfc3339().as_str(), None)
        );
        assert!(doc_member_meta(&doc).is_empty());
    }

    fn sample(share_id: &str, name: &str) -> SharedProject {
        SharedProject {
            share_id: share_id.into(),
            name: name.into(),
            description: "desc".into(),
            color: Some(0x00ff00),
            tags: vec!["RL".into(), "Robotics".into()],
            papers: vec![crate::SharedPaper {
                source_id: "arxiv:1".into(),
                version: 1,
                title: "First".into(),
                summary: "s".into(),
                authors: vec!["Alice".into()],
                author_orcids: vec![],
                tags: vec!["ml".into()],
                published: None,
                pdf_blob: None,
            }],
            notes: vec![crate::SharedNote {
                uuid: "11111111-1111-4111-8111-111111111111".into(),
                paper_source_id: Some("arxiv:1".into()),
                title: "n".into(),
                body: "b".into(),
                created_at: None,
                updated_at: None,
            }],
            annotations: vec![crate::SharedAnnotation {
                uuid: "22222222-2222-4222-8222-222222222222".into(),
                paper_source_id: "arxiv:1".into(),
                anchor: "{}".into(),
                comment: "c".into(),
                created_at: None,
                updated_at: None,
            }],
        }
    }

    async fn node(dir: &Path) -> ShareNode {
        ShareNode::bind_offline(dir, &dir.join("p2p"))
            .await
            .unwrap()
    }

    async fn with_timeout<T>(fut: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(10), fut)
            .await
            .expect("p2p op should not hang on loopback")
    }

    // Real endpoint<->endpoint QUIC over loopback: A publishes + tickets, B
    // fetches into received/ and the mirror hydrates + lists.
    #[tokio::test(flavor = "multi_thread")]
    async fn loopback_fetch_matches_sender() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let a = node(a_dir.path()).await;
        let b = node(b_dir.path()).await;

        let sp = sample("7", "My Project");
        save(a_dir.path(), &sp).unwrap();
        let ticket = with_timeout(a.ticket("7")).await.unwrap();
        // Ticket round-trips through its pasteable string form.
        let ticket: ShareTicket = ticket.to_string().parse().unwrap();

        let got = with_timeout(b.fetch(&ticket, b_dir.path())).await.unwrap();
        assert_eq!(got, sp);
        assert!(b_dir.path().join("received").join("7.automerge").is_file());
        assert_eq!(ShareNode::received(b_dir.path(), "7").unwrap(), sp);
        let listed = ShareNode::list_received(b_dir.path()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].share_id, "7");

        a.shutdown().await.unwrap();
        b.shutdown().await.unwrap();
    }

    // The sync tick's save + register_doc path (no refresh re-read) must serve
    // the updated doc: B's second fetch with the original ticket sees the edit.
    #[tokio::test(flavor = "multi_thread")]
    async fn register_doc_serves_the_updated_doc() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let a = node(a_dir.path()).await;
        let b = node(b_dir.path()).await;

        save(a_dir.path(), &sample("7", "Before")).unwrap();
        let ticket = with_timeout(a.ticket("7")).await.unwrap();
        with_timeout(b.fetch(&ticket, b_dir.path())).await.unwrap();

        let after = sample("7", "After");
        let doc = save(a_dir.path(), &after).unwrap();
        a.register_doc("7", doc).unwrap();

        let got = with_timeout(b.fetch(&ticket, b_dir.path())).await.unwrap();
        assert_eq!(got, after);

        a.shutdown().await.unwrap();
        b.shutdown().await.unwrap();
    }

    // A ticket for a share the host no longer publishes must surface as NotFound
    // on the joining side, and never clobber a same-id local publish.
    #[tokio::test(flavor = "multi_thread")]
    async fn revoked_share_join_is_not_found() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let a = node(a_dir.path()).await;
        let b = node(b_dir.path()).await;

        save(a_dir.path(), &sample("7", "Sender Project")).unwrap();
        let local = sample("7", "My Local Project");
        save(b_dir.path(), &local).unwrap();

        let ticket = with_timeout(a.ticket("7")).await.unwrap();
        // Unpublish: the access check now refuses id "7".
        std::fs::remove_file(a_dir.path().join("7.automerge")).unwrap();

        let result = with_timeout(b.fetch(&ticket, b_dir.path())).await;
        assert!(
            matches!(result, Err(ShareError::NotFound(_))),
            "refused share must surface as NotFound, got {result:?}"
        );
        assert_eq!(crate::load(b_dir.path(), "7").unwrap(), local);

        a.shutdown().await.unwrap();
        b.shutdown().await.unwrap();
    }

    // Quarantine: B's received mirror of A's share must not be re-servable — a
    // third node fetching from B with A's share id gets refused.
    #[tokio::test(flavor = "multi_thread")]
    async fn received_mirror_is_not_reserved() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let c_dir = tempfile::tempdir().unwrap();
        let a = node(a_dir.path()).await;
        let b = node(b_dir.path()).await;
        let c = node(c_dir.path()).await;

        save(a_dir.path(), &sample("7", "A's Project")).unwrap();
        let ticket = with_timeout(a.ticket("7")).await.unwrap();
        with_timeout(b.fetch(&ticket, b_dir.path())).await.unwrap();
        // B now holds "7" in its p2p registry and as a received/ mirror.

        // B publishes its own "8" so we can learn B's dialable address.
        save(b_dir.path(), &sample("8", "B's Project")).unwrap();
        let b_ticket = with_timeout(b.ticket("8")).await.unwrap();
        let evil = ShareTicket::new(b_ticket.endpoint_addr().clone(), "7");

        let result = with_timeout(c.fetch(&evil, c_dir.path())).await;
        assert!(
            matches!(result, Err(ShareError::NotFound(_))),
            "a received mirror must not be re-served, got {result:?}"
        );
        assert!(!c_dir.path().join("received").join("7.automerge").exists());

        a.shutdown().await.unwrap();
        b.shutdown().await.unwrap();
        c.shutdown().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ticket_for_unpublished_id_errors() {
        let dir = tempfile::tempdir().unwrap();
        let n = node(dir.path()).await;
        let result = with_timeout(n.ticket("nope")).await;
        assert!(
            matches!(result, Err(ShareError::NotFound(_))),
            "unpublished id must not mint a ticket, got {result:?}"
        );
        n.shutdown().await.unwrap();
    }

    // A malicious host serves a doc whose INTERNAL share_id is a traversal path.
    // fetch() must reject it before the mirror write, leaving no `evil` file.
    #[tokio::test(flavor = "multi_thread")]
    async fn malicious_share_id_is_rejected_no_write() {
        let a_dir = tempfile::tempdir().unwrap();
        let b_dir = tempfile::tempdir().unwrap();
        let a = node(a_dir.path()).await;
        let b = node(b_dir.path()).await;

        // Doc filename is the safe "7"; the share_id FIELD inside is a traversal.
        let mut evil = sample("7", "Evil");
        evil.share_id = "../evil".into();
        let mut doc = automerge::AutoCommit::new();
        autosurgeon::reconcile(&mut doc, &evil).unwrap();
        std::fs::write(a_dir.path().join("7.automerge"), doc.save()).unwrap();

        let ticket = with_timeout(a.ticket("7")).await.unwrap();
        let result = with_timeout(b.fetch(&ticket, b_dir.path())).await;
        assert!(
            matches!(result, Err(ShareError::Transport(_))),
            "malicious share_id must be rejected, got {result:?}"
        );
        assert!(!b_dir.path().join("evil.automerge").exists());
        assert!(!b_dir
            .path()
            .join("received")
            .join("evil.automerge")
            .exists());

        a.shutdown().await.unwrap();
        b.shutdown().await.unwrap();
    }

    #[cfg(feature = "sync-beelay")]
    mod live {
        use super::*;

        /// The next ephemeral message a peer sent.
        async fn next_remote(
            inbox: &mut tokio::sync::broadcast::Receiver<linxiv_p2p::LiveMessage>,
        ) -> linxiv_p2p::LiveMessage {
            loop {
                let m = with_timeout(inbox.recv()).await.unwrap();
                if m.is_remote() {
                    return m;
                }
            }
        }

        /// Text of `doc` as of `heads`.
        fn text_at(doc: &Automerge, heads: &[String]) -> String {
            let heads: Vec<automerge::ChangeHash> =
                heads.iter().map(|h| h.parse().unwrap()).collect();
            live_read(&doc.fork_at(&heads).unwrap()).unwrap().text
        }

        #[test]
        fn stale_editor_text_merges_instead_of_clobbering() {
            use automerge::transaction::Transactable;
            let mut doc = Automerge::new();
            doc.transact(|tx| {
                let obj = tx.put_object(automerge::ROOT, LIVE_TEXT, automerge::ObjType::Text)?;
                tx.splice_text(&obj, 0, 0, "hello")
            })
            .unwrap();
            let base = hex_heads(&doc);

            // A peer's edit lands while the editor still shows `base`.
            let mut peer = doc.fork();
            live_write(&mut peer, "hello world", &base).unwrap();
            doc.merge(&mut peer).unwrap();

            let own = live_write(&mut doc, "hello!", &base).unwrap();
            assert_eq!(text_at(&doc, &own), "hello!");
            let merged = live_read(&doc).unwrap();
            assert!(merged.ready);
            assert!(
                merged.text.contains('!') && merged.text.contains(" world"),
                "{}",
                merged.text
            );

            // Typing on from `own` adds only the new keystroke: nothing replays.
            live_write(&mut doc, "hello!?", &own).unwrap();
            let text = live_read(&doc).unwrap().text;
            assert_eq!(text.matches("hello").count(), 1, "{text}");
            assert_eq!(text.matches('!').count(), 1, "{text}");
            assert!(text.contains('?') && text.contains(" world"), "{text}");

            // Same text on current heads is a no-op, not an empty change.
            let heads = hex_heads(&doc);
            assert_eq!(live_write(&mut doc, &text, &heads).unwrap(), heads);
        }

        #[tokio::test]
        async fn host_join_edit_save_close_over_loopback() {
            let (a_dir, b_dir) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
            let a = Arc::new(node(a_dir.path()).await);
            let b = Arc::new(node(b_dir.path()).await);

            let id = a.live_host("hi").unwrap();
            assert!(!valid_share_id(&id) || valid_live_id(&id));
            let ticket: ShareTicket = a.live_ticket(&id).unwrap().parse().unwrap();
            assert_eq!(b.live_join(&ticket).unwrap(), id);
            assert!(!b.live_state(&id).unwrap().ready);
            // The joiner hands out the host's ticket, not one for itself.
            assert_eq!(b.live_ticket(&id).unwrap(), ticket.to_string());

            let dial = tokio::spawn({
                let (b, id) = (b.clone(), id.clone());
                async move { b.live_dial(&id).await }
            });
            let wait = std::time::Duration::from_secs(10);
            let got = b.live_wait(&id, &[], 0, 0, wait).await.unwrap();
            let got = if got.ready {
                got
            } else {
                b.live_wait(&id, &[], got.peers, 0, wait).await.unwrap()
            };
            assert_eq!((got.ready, got.text.as_str()), (true, "hi"));

            // The joiner types; the host's waiting editor wakes with the edit.
            let seen = a.live_state(&id).unwrap();
            b.live_edit(&id, "hi there", &got.heads).unwrap();
            let mut woke = a
                .live_wait(&id, &seen.heads, seen.peers, seen.rev, wait)
                .await
                .unwrap();
            if woke.heads == seen.heads {
                woke = a
                    .live_wait(&id, &seen.heads, woke.peers, woke.rev, wait)
                    .await
                    .unwrap();
            }
            assert_eq!(woke.text, "hi there");
            assert!(woke.hosted && woke.peers == 1);

            // The joiner's selection shows up on the host and tracks the text:
            // an astral char typed before it shifts its UTF-16 offsets by two.
            let mut inbox = a.live_messages();
            b.live_set_cursor(&id, Some((3, 8))).unwrap();
            a.live_cursor_received(&next_remote(&mut inbox).await);
            let seen = a.live_state(&id).unwrap();
            assert_eq!(seen.rev, woke.rev.wrapping_add(1));
            let want = |anchor, focus| LiveCursor {
                peer: b.endpoint_id(),
                anchor,
                focus,
            };
            assert_eq!(seen.cursors, vec![want(3, 8)]);
            let woke = a.live_edit(&id, "\u{1F600}hi there", &seen.heads).unwrap();
            assert_eq!(woke.cursors, vec![want(5, 10)]);
            // Junk changes nothing; a cleared selection disappears.
            b.inner
                .live_send(&id, b"{\"peer\":\"x\",\"anchor\":7}".to_vec());
            a.live_cursor_received(&next_remote(&mut inbox).await);
            assert_eq!(a.live_state(&id).unwrap().cursors, vec![want(5, 10)]);
            b.live_set_cursor(&id, None).unwrap();
            a.live_cursor_received(&next_remote(&mut inbox).await);
            assert!(a.live_state(&id).unwrap().cursors.is_empty());

            // Saved docs survive a restart of the host.
            a.live_save().unwrap();
            let bytes = std::fs::read(live_path(a_dir.path(), &id, "automerge")).unwrap();
            assert_eq!(
                live_read(&Automerge::load(&bytes).unwrap()).unwrap().text,
                woke.text
            );

            // A live ticket for anything but a hosted live doc is refused:
            // the joined copy on b, and a plain share's id.
            for (dialer, host, bad) in [(&a, &b, id.as_str()), (&b, &a, "7")] {
                let forged = ShareTicket::new(
                    host.inner
                        .ticket(&id)
                        .map(|t| t.endpoint_addr().clone())
                        .unwrap(),
                    bad,
                );
                let err = with_timeout(dialer.inner.live(&forged)).await.unwrap_err();
                assert!(matches!(err, JoinError::Refused), "{bad}: {err}");
            }

            // Closing ends the joiner's session; the id is gone on the host.
            a.live_close(&id).unwrap();
            assert!(with_timeout(dial).await.unwrap().is_err());
            assert!(matches!(a.live_state(&id), Err(ShareError::NotFound(_))));
            assert!(a.live_ids().is_empty());
            assert_eq!(b.live_ids(), vec![id]);
        }
    }

    mod admin_meta {
        use super::*;
        use crate::MemberMeta;

        fn meta(id: &str) -> MemberMeta {
            MemberMeta {
                member_id: id.into(),
                name: Some(format!("dev-{id}")),
                invited_at: "2026-09-13T00:00:00Z".into(),
                invited_by: None,
            }
        }

        // The marker/roster props ride BESIDE the SharedProject fields; a
        // publish's struct reconcile must not clobber them.
        #[test]
        fn admin_props_survive_project_reconcile() {
            let mut doc = Automerge::new();
            write_prop(&mut doc, ADMIN_PROP, "aa".repeat(32)).unwrap();
            write_prop(&mut doc, MEMBER_META_PROP, vec![meta("bb")]).unwrap();

            let mut tx = doc.transaction();
            autosurgeon::reconcile(&mut tx, sample("7", "P")).unwrap();
            tx.commit();

            assert_eq!(doc_admin_marker(&doc), Some("aa".repeat(32)));
            assert_eq!(doc_member_meta(&doc), vec![meta("bb")]);
            let sp: SharedProject = autosurgeon::hydrate(&doc).unwrap();
            assert_eq!(sp.name, "P");
        }

        // Two concurrent transfers are two writes to one LWW register: both
        // merge orders converge on the SAME single winner.
        #[test]
        fn concurrent_transfers_converge_to_one_admin() {
            let mut a = Automerge::new();
            write_prop(&mut a, ADMIN_PROP, "aa".to_string()).unwrap();
            let mut b = a.fork();
            write_prop(&mut a, ADMIN_PROP, "bb".to_string()).unwrap();
            write_prop(&mut b, ADMIN_PROP, "cc".to_string()).unwrap();

            a.merge(&mut b).unwrap();
            b.merge(&mut a).unwrap();

            let winner = doc_admin_marker(&a).unwrap();
            assert_eq!(doc_admin_marker(&b), Some(winner.clone()));
            assert!(winner == "bb" || winner == "cc", "winner={winner}");
        }

        // Concurrent roster edits (two admins inviting different members)
        // keep both entries — the list is keyed by member id.
        #[test]
        fn concurrent_roster_inserts_both_survive() {
            let mut a = Automerge::new();
            write_prop(&mut a, MEMBER_META_PROP, vec![meta("host")]).unwrap();
            let mut b = a.fork();
            write_prop(&mut a, MEMBER_META_PROP, vec![meta("host"), meta("x")]).unwrap();
            write_prop(&mut b, MEMBER_META_PROP, vec![meta("host"), meta("y")]).unwrap();

            a.merge(&mut b).unwrap();
            let ids: std::collections::BTreeSet<String> = doc_member_meta(&a)
                .into_iter()
                .map(|m| m.member_id)
                .collect();
            assert!(ids.contains("x") && ids.contains("y"), "{ids:?}");
        }
    }

    #[cfg(feature = "sync-beelay")]
    mod e2ee {
        use super::*;

        // keyhive/BeeKEM ops are slow in debug builds; give e2ee flows more
        // room than the 10s plain-loopback budget.
        async fn slow<T>(fut: impl std::future::Future<Output = T>) -> T {
            tokio::time::timeout(Duration::from_secs(60), fut)
                .await
                .expect("e2ee op should not hang on loopback")
        }

        // publish_secure -> member_code -> invite_member -> accept_invite on
        // a second node, returning the reader's member id on the hoster.
        async fn share_to(a: &ShareNode, b: &ShareNode, sp: &SharedProject) -> MemberId {
            a.publish_secure(sp).await.unwrap();
            let code = b.member_code().await.unwrap();
            let (member, invite) = a
                .invite_member(&sp.share_id, &code, Role::Read)
                .await
                .unwrap();
            let accepted = slow(b.accept_invite(&invite)).await.unwrap();
            assert_eq!(accepted.share_id, sp.share_id);
            // both nodes are live here: the join must complete, not park
            assert!(!accepted.pending, "loopback accept should not be pending");
            member
        }

        // Pasting an invite whose host is asleep is a success, not an error: the
        // invite parks and a placeholder mirror lands for the interval loop. It
        // stays out of the received listing until the first sync fills it in
        // (list_shared skips a mirror whose hydrated id != its filename).
        #[tokio::test(flavor = "multi_thread")]
        async fn offline_invite_accept_is_pending_not_an_error() {
            let a_dir = tempfile::tempdir().unwrap();
            let b_dir = tempfile::tempdir().unwrap();
            let a = node(a_dir.path()).await;
            let b = node(b_dir.path()).await;

            let sp = sample("7", "Asleep Host");
            a.publish_secure(&sp).await.unwrap();
            let code = b.member_code().await.unwrap();
            let (_member, invite) = a.invite_member("7", &code, Role::Read).await.unwrap();
            a.shutdown().await.unwrap();

            let accepted = slow(b.accept_invite(&invite)).await.unwrap();
            assert_eq!(accepted.share_id, "7");
            assert!(accepted.pending, "an unreachable host must report pending");

            // placeholder mirror exists so the sync loop can find it again...
            assert!(b_dir.path().join("e2ee/received/7.automerge").is_file());
            // ...but it carries no content yet, so it is not listed
            assert!(
                ShareNode::list_e2ee_received(b_dir.path())
                    .unwrap()
                    .is_empty(),
                "a pending share should not surface as a joined one"
            );

            b.shutdown().await.unwrap();
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn publish_invite_accept_materializes_reader_mirror() {
            let a_dir = tempfile::tempdir().unwrap();
            let b_dir = tempfile::tempdir().unwrap();
            let a = node(a_dir.path()).await;
            let b = node(b_dir.path()).await;

            let sp = sample("7", "Secret Project");
            let member = share_to(&a, &b, &sp).await;

            // reader mirror lives under e2ee/received and matches the content
            assert!(b_dir.path().join("e2ee/received/7.automerge").is_file());
            assert_eq!(ShareNode::e2ee_received(b_dir.path(), "7").unwrap(), sp);
            let listed = ShareNode::list_e2ee_received(b_dir.path()).unwrap();
            assert_eq!(listed.len(), 1);
            assert_eq!(listed[0].share_id, "7");
            assert_eq!(ShareNode::list_e2ee(a_dir.path()).unwrap().len(), 1);
            assert_eq!(a.query_role("7", member).await.unwrap(), Some(Role::Read));

            // plain top-level dirs untouched on both sides
            assert!(!a_dir.path().join("7.automerge").exists());
            assert!(!b_dir.path().join("7.automerge").exists());
            assert!(!b_dir.path().join("received").exists());

            a.shutdown().await.unwrap();
            b.shutdown().await.unwrap();
        }

        #[tokio::test(flavor = "multi_thread")]
        async fn revoked_reader_sync_errors_and_mirror_is_intact() {
            let a_dir = tempfile::tempdir().unwrap();
            let b_dir = tempfile::tempdir().unwrap();
            let a = node(a_dir.path()).await;
            let b = node(b_dir.path()).await;

            let sp = sample("7", "Secret Project");
            let member = share_to(&a, &b, &sp).await;

            a.revoke("7", member).await.unwrap();
            assert_eq!(a.query_role("7", member).await.unwrap(), None);
            // hoster evolves the share after the revoke
            let mut evolved = sp.clone();
            evolved.tags.push("post-revoke".into());
            a.publish_secure(&evolved).await.unwrap();

            let result = slow(b.sync_e2ee("7")).await;
            assert!(
                matches!(&result, Err(ShareError::NotFound(m)) if m.contains("revoked")),
                "revoked sync must surface as a revocation, got {result:?}"
            );
            // old mirror content intact, no post-revoke content gained
            assert_eq!(ShareNode::e2ee_received(b_dir.path(), "7").unwrap(), sp);

            a.shutdown().await.unwrap();
            b.shutdown().await.unwrap();
        }

        // §3.4: set_role transitions Read→Edit→Read; query_role is the truth.
        #[tokio::test(flavor = "multi_thread")]
        async fn set_role_upgrades_and_downgrades() {
            let a_dir = tempfile::tempdir().unwrap();
            let b_dir = tempfile::tempdir().unwrap();
            let a = node(a_dir.path()).await;
            let b = node(b_dir.path()).await;

            let sp = sample("7", "Secret Project");
            let member = share_to(&a, &b, &sp).await;
            assert_eq!(a.query_role("7", member).await.unwrap(), Some(Role::Read));

            slow(a.set_role("7", member, Role::Edit)).await.unwrap();
            assert_eq!(a.query_role("7", member).await.unwrap(), Some(Role::Edit));

            slow(a.set_role("7", member, Role::Read)).await.unwrap();
            assert_eq!(a.query_role("7", member).await.unwrap(), Some(Role::Read));

            a.shutdown().await.unwrap();
            b.shutdown().await.unwrap();
        }

        // §6 validate-before-persist: a doc whose INTERNAL share_id mismatches
        // the invite id must never reach the reader's mirror — not on the first
        // sync (sync_e2ee validates) nor on a re-accept of the poisoned doc.
        #[tokio::test(flavor = "multi_thread")]
        async fn hostile_share_id_never_persisted_on_accept() {
            let a_dir = tempfile::tempdir().unwrap();
            let b_dir = tempfile::tempdir().unwrap();
            let a = node(a_dir.path()).await;
            let b = node(b_dir.path()).await;

            let sp = sample("7", "Evil Host");
            a.publish_secure(&sp).await.unwrap();
            // Swap the doc-internal share_id before the invite (invite
            // flushes/encrypts pending changes, so the reader will fetch it).
            let mut evil = sp.clone();
            evil.share_id = "8".into();
            a.beelay
                .as_ref()
                .unwrap()
                .with_doc("7", |d| {
                    let mut tx = d.transaction();
                    autosurgeon::reconcile(&mut tx, &evil).unwrap();
                    tx.commit();
                })
                .await
                .unwrap();
            let code = b.member_code().await.unwrap();
            let (_member, invite) = a.invite_member("7", &code, Role::Read).await.unwrap();

            // First accept: the initial sync pulls the hostile doc → error.
            let r1 = slow(b.accept_invite(&invite)).await;
            assert!(
                matches!(&r1, Err(ShareError::Transport(m)) if m.contains("does not match")),
                "hostile doc must error the accept, got {r1:?}"
            );
            // Re-accept: the hostile merge now sits in the in-memory doc;
            // the pre-persist validation must refuse to park it.
            let r2 = slow(b.accept_invite(&invite)).await;
            assert!(
                matches!(&r2, Err(ShareError::Transport(m)) if m.contains("does not match")),
                "re-accept must not persist the hostile doc, got {r2:?}"
            );
            // Whatever is on disk, it is never the hostile doc.
            match ShareNode::e2ee_received(b_dir.path(), "7") {
                Err(_) => {}
                Ok(mirror) => assert_ne!(mirror.share_id, "8", "hostile doc landed in the mirror"),
            }

            a.shutdown().await.unwrap();
            b.shutdown().await.unwrap();
        }

        // Quarantine: an e2ee doc is invisible to the plain sync path — a
        // plain ticket forged for its id gets refused and writes nothing.
        #[tokio::test(flavor = "multi_thread")]
        async fn e2ee_doc_is_never_served_by_plain_path() {
            let a_dir = tempfile::tempdir().unwrap();
            let b_dir = tempfile::tempdir().unwrap();
            let a = node(a_dir.path()).await;
            let b = node(b_dir.path()).await;

            a.publish_secure(&sample("7", "Secret")).await.unwrap();
            // publish a plain "8" only to learn a's dialable address
            save(a_dir.path(), &sample("8", "Public")).unwrap();
            let ticket = with_timeout(a.ticket("8")).await.unwrap();
            let evil = ShareTicket::new(ticket.endpoint_addr().clone(), "7");

            let result = with_timeout(b.fetch(&evil, b_dir.path())).await;
            assert!(
                matches!(result, Err(ShareError::NotFound(_))),
                "an e2ee doc must not be plain-fetchable, got {result:?}"
            );
            assert!(!b_dir.path().join("received").join("7.automerge").exists());

            a.shutdown().await.unwrap();
            b.shutdown().await.unwrap();
        }
    }
}
