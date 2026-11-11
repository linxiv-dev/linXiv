//! Encrypted live docs: a live doc whose text only the members of an e2ee
//! share can read.
//!
//! What the node serves on the live pipe for such a doc is a placeholder
//! holding one field, the share it belongs to. The text lives in a
//! [`SecureLive`] engine and crosses the pipe only as sealed frames on the
//! relay lane, so a ticket holder who is not a member gets ciphertext, and so
//! does the host if it is only relaying. Roles come from the share: editors
//! type, viewers follow.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use automerge::{Automerge, ReadDoc};
use linxiv_p2p::live_seal::{is_sealed, open_at_rest, seal_at_rest};
use linxiv_p2p::live_secure::{Event, SecureLive};
use linxiv_p2p::{LiveMessage, Role};

use super::{
    live_dir, live_path, member_id_hex, net, valid_live_id, write_atomic, CursorWire, Result,
    ShareNode, LIVE_TEXT,
};
use crate::ShareError;

/// Root field of the placeholder doc, naming the e2ee share.
const SECURE_KEY: &str = "secure";
/// How often a member re-announces itself while anyone is connected.
const HELLO_EVERY: Duration = Duration::from_secs(20);

/// One encrypted live doc on this device.
pub(super) struct SecureDoc {
    pub(super) live: SecureLive,
    /// Local edits not yet offered to peers.
    dirty: AtomicBool,
    /// Ephemeral payloads (cursors) waiting to be sealed and sent.
    outbox: Mutex<Vec<Vec<u8>>>,
    hello: Mutex<Option<Instant>>,
    /// This device's role on the share, as of the last pump pass. The outer
    /// `None` means not looked up yet.
    role: Mutex<Option<Option<Role>>>,
    saved: Mutex<Option<Vec<automerge::ChangeHash>>>,
}

impl SecureDoc {
    fn new(live: SecureLive) -> Self {
        Self {
            live,
            dirty: AtomicBool::new(false),
            outbox: Mutex::default(),
            hello: Mutex::default(),
            role: Mutex::default(),
            saved: Mutex::default(),
        }
    }

    /// May this device type? False until the role is known.
    pub(super) fn can_edit(&self) -> bool {
        matches!(*self.role.lock().unwrap(), Some(Some(role)) if role >= Role::Edit)
    }

    /// Known to have no role on the share: the doc will never open here.
    pub(super) fn denied(&self) -> bool {
        matches!(*self.role.lock().unwrap(), Some(None))
    }

    pub(super) fn touched(&self) {
        self.dirty.store(true, Ordering::Release);
    }

    pub(super) fn queue(&self, ephemeral: Vec<u8>) {
        self.outbox.lock().unwrap().push(ephemeral);
    }
}

pub(super) type SecureDocs = Mutex<HashMap<String, Arc<SecureDoc>>>;

/// The share an encrypted live doc's placeholder names, if it is one.
fn marker(doc: &Automerge) -> Option<String> {
    let (value, _) = doc.get(automerge::ROOT, SECURE_KEY).ok()??;
    value.into_string().ok()
}

impl ShareNode {
    /// The engine for an encrypted live doc, created on first use from the
    /// placeholder (and the saved copy, if any). `None` for a plain doc.
    pub(super) fn secure_doc(&self, id: &str) -> Option<Arc<SecureDoc>> {
        let identity = self.auth_identity.as_ref()?;
        let mut docs = self.secure.lock().unwrap();
        if let Some(doc) = docs.get(id) {
            return Some(doc.clone());
        }
        if !valid_live_id(id) {
            return None;
        }
        let share = self.inner.read_doc(id, marker)??;
        let saved = std::fs::read(live_path(&self.share_dir, id, "sdoc"))
            .ok()
            .and_then(|bytes| self.unseal_doc(&bytes))
            .and_then(|bytes| Automerge::load(&bytes).ok());
        let doc = Arc::new(SecureDoc::new(SecureLive::new(
            identity,
            &share,
            id,
            saved.unwrap_or_default(),
        )));
        docs.insert(id.to_string(), doc.clone());
        drop(docs);
        // Have the pump introduce us.
        self.secure_wake.notify_one();
        Some(doc)
    }

    pub(super) fn seal_doc(&self, plain: &[u8]) -> Vec<u8> {
        match &self.dek {
            Some(dek) => [&[1u8][..], &seal_at_rest(dek, plain)].concat(),
            // No key store key on this device: same posture as its key files.
            None => [&[0u8][..], plain].concat(),
        }
    }

    pub(super) fn unseal_doc(&self, bytes: &[u8]) -> Option<Vec<u8>> {
        match bytes.split_first()? {
            (0, plain) => Some(plain.to_vec()),
            (1, sealed) => open_at_rest(self.dek.as_ref()?, sealed),
            _ => None,
        }
    }

    /// Starts hosting an encrypted live doc for the members of e2ee share
    /// `share_id`, seeded with `text`. Returns its id.
    pub fn live_host_secure(&self, share_id: &str, text: &str) -> Result<String> {
        use automerge::transaction::Transactable;
        let known = self.beelay()?.auth().doc_id(share_id).is_some();
        if !known || self.auth_identity.is_none() {
            return Err(ShareError::NotFound(share_id.to_string()));
        }
        let id = format!("live-{}", automerge::ActorId::random().to_hex_string());
        let mut placeholder = Automerge::new();
        placeholder
            .transact(|tx| tx.put(automerge::ROOT, SECURE_KEY, share_id))
            .map_err(|e| crate::crdt(e.error))?;
        let mut doc = Automerge::new();
        doc.transact(|tx| {
            let obj = tx.put_object(automerge::ROOT, LIVE_TEXT, automerge::ObjType::Text)?;
            tx.splice_text(&obj, 0, 0, text)
        })
        .map_err(|e| crate::crdt(e.error))?;
        std::fs::create_dir_all(live_dir(&self.share_dir))?;
        // The text first: a crash after the placeholder would host an empty doc.
        write_atomic(
            &live_path(&self.share_dir, &id, "sdoc"),
            &self.seal_doc(&doc.save()),
        )?;
        write_atomic(
            &live_path(&self.share_dir, &id, "automerge"),
            &placeholder.save(),
        )?;
        self.inner.register(id.clone(), placeholder);
        self.secure_doc(&id)
            .ok_or_else(|| ShareError::NotFound(id.clone()))?;
        Ok(id)
    }

    /// Notified when an encrypted doc has something to send; the pump then
    /// calls [`Self::live_secure_flush`].
    pub fn live_secure_wake(&self) -> Arc<tokio::sync::Notify> {
        self.secure_wake.clone()
    }

    fn bump_rev(&self) {
        self.live_rev.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Feeds one message from the relay lane to its encrypted doc, if it is
    /// a sealed frame for one. Replies go straight back out.
    pub async fn live_secure_received(&self, msg: &LiveMessage) {
        if !msg.is_remote() || !is_sealed(&msg.bytes) {
            return;
        }
        let (Some(doc), Ok(beelay)) = (self.secure_doc(&msg.project_id), self.beelay()) else {
            return;
        };
        let out = doc.live.receive(beelay.auth(), &msg.bytes).await;
        for frame in out.frames {
            self.inner.live_send(&msg.project_id, frame);
        }
        for event in out.events {
            match event {
                Event::Changed => self.bump_rev(),
                Event::Ephemeral { sender, bytes } => {
                    // The peer id is the verified sender, never the payload's claim.
                    if let Ok(wire) = serde_json::from_slice::<CursorWire>(&bytes) {
                        self.record_cursor(&msg.project_id, member_id_hex(&sender), wire);
                    }
                }
            }
        }
    }

    /// Sends what every encrypted doc owes its peers: a hello when due, local
    /// edits, queued cursors. With `sweep`, also writes changed docs to disk.
    pub async fn live_secure_flush(&self, sweep: bool) {
        let Ok(beelay) = self.beelay() else { return };
        let auth = beelay.auth();
        let docs: Vec<(String, Arc<SecureDoc>)> = self
            .secure
            .lock()
            .unwrap()
            .iter()
            .map(|(id, doc)| (id.clone(), doc.clone()))
            .collect();
        for (id, doc) in docs {
            let role = doc.live.role(auth).await;
            if doc.role.lock().unwrap().replace(role) != Some(role) {
                self.bump_rev();
            }
            if role.is_none() {
                continue;
            }
            let mut frames = Vec::new();
            let result: std::result::Result<(), linxiv_p2p::AnyError> = async {
                let due = doc
                    .hello
                    .lock()
                    .unwrap()
                    .is_none_or(|at| at.elapsed() >= HELLO_EVERY);
                if due && self.inner.live_peers(&id) > 0 {
                    frames.extend(doc.live.hello(auth).await?);
                    *doc.hello.lock().unwrap() = Some(Instant::now());
                }
                if doc.dirty.swap(false, Ordering::AcqRel) {
                    frames.extend(doc.live.flush(auth).await?);
                }
                let queued = std::mem::take(&mut *doc.outbox.lock().unwrap());
                for bytes in queued {
                    frames.extend(doc.live.ephemeral(auth, bytes).await?);
                }
                Ok(())
            }
            .await;
            if let Err(e) = result {
                tracing::warn!("encrypted live doc {id}: sealing failed: {e}");
            }
            for frame in frames {
                self.inner.live_send(&id, frame);
            }
            if sweep {
                if let Err(e) = self.save_secure(&id, &doc) {
                    tracing::warn!("encrypted live doc {id}: save failed: {e}");
                }
            }
        }
    }

    fn save_secure(&self, id: &str, doc: &SecureDoc) -> Result<()> {
        let (heads, bytes) = doc.live.read(|d| (d.get_heads(), d.save()));
        let mut saved = doc.saved.lock().unwrap();
        // Closed meanwhile: don't resurrect the file.
        let path = live_path(&self.share_dir, id, "sdoc");
        if saved.as_ref() == Some(&heads) || !live_path(&self.share_dir, id, "automerge").is_file()
        {
            return Ok(());
        }
        write_atomic(&path, &self.seal_doc(&bytes)).map_err(net)?;
        *saved = Some(heads);
        Ok(())
    }

    pub(super) fn forget_secure(&self, id: &str) {
        self.secure.lock().unwrap().remove(id);
    }
}
