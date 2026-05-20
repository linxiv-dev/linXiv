import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, Upload } from "lucide-react";
import { getProject, updateProject, addPaperToProject, removePaperFromProject } from "../api/projects";
import { listPapers } from "../api/papers";
import { exportProject, exportBibtex, exportObsidian } from "../api/exportImport";
import { ImportDialog } from "../components/import/ImportDialog";
import type { Paper } from "../types/api";
import { useSelectionStore } from "../stores/selection";
import { ColorSwatch } from "../components/projects/ColorSwatch";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";

// ---------------------------------------------------------------------------
// Preset swatches (same as create dialog)
// ---------------------------------------------------------------------------
const PRESET_COLORS = [
  "#5b8dee",
  "#4caf88",
  "#e8912d",
  "#748ffc",
  "#e05c6c",
  "#51cf66",
];

// ---------------------------------------------------------------------------
// Edit Project Dialog
// ---------------------------------------------------------------------------
interface EditProjectDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  initialName: string;
  initialDescription: string;
  initialColor: string | null;
}

function EditProjectDialog({
  open,
  onClose,
  projectId,
  initialName,
  initialDescription,
  initialColor,
}: EditProjectDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [color, setColor] = useState<string | null>(initialColor);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed from props each time dialog opens
  useEffect(() => {
    if (open) {
      setName(initialName);
      setDescription(initialDescription);
      setColor(initialColor);
      setError(null);
    }
  }, [open, initialName, initialDescription, initialColor]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateProject(projectId, {
        name: name.trim(),
        description: description.trim(),
        color_hex: color,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project", String(projectId)] }),
      ]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update project");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Edit Project">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="edit-proj-name"
            className="text-xs font-medium"
            style={{ color: "var(--color-muted)" }}
          >
            Name <span style={{ color: "var(--color-danger)" }}>*</span>
          </label>
          <Input
            id="edit-proj-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="edit-proj-desc"
            className="text-xs font-medium"
            style={{ color: "var(--color-muted)" }}
          >
            Description
          </label>
          <Textarea
            id="edit-proj-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span
            className="text-xs font-medium"
            style={{ color: "var(--color-muted)" }}
          >
            Color
          </span>
          <div className="flex items-center gap-2">
            {PRESET_COLORS.map((c) => (
              <ColorSwatch
                key={c}
                color={c}
                size={20}
                selected={color === c}
                onClick={() => setColor(color === c ? null : c)}
              />
            ))}
          </div>
        </div>

        {error && (
          <p className="text-xs" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="muted" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!name.trim() || submitting}>
            {submitting ? <Spinner size={14} /> : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add Papers Dialog
// ---------------------------------------------------------------------------
interface AddPapersDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  existingSourceIds: string[];
}

function AddPapersDialog({
  open,
  onClose,
  projectId,
  existingSourceIds,
}: AddPapersDialogProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: papersData, isLoading } = useQuery({
    queryKey: ["papers"],
    queryFn: () => listPapers(),
    enabled: open,
  });

  // Reset on open
  useEffect(() => {
    if (open) {
      setSearch("");
      setSelectedIds(new Set());
      setError(null);
    }
  }, [open]);

  const candidates = (papersData?.papers ?? []).filter(
    (p) => !existingSourceIds.includes(p.source_id)
  );

  const filtered = candidates.filter((p) =>
    search.trim()
      ? p.title.toLowerCase().includes(search.toLowerCase()) ||
        p.source_id.toLowerCase().includes(search.toLowerCase())
      : true
  );

  function toggleId(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleSubmit() {
    if (selectedIds.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await Promise.all(
        [...selectedIds].map((id) => addPaperToProject(projectId, id))
      );
      await queryClient.invalidateQueries({
        queryKey: ["project", String(projectId)],
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add papers");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add Papers">
      <div className="flex flex-col gap-3">
        <Input
          placeholder="Search papers..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />

        <div
          className="overflow-y-auto rounded-md border border-[var(--color-border)]"
          style={{ maxHeight: 280, backgroundColor: "var(--color-bg)" }}
        >
          {isLoading ? (
            <div className="flex items-center justify-center p-6">
              <Spinner size={20} />
            </div>
          ) : filtered.length === 0 ? (
            <p
              className="p-4 text-sm text-center"
              style={{ color: "var(--color-muted)" }}
            >
              {candidates.length === 0
                ? "All library papers are already in this project"
                : "No papers match your search"}
            </p>
          ) : (
            filtered.map((paper) => (
              <label
                key={paper.source_id}
                className="flex items-start gap-3 px-3 py-2.5 cursor-pointer transition-colors hover:bg-[var(--color-panel)]"
                style={{ borderBottom: "1px solid var(--color-border)" }}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(paper.source_id)}
                  onChange={() => toggleId(paper.source_id)}
                  className="mt-0.5 accent-[var(--color-accent)] shrink-0"
                />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span
                    className="text-sm font-medium leading-snug line-clamp-2"
                    style={{ color: "var(--color-text)" }}
                  >
                    {paper.title}
                  </span>
                  <span
                    className="text-xs truncate"
                    style={{ color: "var(--color-muted)" }}
                  >
                    {paper.source_id}
                  </span>
                </div>
              </label>
            ))
          )}
        </div>

        {error && (
          <p className="text-xs" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-xs" style={{ color: "var(--color-muted)" }}>
            {selectedIds.size > 0 ? `${selectedIds.size} selected` : ""}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="muted" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={selectedIds.size === 0 || submitting}
            >
              {submitting ? <Spinner size={14} /> : "Add"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Paper row (minimal inline version — full PaperCard lives in Library)
// ---------------------------------------------------------------------------
interface PaperRowProps {
  paper: Paper;
  checked: boolean;
  onToggle: () => void;
}

function PaperRow({ paper, checked, onToggle }: PaperRowProps) {
  const navigate = useNavigate();
  const authors = Array.isArray(paper.authors)
    ? paper.authors.slice(0, 3).join(", ")
    : paper.authors;

  return (
    <div
      className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-panel)]"
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1 accent-[var(--color-accent)] shrink-0 cursor-pointer"
        onClick={(e) => e.stopPropagation()}
      />
      <div
        className="flex-1 min-w-0 cursor-pointer"
        onClick={() => navigate(`/library/${paper.source_fk}`)}
      >
        <p
          className="text-sm font-medium leading-snug line-clamp-2"
          style={{ color: "var(--color-text)" }}
        >
          {paper.title}
        </p>
        {authors && (
          <p className="text-xs mt-0.5 truncate" style={{ color: "var(--color-muted)" }}>
            {authors}
          </p>
        )}
        <p className="text-xs mt-0.5 truncate" style={{ color: "var(--color-muted)" }}>
          {paper.source_id}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export Dialog
// ---------------------------------------------------------------------------
function ExportDialog({
  open,
  onClose,
  projectId,
  projectName,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  projectName?: string;
}) {
  const [includePdfs, setIncludePdfs] = useState(false);
  const [busy, setBusy] = useState<"lxproj" | "bibtex" | "obsidian" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  async function handleExport(format: "lxproj" | "bibtex" | "obsidian") {
    setBusy(format);
    setError(null);
    try {
      if (format === "lxproj") {
        await exportProject(projectId, includePdfs, projectName);
      } else if (format === "bibtex") {
        await exportBibtex(projectId, projectName);
      } else {
        await exportObsidian(projectId, projectName);
      }
      onClose();
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Export Project">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none" style={{ color: "var(--color-text)" }}>
            <input
              type="checkbox"
              checked={includePdfs}
              onChange={(e) => setIncludePdfs(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Include PDFs in .lxproj archive
          </label>
          <p className="text-xs" style={{ color: "var(--color-muted)" }}>
            BibTeX and Obsidian exports include paper metadata only.
          </p>
        </div>

        {error && (
          <p className="text-xs" style={{ color: "var(--color-danger)" }}>{error}</p>
        )}

        <div className="flex gap-2 justify-end pt-1 flex-wrap">
          <Button variant="muted" onClick={onClose}>Cancel</Button>
          <Button variant="muted" onClick={() => handleExport("bibtex")} disabled={!!busy}>
            {busy === "bibtex" ? <Spinner size={14} /> : <><Download size={13} className="mr-1" />BibTeX</>}
          </Button>
          <Button variant="muted" onClick={() => handleExport("obsidian")} disabled={!!busy}>
            {busy === "obsidian" ? <Spinner size={14} /> : <><Download size={13} className="mr-1" />Obsidian</>}
          </Button>
          <Button onClick={() => handleExport("lxproj")} disabled={!!busy}>
            {busy === "lxproj" ? <Spinner size={14} /> : <><Download size={13} className="mr-1" />.lxproj</>}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { selectedIds, toggle, clear } = useSelectionStore();

  // Clear selection on mount/unmount to avoid leaking state to other pages
  useEffect(() => {
    clear();
    return () => clear();
  }, [id, clear]);

  const [editOpen, setEditOpen] = useState(false);
  const [addPapersOpen, setAddPapersOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const projectId = Number(id);

  const {
    data: project,
    isLoading: projectLoading,
    isError: projectError,
    error: projectFetchError,
  } = useQuery({
    queryKey: ["project", id],
    queryFn: () => getProject(projectId),
    enabled: Boolean(id),
  });

  const {
    data: papersData,
    isLoading: papersLoading,
  } = useQuery({
    queryKey: ["papers"],
    queryFn: () => listPapers(),
    enabled: Boolean(project),
  });

  const projectPapers: Paper[] = project && papersData
    ? papersData.papers.filter((p) =>
        project.source_ids.includes(p.source_id)
      )
    : [];

  async function handleRemoveSelected() {
    if (selectedIds.size === 0) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await Promise.all(
        [...selectedIds].map((sid) => removePaperFromProject(projectId, sid))
      );
      await queryClient.invalidateQueries({
        queryKey: ["project", id],
      });
      clear();
    } catch (err) {
      setRemoveError(
        err instanceof Error ? err.message : "Failed to remove papers"
      );
    } finally {
      setRemoving(false);
    }
  }

  // ------ Render states ------
  if (projectLoading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <Spinner size={28} />
      </div>
    );
  }

  if (projectError || !project) {
    return (
      <div className="p-8">
        <Link
          to="/projects"
          className="inline-flex items-center gap-1.5 text-sm mb-4 transition-colors"
          style={{ color: "var(--color-muted)" }}
        >
          <ArrowLeft size={14} /> Projects
        </Link>
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          {projectFetchError instanceof Error
            ? projectFetchError.message
            : "Project not found"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-8 overflow-y-auto">
      {/* Back nav */}
      <Link
        to="/projects"
        className="inline-flex items-center gap-1.5 text-sm w-fit transition-colors"
        style={{ color: "var(--color-muted)" }}
        onMouseEnter={(e) =>
          ((e.currentTarget as HTMLAnchorElement).style.color =
            "var(--color-text)")
        }
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLAnchorElement).style.color =
            "var(--color-muted)")
        }
      >
        <ArrowLeft size={14} />
        Projects
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <ColorSwatch color={project.color_hex} size={16} />
            <h1
              className="text-2xl font-semibold leading-tight truncate"
              style={{ color: "var(--color-text)" }}
            >
              {project.name}
            </h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="muted" size="sm" onClick={() => setImportOpen(true)}>
              <Upload size={13} className="mr-1" />Import
            </Button>
            <Button variant="muted" size="sm" onClick={() => setExportOpen(true)}>
              <Download size={13} className="mr-1" />Export
            </Button>
            <Button variant="muted" size="sm" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
          </div>
        </div>

        {project.description && (
          <p className="text-sm" style={{ color: "var(--color-muted)" }}>
            {project.description}
          </p>
        )}

        {project.project_tags.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {project.project_tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        )}
      </div>

      {/* Papers section */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2
            className="text-base font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            Papers in this project
          </h2>
          <Button
            variant="muted"
            size="sm"
            onClick={() => setAddPapersOpen(true)}
          >
            Add Papers
          </Button>
        </div>

        {/* Selection action bar */}
        {selectedIds.size > 0 && (
          <div
            className="flex items-center justify-between rounded-lg px-4 py-2.5"
            style={{
              backgroundColor: "var(--color-panel)",
              border: "1px solid var(--color-border)",
            }}
          >
            <span className="text-sm" style={{ color: "var(--color-text)" }}>
              {selectedIds.size} paper{selectedIds.size !== 1 ? "s" : ""} selected
            </span>
            <div className="flex items-center gap-2">
              {removeError && (
                <span
                  className="text-xs"
                  style={{ color: "var(--color-danger)" }}
                >
                  {removeError}
                </span>
              )}
              <Button variant="muted" size="sm" onClick={clear}>
                Clear
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleRemoveSelected}
                disabled={removing}
              >
                {removing ? <Spinner size={12} /> : "Remove from Project"}
              </Button>
            </div>
          </div>
        )}

        {/* Papers list */}
        <div
          className="rounded-lg border border-[var(--color-border)] overflow-hidden"
          style={{ backgroundColor: "var(--color-bg)" }}
        >
          {papersLoading ? (
            <div className="flex items-center justify-center p-8">
              <Spinner size={22} />
            </div>
          ) : projectPapers.length === 0 ? (
            <p
              className="p-6 text-sm text-center"
              style={{ color: "var(--color-muted)" }}
            >
              No papers in this project yet. Click "Add Papers" to get started.
            </p>
          ) : (
            projectPapers.map((paper) => (
              <PaperRow
                key={paper.source_id}
                paper={paper}
                checked={selectedIds.has(paper.source_id)}
                onToggle={() => toggle(paper.source_id)}
              />
            ))
          )}
        </div>
      </div>

      {/* TODO: project-level notes */}
      {/* Notes are available on individual paper detail pages within this project. */}
      {/* A project-level notes panel could be added here once the API supports */}
      {/* querying notes by project_id without requiring a source_id. */}

      {/* Dialogs */}
      {project && (
        <>
          <EditProjectDialog
            open={editOpen}
            onClose={() => setEditOpen(false)}
            projectId={projectId}
            initialName={project.name}
            initialDescription={project.description}
            initialColor={project.color_hex}
          />
          <AddPapersDialog
            open={addPapersOpen}
            onClose={() => setAddPapersOpen(false)}
            projectId={projectId}
            existingSourceIds={project.source_ids}
          />
          <ExportDialog
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            projectId={projectId}
            projectName={project.name}
          />
          <ImportDialog
            open={importOpen}
            onClose={() => setImportOpen(false)}
            projectId={projectId}
            onDone={(newProjectIds) => {
              setImportOpen(false);
              queryClient.invalidateQueries({ queryKey: ["project", id] });
              queryClient.invalidateQueries({ queryKey: ["papers"] });
              const newId = newProjectIds[0];
              if (newId && newId !== projectId) {
                navigate(`/projects/${newId}`);
              }
            }}
          />
        </>
      )}
    </div>
  );
}
