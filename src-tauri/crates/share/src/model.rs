//! Quarantined CRDT document model: autosurgeon `Reconcile`/`Hydrate` over automerge,
//! projected from core's read views. `color` widens i32→i64, timestamps are
//! `NaiveDateTime` strings — automerge has no i32/date scalar.

use autosurgeon::{Hydrate, Reconcile};

#[derive(Debug, Clone, PartialEq, Reconcile, Hydrate)]
pub struct SharedProject {
    pub share_id: String,
    pub name: String,
    pub description: String,
    pub color: Option<i64>,
    pub tags: Vec<String>,
    pub papers: Vec<SharedPaper>,
    pub notes: Vec<SharedNote>,
    pub annotations: Vec<SharedAnnotation>,
}

#[derive(Debug, Clone, PartialEq, Reconcile, Hydrate)]
pub struct SharedPaper {
    /// Stable identity within a project; `#[key]` so autosurgeon merges
    /// list edits by paper, not by position.
    #[key]
    pub source_id: String,
    pub version: i64,
    pub published: Option<String>,
    pub title: String,
    pub summary: String,
    pub authors: Vec<String>,
    pub tags: Vec<String>,
    /// Blob ticket for the paper's PDF, minted by an e2ee hoster
    /// (`ShareNode::store_pdf_blob`).
    #[autosurgeon(missing = "Default::default")]
    pub pdf_blob: Option<String>,
    /// Index-aligned with `authors`; absent in pre-upgrade docs.
    #[autosurgeon(missing = "Default::default")]
    pub author_orcids: Vec<Option<String>>,
}

impl SharedPaper {
    /// The per-paper wire summary `GET /api/share/received/{id}` sends: display
    /// fields plus `has_pdf` in place of the blob ticket.
    pub fn to_summary_value(&self) -> serde_json::Value {
        serde_json::json!({
            "source_id": self.source_id,
            "version": self.version,
            "title": self.title,
            "summary": self.summary,
            "authors": self.authors,
            "tags": self.tags,
            "has_pdf": self.pdf_blob.is_some(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Reconcile, Hydrate)]
pub struct SharedNote {
    /// Stable canonical identity (NOTE.NOTE_UUID); `#[key]` so autosurgeon merges
    /// list edits by note, not by position.
    #[key]
    pub uuid: String,
    /// Paper the note hangs off; absent in pre-upgrade docs.
    #[autosurgeon(missing = "Default::default")]
    pub paper_source_id: Option<String>,
    pub title: String,
    pub body: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// PDF highlight annotation projected into the snapshot. `anchor` is the opaque
/// highlight-geometry JSON; `comment` is the written comment ("" = highlight-only).
#[derive(Debug, Clone, PartialEq, Reconcile, Hydrate)]
pub struct SharedAnnotation {
    /// Stable canonical identity (ANNOTATION.ANNOTATION_UUID); CRDT list key.
    #[key]
    pub uuid: String,
    pub paper_source_id: String,
    pub anchor: String,
    pub comment: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// One member's shared roster entry, living beside the content in the e2ee doc
/// so every admin-tier device can list and manage the full membership. Names
/// here are visible to all members. Bearer secrets (invite strings) never go
/// in the doc — they stay in the inviting device's local sidecar.
#[derive(Debug, Clone, PartialEq, Reconcile, Hydrate, serde::Serialize, serde::Deserialize)]
pub struct MemberMeta {
    /// Keyhive member id, lowercase hex; CRDT list key.
    #[key]
    pub member_id: String,
    pub name: Option<String>,
    pub invited_at: String,
    /// Member id (hex) of the inviting device; `None` = the project creator.
    /// Mirrors the keyhive delegation lineage: revocation needs causal
    /// seniority, so this chain is what says who can revoke whom.
    #[autosurgeon(missing = "Default::default")]
    pub invited_by: Option<String>,
}

/// One member's live-presence entry, a root prop beside [`MemberMeta`] in the
/// e2ee doc. Written by the member itself: `last_seen` on every sync pass,
/// `reading` only when the member opted in. Viewer-role writes are served
/// from a scratch core by the host and never land (write-enforcement §2.4).
#[derive(Debug, Clone, PartialEq, Reconcile, Hydrate, serde::Serialize, serde::Deserialize)]
pub struct PresenceMeta {
    /// Keyhive member id, lowercase hex; CRDT list key.
    #[key]
    pub member_id: String,
    /// RFC 3339 UTC of the member's last sync pass.
    pub last_seen: String,
    /// `source_id` of the shared paper the member is reading, if opted in.
    #[autosurgeon(missing = "Default::default")]
    pub reading: Option<String>,
}

/// Lightweight listing view — counts only, never a hydrated subgraph.
#[derive(Debug, Clone, PartialEq)]
pub struct SharedSummary {
    pub share_id: String,
    pub name: String,
    pub description: String,
    pub paper_count: usize,
    pub note_count: usize,
    pub annotation_count: usize,
    pub tag_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pin the received-share paper summary: display fields + `has_pdf`, never
    /// the blob ticket or ORCIDs.
    #[test]
    fn paper_summary_pins_the_wire_shape() {
        let p = SharedPaper {
            source_id: "arxiv:2401.00001".into(),
            version: 2,
            published: Some("2024-01-01".into()),
            title: "T".into(),
            summary: "S".into(),
            authors: vec!["A".into()],
            tags: vec!["t".into()],
            pdf_blob: Some("ticket".into()),
            author_orcids: vec![None],
        };
        assert_eq!(
            serde_json::to_string(&p.to_summary_value()).unwrap(),
            r#"{"source_id":"arxiv:2401.00001","version":2,"title":"T","summary":"S","authors":["A"],"tags":["t"],"has_pdf":true}"#
        );
    }

    /// Pre-upgrade docs lack `pdf_blob` / `paper_source_id` keys; hydrate must
    /// default them to `None` instead of erroring.
    #[test]
    fn hydrates_doc_missing_optional_keys() {
        // Old-schema shapes: same fields minus the later additions.
        #[derive(Reconcile)]
        struct OldPaper {
            source_id: String,
            version: i64,
            published: Option<String>,
            title: String,
            summary: String,
            authors: Vec<String>,
            tags: Vec<String>,
        }
        #[derive(Reconcile)]
        struct OldNote {
            uuid: String,
            title: String,
            body: String,
            created_at: Option<String>,
            updated_at: Option<String>,
        }

        let mut doc = automerge::AutoCommit::new();
        autosurgeon::reconcile(
            &mut doc,
            OldPaper {
                source_id: "2401.00001".into(),
                version: 1,
                published: None,
                title: "t".into(),
                summary: "s".into(),
                authors: vec![],
                tags: vec![],
            },
        )
        .unwrap();
        let paper: SharedPaper = autosurgeon::hydrate(&doc).unwrap();
        assert_eq!(paper.pdf_blob, None);
        assert_eq!(paper.author_orcids, Vec::<Option<String>>::new());

        let mut doc = automerge::AutoCommit::new();
        autosurgeon::reconcile(
            &mut doc,
            OldNote {
                uuid: "u".into(),
                title: "t".into(),
                body: "b".into(),
                created_at: None,
                updated_at: None,
            },
        )
        .unwrap();
        let note: SharedNote = autosurgeon::hydrate(&doc).unwrap();
        assert_eq!(note.paper_source_id, None);
    }
}
