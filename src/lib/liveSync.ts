// Sync loop between one editor and a live doc (`/api/share/live/{id}/sync`).
// The editor holds plain text; the backend holds the CRDT. Every post names
// the version the text was typed on, so the backend can merge instead of
// overwrite.
import type {
  LiveCursorRow,
  LiveSyncBody,
  LiveSynced,
} from "../types/generated.ts";

export interface LiveEditor {
  getText(): string;
  /** Replace the content with `text`, keeping the caret where the user left it. */
  applyRemote(text: string): void;
  /** True while the content must not be touched (an IME composition is open). */
  busy?(): boolean;
}

export interface LiveStatus {
  /** False while a joined doc waits for its first sync; not editable before. */
  ready: boolean;
  hosted: boolean;
  peers: number;
  /** Other people's selections, as offsets into the editor's text. */
  cursors: LiveCursorRow[];
  error: string | null;
  /** The doc no longer exists on this device. */
  closed: boolean;
}

const RETRY_MS = 2000;
/** How soon to look again while the editor is mid-composition. */
const BUSY_MS = 150;

/** The single replaced range turning `before` into `after`. */
export function textDiff(before: string, after: string) {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < max - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  return {
    start,
    end: before.length - tail,
    insert: after.slice(start, after.length - tail),
  };
}

/** Where a caret at `caret` in `before` belongs once it became `after`. */
export function caretAfter(before: string, after: string, caret: number): number {
  const { start, end, insert } = textDiff(before, after);
  if (caret <= start) return caret;
  if (caret >= end) return caret + insert.length - (end - start);
  return start + insert.length;
}

/**
 * An undo snapshot with a peer's edit (`before` to `after`) carried into it,
 * so undoing to it keeps the peer's text. Null when the peer's edit overlaps
 * what the user changed since the snapshot: there is no honest answer then.
 */
export function rebaseSnapshot(
  snapshot: string,
  before: string,
  after: string
): string | null {
  const local = textDiff(snapshot, before);
  const remote = textDiff(before, after);
  // The user's own change occupies [local.start, localEnd) of `before`.
  const localEnd = local.start + local.insert.length;
  let shift: number;
  if (remote.end <= local.start) shift = 0;
  else if (remote.start >= localEnd)
    shift = local.end - local.start - local.insert.length;
  else return null;
  return (
    snapshot.slice(0, remote.start + shift) +
    remote.insert +
    snapshot.slice(remote.end + shift)
  );
}

export function offsetToPos(text: string, offset: number) {
  const head = text.slice(0, offset).split("\n");
  return { row: head.length - 1, col: head[head.length - 1].length };
}

export function posToOffset(text: string, pos: { row: number; col: number }): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let row = 0; row < pos.row && row < lines.length; row++)
    offset += lines[row].length + 1;
  return Math.min(offset + pos.col, text.length);
}

export class LiveSession {
  /** Text the backend holds for this editor at `base`. */
  private shadow = "";
  private base: string[] = [];
  private rev = 0;
  private pushing: Promise<void> | null = null;
  private stopped = false;
  private status: LiveStatus = {
    ready: false,
    hosted: false,
    peers: 0,
    cursors: [],
    error: null,
    closed: false,
  };

  constructor(
    private readonly sync: (body: LiveSyncBody) => Promise<LiveSynced>,
    private readonly editor: LiveEditor,
    private readonly onStatus: (status: LiveStatus) => void,
    private readonly retryMs = RETRY_MS
  ) {}

  start(): void {
    void this.listen();
  }

  stop(): void {
    this.stopped = true;
  }

  /** Call on every editor change. Posts until the backend has the text. */
  push(): Promise<void> {
    if (!this.status.ready || this.stopped) return Promise.resolve();
    return (this.pushing ??= this.drain()
      .catch((e) => this.fail(e))
      .finally(() => {
        this.pushing = null;
      }));
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const text = this.editor.getText();
      if (text === this.shadow) return;
      const res = await this.sync({
        text,
        base: this.base,
        wait: false,
        peers: 0,
        rev: 0,
      });
      if (this.stopped) return;
      if (this.editor.getText() === text && !this.editor.busy?.()) {
        this.adopt(res);
      } else {
        // Typed on while the post was in flight (or composing): the reply's
        // merge can't go in. Keep typing on top of what was posted instead;
        // the next poll brings the merge.
        this.shadow = text;
        this.base = res.own;
      }
    }
  }

  /** Long-polls for peers' edits for as long as the session lives. */
  private async listen(): Promise<void> {
    let wait = false;
    while (!this.stopped) {
      try {
        const base = this.base;
        const res = await this.sync({
          base,
          peers: this.status.peers,
          rev: this.rev,
          wait,
        });
        if (this.stopped) return;
        wait = true;
        if (this.base !== base) {
          // A post landed while this poll was out (the post itself wakes it):
          // the reply predates what the editor now holds. Applying it would
          // roll the text back a keystroke.
        } else if (this.editor.busy?.()) {
          await this.sleep(BUSY_MS);
        } else if (this.pushing) {
          await this.pushing; // its reply is fresher than this one
        } else if (this.status.ready && this.editor.getText() !== this.shadow) {
          const posted = this.shadow;
          await this.push();
          // Still unposted: the push failed. Don't spin on it.
          if (this.shadow === posted) await this.sleep();
        } else {
          this.adopt(res);
        }
      } catch (e) {
        if (this.stopped) return;
        this.fail(e);
        if (this.status.closed) return;
        await this.sleep();
      }
    }
  }

  private adopt(res: LiveSynced): void {
    this.shadow = res.text;
    this.base = res.heads;
    this.rev = res.rev;
    if (res.ready && this.editor.getText() !== res.text)
      this.editor.applyRemote(res.text);
    // After the text: the cursors are offsets into it.
    this.report({
      ready: res.ready,
      hosted: res.hosted,
      peers: res.peers,
      cursors: res.cursors,
      error: null,
      closed: false,
    });
  }

  private fail(e: unknown): void {
    const closed = (e as { status?: number } | null)?.status === 404;
    if (closed) this.stopped = true;
    this.report({
      ...this.status,
      closed,
      error: e instanceof Error ? e.message : "Sync failed",
    });
  }

  private report(status: LiveStatus): void {
    this.status = status;
    this.onStatus(status);
  }

  private sleep(ms = this.retryMs): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
