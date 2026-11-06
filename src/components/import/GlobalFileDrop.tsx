import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Upload } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { convertFileSrc } from "@tauri-apps/api/core";
import { isTauri } from "../../api/client";
import { DIALOG_DROP_EVENT, ImportDialog } from "./ImportDialog";
import { importBibtex, importPdf } from "../../api/exportImport";
import { useImportJobsStore } from "../../stores/importJobs";
import { invalidatePaperMutationQueries } from "../../lib/paperMutations";
import { errText } from "../../lib/errText";

// Negative so job uids never collide with ImportDialog's positive ones.
let _uid = 0;
function nextUid() { return --_uid; }

// Matches the `data-import-dialog` attribute on ImportDialog, which is only in the page while the dialog is open.
const IMPORT_DIALOG_SELECTOR = "[data-import-dialog]";

function hasFiles(e: DragEvent) {
  return e.dataTransfer?.types.includes("Files") ?? false;
}

function importDialogOpen() {
  return document.querySelector(IMPORT_DIALOG_SELECTOR) !== null;
}

// Tauri hands drops over as paths. Core adds them to the asset-protocol scope
// before emitting the event; plugin-fs scopes them later, so readFile can race.
async function filesFromPaths(paths: string[]): Promise<File[]> {
  return Promise.all(
    paths.map(async (p) => {
      const res = await fetch(convertFileSrc(p));
      if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
      return new File([await res.blob()], p.split(/[\\/]/).pop() ?? p);
    }),
  );
}

/** Imports .pdf and .bib in the background; other formats fail as sidebar jobs. */
async function importDropped(files: File[], queryClient: QueryClient) {
  const { addJobs, updateJob } = useImportJobsStore.getState();
  const jobs = files.map((file) => ({ uid: nextUid(), file }));
  addJobs(jobs.map(({ uid, file }) => ({ uid, filename: file.name })));

  // Sequential intentionally: avoids saturating the backend with concurrent uploads.
  for (const { uid, file } of jobs) {
    const name = file.name.toLowerCase();
    try {
      let result: string;
      if (name.endsWith(".pdf")) {
        const r = await importPdf(file);
        result = `Saved "${r.title || file.name}"`;
      } else if (name.endsWith(".bib")) {
        const r = await importBibtex(file);
        result = `${r.saved_count} paper${r.saved_count !== 1 ? "s" : ""} saved`;
      } else {
        updateJob(uid, { status: "error", error: "Unsupported format" });
        continue;
      }
      invalidatePaperMutationQueries(queryClient);
      updateJob(uid, { status: "done", result });
    } catch (err) {
      console.error(`import ${file.name} failed:`, err);
      updateJob(uid, { status: "error", error: errText(err, String(err)) });
    }
  }
}

function isLxproj(f: File) {
  return f.name.toLowerCase().endsWith(".lxproj");
}

/**
 * Window-wide drop target: files dropped anywhere are added to the library.
 * Drops with an .lxproj open the Import dialog for its preview.
 */
export function GlobalFileDrop() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dragging, setDragging] = useState(false);
  const [dialogFiles, setDialogFiles] = useState<File[] | null>(null);
  const dialogOpen = dialogFiles !== null;

  useEffect(() => {
    function handleFiles(files: File[]) {
      if (!files.length) return;
      if (importDialogOpen()) window.dispatchEvent(new CustomEvent(DIALOG_DROP_EVENT, { detail: files }));
      else if (files.some(isLxproj)) setDialogFiles(files);
      else void importDropped(files, queryClient);
    }

    // Tauri intercepts OS file drops before the DOM sees them (on Linux the
    // webview would otherwise navigate to the file), so use its event instead.
    if (isTauri) {
      const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === "enter" || payload.type === "over") {
          setDragging(true);
          return;
        }
        setDragging(false);
        if (payload.type === "drop") {
          filesFromPaths(payload.paths).then(handleFiles, (err: unknown) => {
            console.error("reading dropped files failed:", err);
            const { addJobs, updateJob } = useImportJobsStore.getState();
            const uid = nextUid();
            addJobs([{ uid, filename: payload.paths.join(", ") }]);
            updateJob(uid, { status: "error", error: errText(err, String(err)) });
          });
        }
      });
      return () => { void unlisten.then((f) => f()); };
    }

    // dragenter/dragleave fire for every element crossed; count them to know
    // when the drag has actually left the window.
    let depth = 0;

    function onDragEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    }
    function onDragLeave(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    }
    function onDragOver(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault(); // required for drop to fire instead of the browser opening the file
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    function onDrop(e: DragEvent) {
      depth = 0;
      setDragging(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      handleFiles(Array.from(e.dataTransfer?.files ?? []));
    }
    function onDragEnd() {
      depth = 0;
      setDragging(false);
    }

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onDragEnd);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onDragEnd);
    };
  }, [queryClient]);

  return (
    <>
      <ImportDialog
        open={dialogOpen}
        onClose={() => setDialogFiles(null)}
        initialFiles={dialogFiles ?? undefined}
        onDone={(newProjectIds) => {
          if (newProjectIds.length === 1) navigate(`/projects/${newProjectIds[0]}`);
        }}
      />
      {dragging && !importDialogOpen() && <DropOverlay />}
    </>
  );
}

function DropOverlay() {
  return (
    <div
      className="fixed inset-0 z-[60] pointer-events-none flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
    >
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed text-sm border-accent text-text"
      >
        <Upload size={28} className="text-accent" />
        <p className="font-medium">Drop to add to library</p>
        <p className="text-xs text-muted">
          .pdf · .bib · .lxproj
        </p>
      </div>
    </div>
  );
}
