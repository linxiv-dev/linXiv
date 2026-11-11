import { apiFetch, isTauri } from "./client";
import { shareApi } from "./share";
import type {
  LiveClosed,
  LiveCursorBody,
  LiveCursorSent,
  LiveListing,
  LiveOpened,
  LiveRow,
  LiveSource,
  LiveStored,
  LiveSyncBody,
  LiveSynced,
  LiveTicket,
  ReceivedListing,
  SharedProjectsListing,
} from "../types/generated";

export type { LiveRow, LiveSource };

// The desktop app reaches the share node through `share_api`; a headless node
// serves the same routes over HTTP.
function share<T>(method: string, full: string, body?: unknown): Promise<T> {
  return isTauri
    ? shareApi<T>(method, full, body)
    : apiFetch<T>(full, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
}

function live<T>(method: string, path = "", body?: unknown): Promise<T> {
  return share<T>(method, `/api/share/live${path}`, body);
}

/** An e2ee share a live doc can be encrypted for. */
export interface EncryptedShare {
  share_id: string;
  name: string;
}

/** The e2ee shares this device hosts or belongs to. */
export async function listEncryptedShares(): Promise<EncryptedShare[]> {
  const [hosted, received] = await Promise.all([
    share<SharedProjectsListing>("GET", "/api/share/projects"),
    share<ReceivedListing>("GET", "/api/share/received"),
  ]);
  return [...hosted.shared_projects, ...received.received]
    .filter((s) => s.e2ee)
    .map(({ share_id, name }) => ({ share_id, name }));
}

export async function listLiveDocs(): Promise<LiveRow[]> {
  return (await live<LiveListing>("GET")).docs;
}

/** Start hosting a live doc; returns its id. `source` makes it mirror
 *  something (reusing the doc already open for it); `shareId` encrypts it end
 *  to end for that e2ee share's members. */
export async function hostLiveDoc(
  opts: { source?: LiveSource; shareId?: string } = {}
): Promise<string> {
  const body = { source: opts.source, share_id: opts.shareId };
  return (await live<LiveOpened>("POST", "", body)).id;
}

/** Write a bound doc's text back to its source now. */
export async function storeLiveDoc(id: string): Promise<boolean> {
  return (await live<LiveStored>("POST", `/${id}/store`)).bound;
}

/** Adopt a live doc from its host's ticket; returns its id. */
export async function joinLiveDoc(ticket: string): Promise<string> {
  return (await live<LiveOpened>("POST", "/join", { ticket })).id;
}

/** The doc's invite. `view` asks the host for a view-only one: its holder
 *  follows the doc and cannot change it. */
export async function liveTicket(id: string, mode?: "view"): Promise<string> {
  const query = mode ? `?mode=${mode}` : "";
  return (await live<LiveTicket>("GET", `/${id}/ticket${query}`)).ticket;
}

export function syncLiveDoc(id: string, body: LiveSyncBody): Promise<LiveSynced> {
  return live<LiveSynced>("POST", `/${id}/sync`, body);
}

/** Tell live peers where this editor's selection is; `{}` clears it. */
export async function setLiveCursor(id: string, body: LiveCursorBody): Promise<void> {
  await live<LiveCursorSent>("POST", `/${id}/cursor`, body);
}

/** Stop hosting, or leave; deletes the local copy either way. */
export async function closeLiveDoc(id: string): Promise<void> {
  await live<LiveClosed>("DELETE", `/${id}`);
}
