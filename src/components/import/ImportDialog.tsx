import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import {
  importBibtex,
  importPdf,
  commitImport,
  previewImport,
  type ImportPreview,
} from "../../api/exportImport";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Spinner } from "../ui/spinner";

// ── Types ─────────────────────────────────────────────────────────────────────

type FileKind = "pdf" | "bibtex" | "lxproj" | "unknown";
type FileStatus = "queued" | "processing" | "done" | "error";

interface QueueEntry {
  file: File;
  kind: FileKind;
  status: FileStatus;
  preview?: ImportPreview;
  onConflict: "merge" | "overwrite";
  result?: string;
  error?: string;
}

function detectKind(f: File): FileKind {
  const n = f.name.toLowerCase();
  if (n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".bib")) return "bibtex";
  if (n.endsWith(".lxproj")) return "lxproj";
  return "unknown";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusMark({ status }: { status: FileStatus }) {
  if (status === "processing") return <Spinner size={12} />;
  const map: Record<FileStatus, { char: string; color: string }> = {
    queued:     { char: "○", color: "var(--color-muted)"   },
    processing: { char: "…", color: "var(--color-muted)"   },
    done:       { char: "✓", color: "var(--color-success)" },
    error:      { char: "✗", color: "var(--color-danger)"  },
  };
  const { char, color } = map[status];
  return <span style={{ color, fontFamily: "monospace", width: 14, display: "inline-block", textAlign: "center" }}>{char}</span>;
}

function LxprojPreview({
  entry,
  onChange,
}: {
  entry: QueueEntry;
  onChange: (patch: Partial<QueueEntry>) => void;
}) {
  if (!entry.preview) return null;
  const p = entry.preview;
  return (
    <div
      className="ml-5 mt-1 mb-1 rounded border border-border p-2 text-xs flex flex-col gap-1"
      style={{ backgroundColor: "var(--color-bg)" }}
    >
      <p className="font-medium" style={{ color: "var(--color-text)" }}>{p.project_name}</p>
      {p.description && <p style={{ color: "var(--color-muted)" }}>{p.description}</p>}
      <p style={{ color: "var(--color-muted)" }}>
        {p.paper_count} paper{p.paper_count !== 1 ? "s" : ""} · {p.note_count} note{p.note_count !== 1 ? "s" : ""}
        {p.has_pdfs ? " · includes PDFs" : ""}
      </p>
      <div className="flex items-center gap-3 mt-0.5">
        <span style={{ color: "var(--color-muted)" }}>On conflict:</span>
        {(["merge", "overwrite"] as const).map((v) => (
          <label key={v} className="flex items-center gap-1 cursor-pointer capitalize" style={{ color: "var(--color-text)" }}>
            <input
              type="radio"
              name={`conflict-${entry.file.name}`}
              value={v}
              checked={entry.onConflict === v}
              onChange={() => onChange({ onConflict: v })}
              className="accent-[var(--color-accent)]"
            />
            {v}
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set, PDFs and BibTeX entries are linked to this project after import. */
  projectId?: number;
  /** Called after all queued files finish processing. newProjectIds contains
   *  any project IDs created by .lxproj imports. */
  onDone: (newProjectIds: number[]) => void;
}

export function ImportDialog({ open, onClose, projectId, onDone }: ImportDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [running, setRunning] = useState(false);

  function updateEntry(i: number, patch: Partial<QueueEntry>) {
    setQueue((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => detectKind(f) !== "unknown");
    e.target.value = "";
    if (!files.length) return;

    const newEntries: QueueEntry[] = files.map((f) => ({
      file: f,
      kind: detectKind(f),
      status: "queued",
      onConflict: "merge",
    }));
    setQueue((prev) => [...prev, ...newEntries]);

    // Auto-fetch previews for .lxproj files
    for (let i = 0; i < newEntries.length; i++) {
      if (newEntries[i].kind !== "lxproj") continue;
      try {
        const preview = await previewImport(newEntries[i].file);
        setQueue((prev) =>
          prev.map((e) => (e.file === newEntries[i].file ? { ...e, preview } : e))
        );
      } catch {
        // preview is optional — import can still proceed
      }
    }
  }

  async function handleImport() {
    if (running) return;
    setRunning(true);
    const newProjectIds: number[] = [];

    for (let i = 0; i < queue.length; i++) {
      if (queue[i].status !== "queued") continue;
      updateEntry(i, { status: "processing" });
      try {
        const { file, kind, onConflict } = queue[i];
        let result = "";
        if (kind === "pdf") {
          const r = await importPdf(file, projectId);
          result = `Saved "${r.title || file.name}"`;
        } else if (kind === "bibtex") {
          const r = await importBibtex(file, projectId);
          result = `${r.saved_count} paper${r.saved_count !== 1 ? "s" : ""} saved`;
        } else if (kind === "lxproj") {
          const r = await commitImport(file, onConflict);
          newProjectIds.push(r.project_id);
          result = `Project imported`;
        }
        updateEntry(i, { status: "done", result });
      } catch (err) {
        updateEntry(i, {
          status: "error",
          error: err instanceof Error ? err.message : "Failed",
        });
      }
    }

    setRunning(false);
    onDone(newProjectIds);
  }

  function reset() {
    setQueue([]);
    setRunning(false);
  }

  const queued = queue.filter((e) => e.status === "queued").length;
  const allSettled = queue.length > 0 && queue.every((e) => e.status === "done" || e.status === "error");

  return (
    <Dialog
      open={open}
      onClose={() => { if (!running) { reset(); onClose(); } }}
      title="Import"
    >
      <div className="flex flex-col gap-4" style={{ minWidth: 380 }}>
        {/* File picker */}
        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.bib,.lxproj"
            multiple
            onChange={handleFilePick}
            className="hidden"
          />
          <Button variant="muted" size="sm" onClick={() => fileRef.current?.click()} disabled={running}>
            <Upload size={13} className="mr-1.5" />
            Add files…
          </Button>
          <p className="text-xs mt-1" style={{ color: "var(--color-muted)" }}>
            Accepts .pdf · .bib (BibTeX) · .lxproj — multiple files supported
            {projectId ? " · files linked to this project" : ""}
          </p>
        </div>

        {/* Queue */}
        {queue.length > 0 && (
          <div
            className="rounded-md border border-border overflow-y-auto"
            style={{ maxHeight: 300, backgroundColor: "var(--color-bg)" }}
          >
            {queue.map((entry, i) => (
              <div key={i} className="border-b border-border last:border-0">
                <div className="flex items-center gap-2 px-3 py-2 text-sm">
                  <StatusMark status={entry.status} />
                  <span className="flex-1 truncate" style={{ color: "var(--color-text)" }}>
                    {entry.file.name}
                  </span>
                  <span className="text-xs shrink-0" style={{ color: "var(--color-muted)" }}>
                    {entry.kind === "pdf" ? "PDF" : entry.kind === "bibtex" ? "BibTeX" : ".lxproj"}
                  </span>
                  {entry.result && (
                    <span className="text-xs shrink-0" style={{ color: "var(--color-success)" }}>
                      {entry.result}
                    </span>
                  )}
                  {entry.error && (
                    <span
                      className="text-xs shrink-0 max-w-36 truncate"
                      style={{ color: "var(--color-danger)" }}
                      title={entry.error}
                    >
                      {entry.error}
                    </span>
                  )}
                  {entry.status === "queued" && (
                    <button
                      type="button"
                      className="text-sm shrink-0 leading-none"
                      style={{ color: "var(--color-muted)" }}
                      onClick={() => setQueue((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      ×
                    </button>
                  )}
                </div>
                {entry.kind === "lxproj" && entry.status === "queued" && (
                  <div className="px-3 pb-2">
                    <LxprojPreview entry={entry} onChange={(patch) => updateEntry(i, patch)} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs" style={{ color: "var(--color-muted)" }}>
            {running
              ? "Importing…"
              : queued > 0
              ? `${queued} file${queued !== 1 ? "s" : ""} queued`
              : allSettled
              ? "All done"
              : ""}
          </span>
          <div className="flex gap-2">
            <Button
              variant="muted"
              onClick={() => { reset(); onClose(); }}
              disabled={running}
            >
              {allSettled ? "Close" : "Cancel"}
            </Button>
            {!allSettled && (
              <Button onClick={handleImport} disabled={running || queued === 0}>
                {running ? <Spinner size={14} /> : `Import${queued > 0 ? ` (${queued})` : ""}`}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
