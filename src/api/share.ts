import { ApiError, isTauri } from "./client";
import type {
  SummaryRow as SharedSummary,
  MemberRow as ShareMember,
  ShareSettings,
  SyncDirection as ShareDirection,
  SharedProjectsListing,
  ReceivedListing,
  MembersListing,
  AdminTransferred,
  TicketMinted,
  ImportedReceipt,
  UnlinkedReceipt,
  LeftReceipt,
  UnpublishedReceipt,
  PublishedReceipt,
  RoleChanged,
  RekeyedReceipt,
  RemovedReceipt,
  RevokedReceipt,
  SharedPdfSaved,
  MemberCode,
  InviteMinted,
  PresenceListing,
  PresenceUpdate,
  SyncReceipt,
  SyncReason,
} from "../types/api";

export type {
  SharedSummary,
  ShareMember,
  ShareSettings,
  ShareDirection,
  SyncReceipt,
  SyncReason,
  MembersListing,
  PresenceListing,
};

/** Narrower than lib/errText: only ApiError messages surface in the sharing UI,
 * so no other exception leaks its raw message. */
export function shareErrText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Unexpected sharing error";
}

// The share endpoints live behind their own `share_api` Tauri command (its own
// ShareState + iroh node), NOT the main `api` one. That node runs only in the
// desktop app, so these `invoke` calls are unavailable in browser dev.
async function shareApi<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>("share_api", {
      req: { method, path, body: body ?? null },
    });
  } catch (e) {
    const err = e as { status?: number; detail?: string };
    throw new ApiError(err.status ?? 500, err.detail ?? "Request failed");
  }
}

export const sharingAvailable = isTauri;

// Most envelope types are generated from the Rust structs in
// crates/server/src/{route/share.rs, share_sync.rs} (aliased above); only
// JoinResult and ReceivedPaper, which have no Rust twin, are hand-written.

/** "admin" is THE ADMIN (singleton); "co-admin" any other admin-tier member.
 * Hosting is a device property, not a role. */
export type MemberRole = "admin" | "co-admin" | "editor" | "viewer";

/** Summaries of every project published (shared out) from this library. */
export async function listShared(): Promise<SharedSummary[]> {
  const res = await shareApi<SharedProjectsListing>(
    "GET",
    "/api/share/projects"
  );
  return res.shared_projects;
}

/** Publish the project (if needed) and mint a one-time, pasteable ticket
 *  carrying this node's address + an unguessable capability. */
export async function createShareTicket(projectId: number): Promise<string> {
  const res = await shareApi<TicketMinted>(
    "POST",
    `/api/share/project/${projectId}/ticket`
  );
  return res.ticket;
}

/** Outcome of {@link joinShare}. `pending` means the invite was accepted but its
 *  host was unreachable, so it has no name or counts until a later sync pass;
 *  {@link listReceived} keeps `pending` set until that first sync lands. */
export type JoinResult =
  | ({ pending?: false } & Omit<SharedSummary, "synced_at" | "paused">)
  | { pending: true; share_id: string; e2ee: true; reason: string };

/** Shown once a join looks stuck. QUIC has no connection-refused, so an offline
 *  host can only time out (15s, `DIAL_TIMEOUT` in the p2p crate). Stays
 *  conditional: a host that *refuses* this device saves nothing. */
export const JOIN_SLOW_HINT =
  "Connecting to the host… If they are offline this takes about 15 seconds, and the invite is saved to finish syncing later.";

/** Dial a ticket's sender, fetch the shared project, store it as a read-only
 *  mirror. Returns its summary (counts only), or `pending` when an e2ee
 *  invite's host could not be reached. */
export async function joinShare(ticket: string): Promise<JoinResult> {
  return shareApi("POST", "/api/share/join", { ticket });
}

/** Summaries of every shared project received via {@link joinShare}. */
export async function listReceived(): Promise<SharedSummary[]> {
  const res = await shareApi<ReceivedListing>("GET", "/api/share/received");
  return res.received;
}

/** Merge a received mirror into the canonical library (additive + update).
 *  Creates the linked local project on first import. */
export async function importReceived(shareId: string): Promise<ImportedReceipt> {
  return shareApi("POST", `/api/share/received/${shareId}/import`);
}

/** Detach the linked local project from a received share. Membership, mirror and
 *  project all stay; interval sync keeps refreshing the mirror but stops
 *  importing until {@link importReceived} makes a new link. */
export async function unlinkShare(shareId: string): Promise<UnlinkedReceipt> {
  return shareApi("POST", `/api/share/received/${shareId}/unlink`);
}

/** One-shot sync of a single share, honoring its paused/direction settings. */
export async function syncShare(shareId: string): Promise<SyncReceipt> {
  return shareApi("POST", `/api/share/${shareId}/sync`);
}

/** Drop a received mirror (+ ticket + settings) and forget the p2p registration
 *  behind it, so a rejoin adopts from scratch. The linked local project stays.
 *  `forgotten: false` means the node was offline and the registration survived,
 *  so a rejoin would reuse the old doc. */
export async function leaveShare(shareId: string): Promise<LeftReceipt> {
  return shareApi("POST", `/api/share/received/${shareId}/leave`);
}

/** Stop serving a published project (deletes the shared doc; SHARE_ID stays
 *  on the project so a republish reuses the same identity). */
export async function unpublishShare(
  shareId: string
): Promise<UnpublishedReceipt> {
  return shareApi("POST", `/api/share/${shareId}/unpublish`);
}

/** Rebind the p2p node against the saved relay settings (Settings → Sharing)
 *  without restarting the app. Save via `updateSettings` first, then call this. */
export async function reconnectRelay(): Promise<void> {
  await shareApi("POST", "/api/share/relay/reconnect");
}

/** This device's pasteable membership code — sent to a host to be invited
 *  to an encrypted share. */
export async function memberCode(): Promise<string> {
  const res = await shareApi<MemberCode>("GET", "/api/share/member_code");
  return res.code;
}

/** Publish the project as an end-to-end encrypted share. No ticket — access
 *  is granted per-device via {@link inviteMember}. */
export async function publishSecure(
  projectId: number
): Promise<PublishedReceipt> {
  return shareApi("POST", `/api/share/project/${projectId}/publish_secure`);
}

/** Grant a device access to an e2ee share and mint its pasteable invite
 *  string. Admin-tier op, from the hosting device or a co-admin's. */
export async function inviteMember(
  shareId: string,
  opts: { memberCode: string; role: "editor" | "viewer"; name?: string }
): Promise<string> {
  const res = await shareApi<InviteMinted>(
    "POST",
    `/api/share/${shareId}/invite`,
    { member_code: opts.memberCode, role: opts.role, name: opts.name }
  );
  return res.invite;
}

/** Members of an e2ee share this device administers, plus this device's own
 *  member id and admin-tier standing (drives which controls the UI offers). */
export async function listMembers(shareId: string): Promise<MembersListing> {
  return shareApi<MembersListing>("GET", `/api/share/${shareId}/members`);
}

/** Change a member's role (viewer ↔ editor, or promote to co-admin — the
 *  co-admin grant is THE ADMIN's alone; "admin" only moves via
 *  {@link transferAdmin}). */
export async function setMemberRole(
  shareId: string,
  memberId: string,
  role: Exclude<MemberRole, "admin">
): Promise<RoleChanged> {
  return shareApi("POST", `/api/share/${shareId}/member/${memberId}/role`, {
    role,
  });
}

/** Hand THE ADMIN role to a co-admin. The old admin becomes a co-admin —
 *  powers travel with the role; hosting stays where it is. */
export async function transferAdmin(
  shareId: string,
  memberId: string
): Promise<AdminTransferred> {
  return shareApi("POST", `/api/share/${shareId}/transfer_admin`, {
    member_id: memberId,
  });
}

/** Re-encrypt a hosted share's whole history (and its PDF blobs) under the
 *  current key, then republish. Repairs members who joined after the content was
 *  encrypted and can decrypt none of it — their sync reports `no_key > 0` with
 *  `applied` stuck at 0. */
export async function rekeyShare(shareId: string): Promise<RekeyedReceipt> {
  return shareApi("POST", `/api/share/${shareId}/rekey`);
}

/** Revoke a member and drop their row, so re-inviting the same device starts
 *  clean. Use over {@link revokeMember} when the invite is redone, not withdrawn. */
export async function removeMember(
  shareId: string,
  memberId: string
): Promise<RemovedReceipt> {
  return shareApi("POST", `/api/share/${shareId}/member/${memberId}/remove`);
}

/** Revoke a member: stops receiving future updates; content already synced
 *  stays on their device. */
export async function revokeMember(
  shareId: string,
  memberId: string
): Promise<RevokedReceipt> {
  return shareApi("POST", `/api/share/${shareId}/revoke`, {
    member_id: memberId,
  });
}

/** Fields the share page consumes for one paper in a received mirror. */
export interface ReceivedPaper {
  source_id: string;
  title: string;
  has_pdf: boolean;
}

/** Papers of one received mirror. */
export async function listReceivedPapers(
  shareId: string
): Promise<ReceivedPaper[]> {
  const res = await shareApi<{ papers: ReceivedPaper[] }>(
    "GET",
    `/api/share/received/${shareId}`
  );
  return res.papers;
}

/** Fetch + decrypt one shared PDF blob and save it to the managed PDF dir. */
export async function downloadSharedPdf(
  shareId: string,
  sourceId: string
): Promise<SharedPdfSaved> {
  return shareApi("POST", `/api/share/${shareId}/pdf`, {
    source_id: sourceId,
  });
}

/** Every member's last heartbeat on an e2ee share; open to all roles. */
export async function getPresence(shareId: string): Promise<PresenceListing> {
  return shareApi("GET", `/api/share/${shareId}/presence`);
}

let readingChain: Promise<unknown> = Promise.resolve();

/** Opt-in "reading ..." indicator: the paper's source_id, or null to clear.
 * Lands only in shares that contain the paper. */
export function setReading(reading: string | null): Promise<void> {
  const body: PresenceUpdate = { reading };
  // Serialized: callers fire and forget, so a clear+set racing on paper
  // navigation could otherwise land out of order and blank the new paper.
  const next = readingChain.then(() =>
    shareApi<void>("POST", "/api/share/presence", body)
  );
  readingChain = next.catch(() => {});
  return next;
}


export async function getShareSettings(
  shareId: string
): Promise<ShareSettings> {
  return shareApi("GET", `/api/share/${shareId}/settings`);
}

export async function updateShareSettings(
  shareId: string,
  patch: Partial<ShareSettings>
): Promise<ShareSettings> {
  return shareApi("PUT", `/api/share/${shareId}/settings`, patch);
}
