// Live docs: markdown that several people type into at once. The list view
// starts or joins a doc; the doc view is tiny-mde wired to a LiveSession,
// which trades text with the share node's CRDT (see lib/liveSync.ts).
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import {
  Editor,
  type HistoryState,
  type Position,
} from "../vendor/tiny-mde/TinyMDE";
import { CommandBar } from "../vendor/tiny-mde/TinyMDECommandBar";
import "../vendor/tiny-mde/editor.css";
import "../vendor/tiny-mde/commandbar.css";
import "../styles/live-editor.css";
import {
  closeLiveDoc,
  hostLiveDoc,
  joinLiveDoc,
  listEncryptedShares,
  listLiveDocs,
  liveTicket,
  setLiveCursor,
  storeLiveDoc,
  syncLiveDoc,
} from "../api/live";
import {
  LiveSession,
  caretAfter,
  offsetToPos,
  posToOffset,
  rebaseSnapshot,
  textDiff,
  type LiveStatus,
} from "../lib/liveSync";
import type { LiveCursorRow } from "../types/generated";
import { mathHtml, useTexEnabled } from "../lib/tex";
import { errText } from "../lib/errText";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { EmptyState } from "../components/ui/empty-state";

export default function LivePage() {
  const { id } = useParams<{ id: string }>();
  return id ? <LiveDoc key={id} id={id} /> : <LiveList />;
}

function LiveList() {
  const navigate = useNavigate();
  const { data: docs, error } = useQuery({
    queryKey: ["live-docs"],
    queryFn: listLiveDocs,
  });
  // Encrypting needs an e2ee share to take members and roles from.
  const { data: shares } = useQuery({
    queryKey: ["live-encrypted-shares"],
    queryFn: listEncryptedShares,
  });
  const [shareId, setShareId] = useState("");
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function open(action: () => Promise<string>) {
    setBusy(true);
    setFailure(null);
    try {
      navigate(`/live/${await action()}`);
    } catch (e) {
      setFailure(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-[27px] font-semibold leading-tight tracking-[-0.015em] text-text">
          Live docs
        </h1>
        <div className="flex items-center gap-2">
          {shares && shares.length > 0 && (
            <select
              aria-label="Who can read the new doc"
              value={shareId}
              onChange={(e) => setShareId(e.target.value)}
              className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-text"
            >
              <option value="">Anyone with the invite</option>
              {shares.map((s) => (
                <option key={s.share_id} value={s.share_id}>
                  Encrypted for: {s.name}
                </option>
              ))}
            </select>
          )}
          <Button
            size="sm"
            disabled={busy}
            onClick={() => open(() => hostLiveDoc({ shareId: shareId || undefined }))}
          >
            New live doc
          </Button>
        </div>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void open(() => joinLiveDoc(ticket));
        }}
      >
        <Input
          aria-label="Invite ticket"
          placeholder="Paste an invite ticket to join a doc"
          value={ticket}
          onChange={(e) => setTicket(e.target.value)}
        />
        <Button type="submit" variant="ghost" size="sm" disabled={busy || !ticket.trim()}>
          Join
        </Button>
      </form>

      {(failure || error) && (
        <p role="alert" className="text-sm text-danger">
          {failure ?? errText(error)}
        </p>
      )}

      {docs?.length === 0 && (
        <EmptyState
          icon={<Radio size={28} />}
          title="No live docs yet"
          description="Start one and send the invite ticket, or paste a ticket someone sent you. Everyone with the ticket types in the same document."
        />
      )}
      <ul className="space-y-2">
        {docs?.map((doc) => (
          <li key={doc.id}>
            <button
              type="button"
              onClick={() => navigate(`/live/${doc.id}`)}
              className="w-full flex items-center justify-between gap-3 rounded-md border border-border bg-panel px-4 py-3 text-left text-sm text-text hover:border-accent transition-colors"
            >
              <span className="truncate">{doc.title || "Untitled"}</span>
              <span className="flex items-center gap-2 shrink-0">
                {doc.secure && <Badge>Encrypted</Badge>}
                {doc.source?.kind === "note" && <Badge>Note</Badge>}
                <Badge>{doc.hosted ? "Hosting" : "Joined"}</Badge>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The parts of tiny-mde this page reaches past its public API for. */
type EditorInternals = {
  undoStack: HistoryState[];
  redoStack: HistoryState[];
  isRestoringHistory: boolean;
  computeNodeAndOffset(row: number, col: number): { node: Node; offset: number };
};
const internals = (editor: Editor) => editor as unknown as EditorInternals;

/** Swap the editor's text for `text` without losing the user's caret. */
function applyRemote(editor: Editor, text: string) {
  const before = editor.getContent();
  const inner = internals(editor);
  if (document.activeElement !== editor.e) {
    // No caret to keep. Not an undo step: it is someone else's edit.
    inner.isRestoringHistory = true;
    try {
      editor.setContent(text);
    } finally {
      inner.isRestoringHistory = false;
    }
  } else {
    const focus = editor.getSelection();
    const anchor = editor.getSelection(true);
    // Splice just the changed range: untouched lines keep their DOM.
    const { start, end, insert } = textDiff(before, text);
    editor.paste(insert, offsetToPos(before, start), offsetToPos(before, end));
    const moved = (pos: Position | null) =>
      pos && offsetToPos(text, caretAfter(before, text, posToOffset(before, pos)));
    const caret = moved(focus);
    if (caret) editor.setSelection(caret, moved(anchor));
  }
  // Undo is a stack of whole-text snapshots: carry the peer's edit into each,
  // so undoing takes back the user's typing and not the peer's.
  for (const state of [...inner.undoStack, ...inner.redoStack]) {
    const content = rebaseSnapshot(state.content, before, text);
    const moved = (pos: Position | null) =>
      pos &&
      offsetToPos(
        content,
        caretAfter(state.content, content, posToOffset(state.content, pos))
      );
    state.selection = moved(state.selection);
    state.anchor = moved(state.anchor);
    state.content = content;
  }
}

type Mark = {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  /** Short peer tag, on the caret only. */
  label?: string;
};

function peerColor(peer: string): string {
  let hash = 0;
  for (const ch of peer) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 75% 55%)`;
}

/** Screen boxes for peers' carets and selections, relative to `scroller`. */
function cursorMarks(
  editor: Editor,
  scroller: HTMLElement,
  cursors: LiveCursorRow[]
): Mark[] {
  const text = editor.getContent();
  const box = scroller.getBoundingClientRect();
  const marks: Mark[] = [];
  const point = (offset: number) => {
    const pos = offsetToPos(text, Math.min(offset, text.length));
    return internals(editor).computeNodeAndOffset(pos.row, pos.col);
  };
  for (const cursor of cursors) {
    const color = peerColor(cursor.peer);
    const add = (rect: DOMRect, key: string, label?: string) =>
      marks.push({
        key: `${cursor.peer}:${key}`,
        left: rect.left - box.left + scroller.scrollLeft,
        top: rect.top - box.top + scroller.scrollTop,
        width: rect.width,
        height: rect.height,
        color,
        label,
      });
    try {
      const range = document.createRange();
      const focus = point(cursor.focus);
      range.setStart(focus.node, focus.offset);
      range.collapse(true);
      let caret = range.getClientRects()[0];
      if (!caret) {
        // An empty line has no text box to measure: use the line itself.
        const el = focus.node instanceof Element ? focus.node : focus.node.parentElement!;
        const line = el.getBoundingClientRect();
        caret = new DOMRect(line.left, line.top, 0, line.height);
      }
      add(new DOMRect(caret.left, caret.top, 0, caret.height), "caret", cursor.peer.slice(0, 4));
      if (cursor.anchor !== cursor.focus) {
        const from = point(Math.min(cursor.anchor, cursor.focus));
        const to = point(Math.max(cursor.anchor, cursor.focus));
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        // Box the text only, as a native selection does. The range's own
        // rects include whole line blocks, which paint empty lines edge to edge.
        const root = range.commonAncestorContainer;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const texts: Node[] = root.nodeType === Node.TEXT_NODE ? [root] : [];
        while (walker.nextNode()) texts.push(walker.currentNode);
        let n = 0;
        for (const node of texts) {
          if (!range.intersectsNode(node)) continue;
          const part = document.createRange();
          part.selectNodeContents(node);
          if (node === range.startContainer) part.setStart(node, range.startOffset);
          if (node === range.endContainer) part.setEnd(node, range.endOffset);
          for (const rect of part.getClientRects())
            if (rect.width > 0) add(rect, `sel${n++}`);
        }
      }
    } catch {
      // The peer's offsets ran ahead of this editor's text; the next sync fixes it.
    }
  }
  return marks;
}

function statusLabel(status: LiveStatus | null): string {
  if (!status) return "Opening";
  if (status.error) return status.error;
  if (status.denied)
    return "Encrypted. This device is not a member of the share it belongs to.";
  if (status.secure) {
    const here =
      status.peers === 0
        ? "Nobody else here"
        : status.peers === 1
          ? "1 other member here"
          : `${status.peers} other members here`;
    const mode = !status.ready ? "Waiting for a member" : status.canEdit ? here : `View only. ${here}`;
    return `Encrypted. ${mode}`;
  }
  if (status.hosted)
    return status.peers === 1 ? "1 person connected" : `${status.peers} people connected`;
  if (status.peers > 0) return "Connected to host";
  return status.ready
    ? "Host offline. Edits sync when it is back."
    : "Connecting to host";
}

type TexWindow = { MathJax?: { tex2svg(tex: string, opts: { display: boolean }): Element } };

function LiveDoc({ id }: { id: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const barRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  // Bumped when the layout under the marks moves without a status change.
  const [layout, setLayout] = useState(0);
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const texEnabled = useTexEnabled();
  const ready = status?.ready === true && status.canEdit;
  // What this doc mirrors, if anything (only its host knows).
  const { data: docs } = useQuery({ queryKey: ["live-docs"], queryFn: listLiveDocs });
  const source = docs?.find((doc) => doc.id === id)?.source;

  useEffect(() => {
    const [bar, host] = [barRef.current!, hostRef.current!];
    const editor = new Editor({
      element: host,
      content: "",
      placeholder: "Start typing. Markdown and $math$ work.",
    });
    new CommandBar({ element: bar, editor });
    editorRef.current = editor;
    const el = editor.e!;
    let composing = false;
    const session = new LiveSession(
      (body) => syncLiveDoc(id, body),
      {
        getText: () => editor.getContent(),
        applyRemote: (text) => applyRemote(editor, text),
        busy: () => composing,
      },
      setStatus
    );
    const relayout = () => setLayout((n) => n + 1);
    editor.addEventListener("change", () => {
      void session.push();
      relayout();
    });
    el.addEventListener("compositionstart", () => (composing = true));
    el.addEventListener("compositionend", () => {
      composing = false;
      void session.push();
    });

    // Tell peers where this caret is: on every move, and on a heartbeat so
    // it outlives their expiry while the editor just sits focused.
    // ponytail: a peer's keystroke moves this caret too and re-sends it; the
    // debounce bounds that. Skip unchanged stable positions if it gets chatty.
    const sendCursor = () => {
      const focus = document.activeElement === el ? editor.getSelection() : null;
      const text = editor.getContent();
      const body = focus
        ? {
            focus: posToOffset(text, focus),
            anchor: posToOffset(text, editor.getSelection(true) ?? focus),
          }
        : {};
      void setLiveCursor(id, body).catch(() => {});
    };
    let pending: ReturnType<typeof setTimeout> | undefined;
    const cursorSoon = () => {
      clearTimeout(pending);
      pending = setTimeout(sendCursor, 80);
    };
    editor.addEventListener("selection", cursorSoon);
    el.addEventListener("blur", cursorSoon);
    const heartbeat = setInterval(() => {
      if (document.activeElement === el) sendCursor();
    }, 4000);
    window.addEventListener("resize", relayout);

    session.start();
    return () => {
      // Let the last keystroke land, then write a bound doc back to its
      // source so the note page shows it straight away.
      const last = session.push();
      session.stop();
      void last
        .then(() => storeLiveDoc(id))
        .then((bound) => {
          if (bound) return queryClient.invalidateQueries({ queryKey: ["note"] });
        })
        .catch(() => {});
      clearTimeout(pending);
      clearInterval(heartbeat);
      window.removeEventListener("resize", relayout);
      void setLiveCursor(id, {}).catch(() => {});
      editorRef.current = null;
      bar.replaceChildren();
      host.replaceChildren();
    };
  }, [id, queryClient]);

  // Typing before the first sync would fork the doc from its host's copy.
  useEffect(() => {
    const el = editorRef.current?.e;
    if (el) el.contentEditable = ready ? "true" : "false";
  }, [ready]);

  // Peers' carets are drawn over the text, so they are placed after it renders.
  const cursors = status?.cursors;
  useEffect(() => {
    const [editor, scroller] = [editorRef.current, scrollRef.current];
    setMarks(editor && scroller && cursors?.length ? cursorMarks(editor, scroller, cursors) : []);
  }, [cursors, layout]);

  // tiny-mde typesets through a global MathJax; hand it the app's renderer.
  useEffect(() => {
    const w = window as unknown as TexWindow;
    if (!texEnabled) return;
    w.MathJax = {
      tex2svg(tex, { display }) {
        const html = mathHtml(tex, display);
        if (html === null) throw new Error("unrenderable TeX");
        const holder = document.createElement("template");
        holder.innerHTML = html;
        const svg = holder.content.firstElementChild!;
        // tiny-mde reads each line's text back out of the DOM: whitespace
        // between the serialized tags would leak into the document.
        const walker = document.createTreeWalker(svg, NodeFilter.SHOW_TEXT);
        const blanks: Node[] = [];
        while (walker.nextNode())
          if (!walker.currentNode.textContent?.trim()) blanks.push(walker.currentNode);
        for (const node of blanks) node.parentNode?.removeChild(node);
        return svg;
      },
    };
    editorRef.current?.typeset();
    return () => {
      delete w.MathJax;
    };
  }, [texEnabled]);

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(await liveTicket(id));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setFailure(errText(e));
    }
  }

  async function close() {
    if (!armed) {
      setArmed(true);
      return;
    }
    try {
      await closeLiveDoc(id);
      await queryClient.invalidateQueries({ queryKey: ["live-docs"] });
      navigate("/live");
    } catch (e) {
      setFailure(errText(e));
    }
  }

  const leaveLabel = status?.hosted ? "Stop hosting" : "Leave";
  return (
    <div className="live-editor flex flex-col h-full">
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => navigate("/live")}>
            ← Live docs
          </Button>
          <span role="status" className="truncate text-xs text-muted">
            {status?.closed ? "This doc was closed" : statusLabel(status)}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {failure && (
            <span role="alert" className="text-xs text-danger">
              {failure}
            </span>
          )}
          {source?.kind === "note" && (
            <Button variant="ghost" size="sm" onClick={() => navigate(`/notes/${source.key}`)}>
              Open note
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={copyInvite}>
            {copied ? "Copied" : "Copy invite"}
          </Button>
          <Button variant={armed ? "danger" : "ghost"} size="sm" onClick={close}>
            {armed ? `Confirm: ${leaveLabel.toLowerCase()} and delete` : leaveLabel}
          </Button>
        </div>
      </div>
      <div ref={barRef} />
      <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-y-auto">
        <div ref={hostRef} className="h-full" />
        {marks.map((mark) => (
          <div
            key={mark.key}
            aria-hidden
            data-live-cursor={mark.label ? "caret" : "selection"}
            className="absolute pointer-events-none"
            style={{
              left: mark.left,
              top: mark.top,
              width: mark.label ? 2 : mark.width,
              height: mark.height,
              background: mark.color,
              opacity: mark.label ? 1 : 0.4,
            }}
          >
            {mark.label && (
              <span
                className="absolute bottom-full left-0 px-1 rounded-sm text-[10px] leading-[14px] text-white whitespace-nowrap"
                style={{ background: mark.color }}
              >
                {mark.label}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
