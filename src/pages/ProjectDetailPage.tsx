import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useNavigationType, useLocation, Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Download, FolderOpen, GitFork, History, Upload } from "lucide-react";
import {
  getProject,
  createProject,
  addPapers,
  removePaperFromProject,
  archiveProject,
  restoreProject,
  deleteProject,
} from "../api/projects";
import { listReceived, sharingAvailable } from "../api/share";
import { receivedShareRole } from "../lib/shareRole";
import { listProjectPapers } from "../api/papers";
import { ImportDialog } from "../components/import/ImportDialog";
import { HistoryDialog } from "../components/history/HistoryDialog";
import { useUrlDialog } from "../hooks/useUrlDialog";
import type { Paper } from "../types/api";
import { useSelectionStore } from "../stores/selection";
import { ColorSwatch } from "../components/projects/ColorSwatch";
import { EditProjectDialog } from "../components/projects/EditProjectDialog";
import { AddPapersDialog } from "../components/projects/AddPapersDialog";
import { PaperRow } from "../components/projects/PaperRow";
import { SelectionBar, SelectionBarButton } from "../components/papers/SelectionBar";
import { ExportDialog } from "../components/projects/ExportDialog";
import { Button } from "../components/ui/button";
import { TagBadge } from "../components/tags/TagBadge";
import { Spinner } from "../components/ui/spinner";
import { LogoMark } from "../components/ui/logo-mark";
import { EmptyState } from "../components/ui/empty-state";
import { READING_LIST_TAG } from "../lib/readingStatus";
import {
  invalidateProjectMembershipQueries,
  invalidateProjectMutationQueries,
  partialFailureMessage,
} from "../lib/paperMutations";
import { errText } from "../lib/errText";
import { useConfirmWithTimeout } from "../hooks/useConfirmWithTimeout";
import { copyItem, showContextMenu } from "../lib/contextMenu";
import { isArxivPaper, landingUrl } from "../lib/papers";
import { openExternalUrl } from "../api/updates";

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const queryClient = useQueryClient();

  const { selectedIds, select, clear, selectAll } = useSelectionStore();

  // Clear selection on mount/unmount.
  useEffect(() => {
    clear();
    return () => clear();
  }, [id, clear]);

  const [editOpen, setEditOpen] = useState(false);
  const [addPapersOpen, setAddPapersOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const { open: historyOpen, show: openHistory, close: closeHistory } =
    useUrlDialog("history");
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    function handleOutside(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
        disarm();
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") { setMoreOpen(false); disarm(); }
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [moreOpen]);

  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const { confirm: confirmDelete, arm, disarm } = useConfirmWithTimeout();
  const [importOpen, setImportOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // The route element isn't keyed by :id, so a param change reuses this
  // instance and its banners would outlive the project that raised them.
  // Declared before the notice effect below, which re-sets on the same render.
  useEffect(() => {
    setStatusError(null);
    setRemoveError(null);
  }, [id]);

  const location = useLocation();
  const arrivalNotice = (location.state as { notice?: string } | null)?.notice;
  useEffect(() => {
    // Returns when absent: stripping the notice re-runs this with none left,
    // and assigning null there would clear the banner just set.
    if (!arrivalNotice) return;
    setStatusError(arrivalNotice);
    navigate(location.pathname, { replace: true, state: null });
  }, [arrivalNotice, location.pathname, navigate]);

  const projectId = id && /^\d+$/.test(id) ? parseInt(id, 10) : NaN;

  const {
    data: project,
    isLoading: projectLoading,
    isError: projectError,
    error: projectFetchError,
  } = useQuery({
    queryKey: ["project", id],
    queryFn: () => getProject(projectId),
    enabled: !isNaN(projectId),
  });

  // Server-filtered by membership, so projects past the old 200-paper default
  // window render completely.
  const {
    data: papersData,
    isLoading: papersLoading,
  } = useQuery({
    queryKey: ["papers", { project: projectId }],
    queryFn: () => listProjectPapers(projectId),
    enabled: Boolean(project),
  });

  // §7 viewer read-only: viewer capability on the share behind `share_id`
  // hides every edit affordance (unmounted, not disabled). Unknown role →
  // editable; receivedShareRole's doc covers why that's safe.
  const { data: receivedShares } = useQuery({
    queryKey: ["share", "received"],
    queryFn: listReceived,
    enabled: sharingAvailable && Boolean(project?.share_id),
  });
  const readOnly = receivedShareRole(project, receivedShares) === "viewer";

  // §7 fork: deep-copy the shared project into an independent local project
  // the user owns (new ids, never synced back), then jump to it.
  async function handleFork() {
    if (!project || statusBusy) return;
    setStatusBusy(true);
    setStatusError(null);
    try {
      const { project: created } = await createProject({
        name: `${project.name} (copy)`,
        description: project.description,
        color_hex: project.color_hex,
        project_tags: project.project_tags,
      });
      // ponytail: copies project metadata + paper links; project-scoped
      // notes/annotations stay with the original (NOTE/ANNOTATION.PROJECT_FK).
      // As in createProjectWithPapers: the project exists even when the add
      // rejects, so a reject counts as every id failing rather than escaping.
      let failed: string[] = [];
      let addError: string | null = null;
      try {
        failed = await addPapers({ projectId: created.id, sourceIds: project.source_ids });
      } catch (err) {
        // A transport/server reject is not the same as unresolvable ids, so it
        // carries its own message rather than a per-paper count.
        failed = project.source_ids;
        addError = errText(err, "Failed to add papers to the fork");
      }
      await invalidateProjectMembershipQueries(queryClient);
      const notice =
        addError ??
        (failed.length > 0
          ? partialFailureMessage(failed.length, project.source_ids.length)
          : null);
      navigate(`/projects/${created.id}`, { state: notice ? { notice } : null });
    } catch (err) {
      setStatusError(errText(err, "Failed to fork project"));
    } finally {
      setStatusBusy(false);
    }
  }

  const projectPapers: Paper[] = (project && papersData?.papers) || [];

  async function removePapers(idsArray: string[]) {
    if (idsArray.length === 0 || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const results = await Promise.allSettled(
        idsArray.map((sid) => removePaperFromProject(projectId, sid))
      );
      const failedIds = idsArray.filter((_, i) => results[i].status === "rejected");
      // Reading statuses need no client cleanup: PAPER_TO_READING's composite
      // FK cascades away with the membership row. Drop the removed ids from
      // the LIVE selection (not this render's snapshot, and never wholesale —
      // a context-menu removal must not wipe an unrelated selection), keeping
      // failed ids selected so a retry via the bar acts on them.
      const live = useSelectionStore.getState().selectedIds;
      selectAll([
        ...new Set([
          ...[...live].filter((sid) => !idsArray.includes(sid)),
          ...failedIds,
        ]),
      ]);
      if (failedIds.length > 0) {
        setRemoveError(
          `Failed to remove ${failedIds.length} paper${failedIds.length !== 1 ? "s" : ""}`
        );
      }
      await invalidateProjectMembershipQueries(queryClient);
    } catch (err) {
      setRemoveError(errText(err, "Failed to remove papers"));
    } finally {
      setRemoving(false);
    }
  }

  function handleRemoveSelected() {
    return removePapers([...selectedIds]);
  }

  // Right-click in a multi-selection acts on the whole selection; otherwise on
  // the clicked row alone.
  function handleRowContextMenu(e: React.MouseEvent, paper: Paper) {
    const ids =
      selectedIds.has(paper.source_id) && selectedIds.size > 1
        ? [...selectedIds]
        : [paper.source_id];
    const url = landingUrl(paper);
    showContextMenu(e, [
      {
        text: "Open",
        action: () =>
          navigate(`/library/${paper.source_fk}`, {
            state: { fromProjectId: projectId },
          }),
      },
      ...(url && !isArxivPaper(paper)
        ? [
            {
              text: "Open Page",
              action: () => void openExternalUrl(url).catch(console.error),
            },
          ]
        : []),
      "separator",
      copyItem("Copy ID", paper.source_id),
      ...(paper.doi ? [copyItem("Copy DOI", paper.doi)] : []),
      ...(!readOnly
        ? ([
            "separator",
            {
              text: `Remove${ids.length > 1 ? ` ${ids.length} Papers` : ""} from Project`,
              action: () => void removePapers(ids),
              enabled: !removing,
            },
          ] as const)
        : []),
    ]);
  }

  async function handleArchive() {
    setStatusBusy(true);
    setStatusError(null);
    try {
      await archiveProject(projectId);
      await invalidateProjectMutationQueries(queryClient);
      navigate("/projects");
    } catch (err) {
      setStatusError(errText(err, "Failed to archive project"));
    } finally {
      setStatusBusy(false);
    }
  }

  async function handleRestore() {
    setStatusBusy(true);
    setStatusError(null);
    try {
      await restoreProject(projectId);
      await invalidateProjectMutationQueries(queryClient);
    } catch (err) {
      setStatusError(errText(err, "Failed to restore project"));
    } finally {
      setStatusBusy(false);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) {
      arm();
      return;
    }
    disarm();
    setStatusBusy(true);
    setStatusError(null);
    try {
      await deleteProject(projectId);
      await invalidateProjectMutationQueries(queryClient);
      navigate("/projects");
    } catch (err) {
      setStatusError(errText(err, "Failed to delete project"));
    } finally {
      setStatusBusy(false);
    }
  }

  // ------ Render states ------
  if (projectLoading) {
    return (
      <div role="status" aria-label="Loading" className="flex-1 flex items-center justify-center h-full">
        <LogoMark size={48} className="animate-pulse" />
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
          {errText(projectFetchError, "Project not found")}
        </p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-6 p-8 overflow-y-auto ${!readOnly && selectedIds.size > 0 ? "pb-20" : ""}`}>
      {/* Back nav */}
      <button
        onClick={() => navType !== "POP" ? navigate(-1) : navigate("/projects")}
        className="inline-flex items-center gap-1.5 text-sm w-fit transition-colors text-muted hover:text-text"
      >
        <ArrowLeft size={14} />
        Back
      </button>

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
            {readOnly && (
              <span
                className="shrink-0 rounded-full border px-2 py-1 font-mono text-[10.5px] font-semibold leading-none"
                style={{
                  color: "var(--color-muted)",
                  borderColor: "var(--color-border)",
                  backgroundColor: "var(--color-surface-2)",
                }}
              >
                Viewer · read only
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {readOnly && (
              <Button variant="muted" size="sm" onClick={handleFork} disabled={statusBusy}>
                {statusBusy ? (
                  <Spinner size={13} />
                ) : (
                  <>
                    <GitFork size={13} className="mr-1" />Fork to my library
                  </>
                )}
              </Button>
            )}
            {!readOnly && (
              <Button variant="muted" size="sm" onClick={() => setImportOpen(true)}>
                <Upload size={13} className="mr-1" />Import
              </Button>
            )}
            <Button variant="muted" size="sm" onClick={() => setExportOpen(true)}>
              <Download size={13} className="mr-1" />Export
            </Button>
            <Button variant="muted" size="sm" onClick={openHistory}>
              <History size={13} className="mr-1" />History
            </Button>
            {!readOnly && (
              <Button variant="muted" size="sm" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
            )}
            {!readOnly && (
            <div className="relative" ref={moreRef}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setMoreOpen((v) => !v); disarm(); }}
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
              >
                ···
              </Button>
              {moreOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1 z-50 rounded-md border border-border shadow-lg py-1 min-w-28"
                  style={{ background: "var(--color-panel)" }}
                >
                  {project.status === "active" && (
                    <button
                      type="button"
                      role="menuitem"
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-40"
                      onClick={() => { setMoreOpen(false); handleArchive(); }}
                      disabled={statusBusy}
                    >
                      {statusBusy ? <Spinner size={12} /> : "Archive"}
                    </button>
                  )}
                  {project.status === "archived" && (
                    <button
                      type="button"
                      role="menuitem"
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-text)] disabled:opacity-40"
                      onClick={() => { setMoreOpen(false); handleRestore(); }}
                      disabled={statusBusy}
                    >
                      {statusBusy ? <Spinner size={12} /> : "Restore"}
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-[var(--color-border)] disabled:opacity-40"
                    style={{ color: "var(--color-danger)" }}
                    onClick={handleDelete}
                    disabled={statusBusy}
                  >
                    {confirmDelete ? "Confirm delete?" : "Delete"}
                  </button>
                </div>
              )}
            </div>
            )}
          </div>
        </div>

        {project.description && (
          <p className="text-sm" style={{ color: "var(--color-muted)" }}>
            {project.description}
          </p>
        )}

        {statusError && (
          <p className="text-xs" style={{ color: "var(--color-danger)" }}>
            {statusError}
          </p>
        )}

        {project.project_tags.filter((t) => t.toLowerCase() !== READING_LIST_TAG).length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            {project.project_tags
              .filter((t) => t.toLowerCase() !== READING_LIST_TAG)
              .map((tag) => (
                <TagBadge key={tag} label={tag} />
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
          {!readOnly && (
            <Button
              variant="muted"
              size="sm"
              onClick={() => setAddPapersOpen(true)}
            >
              Add Papers
            </Button>
          )}
        </div>

        {/* Selection action bar */}
        {!readOnly && (
          <SelectionBar count={selectedIds.size} onClear={clear}>
            {removeError && (
              <span className="px-2.5 text-xs" style={{ color: "var(--color-danger)" }}>
                {removeError}
              </span>
            )}
            <SelectionBarButton danger onClick={handleRemoveSelected} disabled={removing}>
              {removing ? <Spinner size={12} /> : "Remove from Project"}
            </SelectionBarButton>
          </SelectionBar>
        )}

        {/* Papers list */}
        <div
          className="rounded-lg border border-[var(--color-border)] overflow-hidden"
          style={{ backgroundColor: "var(--color-bg)" }}
        >
          {papersLoading ? (
            <div role="status" aria-label="Loading" className="flex items-center justify-center p-8">
              <LogoMark size={32} className="animate-pulse" />
            </div>
          ) : projectPapers.length === 0 ? (
            <EmptyState
              icon={<FolderOpen size={28} strokeWidth={1.5} />}
              title="No papers in this project"
              description={
                readOnly
                  ? "This shared project has no papers yet."
                  : "Add papers from your library to start organizing this project."
              }
              actionLabel={readOnly ? undefined : "Add Papers"}
              onAction={readOnly ? undefined : () => setAddPapersOpen(true)}
            />
          ) : (
            projectPapers.map((paper) => (
              <PaperRow
                key={paper.source_id}
                paper={paper}
                checked={selectedIds.has(paper.source_id)}
                onSelect={(mods) => select(paper.source_id, mods, projectPapers.map((p) => p.source_id))}
                projectId={projectId}
                project={project}
                selectable={!readOnly}
                onContextMenu={(e) => handleRowContextMenu(e, paper)}
              />
            ))
          )}
        </div>
      </div>

      {/* TODO: project-level notes panel — GET /api/notes 422s without a
          source_id, so notes are reachable only per paper. */}

      {/* Dialogs (edit affordances unmounted entirely on viewer shares) */}
      {project && (
        <>
          {!readOnly && (
            <EditProjectDialog
              key={`edit-${projectId}`}
              open={editOpen}
              onClose={() => setEditOpen(false)}
              projectId={projectId}
              initialName={project.name}
              initialDescription={project.description}
              initialColor={project.color_hex}
              initialTags={project.project_tags}
            />
          )}
          {!readOnly && (
            <AddPapersDialog
              key={`add-${projectId}`}
              open={addPapersOpen}
              onClose={() => setAddPapersOpen(false)}
              projectId={projectId}
              existingSourceIds={project.source_ids}
            />
          )}
          <ExportDialog
            key={`export-${projectId}`}
            open={exportOpen}
            onClose={() => setExportOpen(false)}
            projectId={projectId}
            projectName={project.name}
          />
          <HistoryDialog
            open={historyOpen}
            onClose={closeHistory}
            scope={{ kind: "project", id: projectId }}
            title={`History: ${project.name}`}
          />
          {!readOnly && (
            <ImportDialog
              open={importOpen}
              onClose={() => setImportOpen(false)}
              projectId={projectId}
              onDone={(newProjectIds) => {
                setImportOpen(false);
                const newId = newProjectIds[0];
                if (newId && newId !== projectId) {
                  navigate(`/projects/${newId}`);
                }
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
