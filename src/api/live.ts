import { apiFetch, isTauri } from "./client";
import { shareApi } from "./share";
import type {
  LiveClosed,
  LiveCursorBody,
  LiveCursorSent,
  LiveListing,
  LiveOpened,
  LiveRow,
  LiveSyncBody,
  LiveSynced,
  LiveTicket,
} from "../types/generated";

export type { LiveRow };

// The desktop app reaches the share node through `share_api`; a headless node
// serves the same routes over HTTP.
function live<T>(method: string, path = "", body?: unknown): Promise<T> {
  const full = `/api/share/live${path}`;
  return isTauri
    ? shareApi<T>(method, full, body)
    : apiFetch<T>(full, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
}

export async function listLiveDocs(): Promise<LiveRow[]> {
  return (await live<LiveListing>("GET")).docs;
}

/** Start hosting a new live doc; returns its id. */
export async function hostLiveDoc(text = ""): Promise<string> {
  return (await live<LiveOpened>("POST", "", { text })).id;
}

/** Adopt a live doc from its host's ticket; returns its id. */
export async function joinLiveDoc(ticket: string): Promise<string> {
  return (await live<LiveOpened>("POST", "/join", { ticket })).id;
}

export async function liveTicket(id: string): Promise<string> {
  return (await live<LiveTicket>("GET", `/${id}/ticket`)).ticket;
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
