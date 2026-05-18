import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listPapers, deletePaper } from "../api/papers";
import { listProjects, addPaperToProject } from "../api/projects";
import { useSelectionStore } from "../stores/selection";
import type { Paper } from "../types/api";
import { Spinner } from "../components/ui/spinner";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { PaperCard } from "../components/papers/PaperCard";
import { SelectionBar } from "../components/papers/SelectionBar";

type FilterMode = "all" | "has_pdf" | "no_pdf";

function normalizeAuthors(authors: string | string[]): string[] {
  if (Array.isArray(authors)) return authors;
  return authors.split(",").map((a) => a.trim()).filter(Boolean);
}

function matchesPaper(paper: Paper, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  if (paper.title.toLowerCase().includes(q)) return true;
  const authors = normalizeAuthors(paper.authors ?? []);
  return authors.some((a) => a.toLowerCase().includes(q));
}

export default function LibraryPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectPickerError, setProjectPickerError] = useState<string | null>(null);

  const { selectedIds, clear } = useSelectionStore();

  const {
    data: papersData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["papers"],
    queryFn: () => listPapers(500, 0),
  });

  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
    enabled: projectPickerOpen,
  });

  const deleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      await Promise.all(ids.map((id) => deletePaper(id)));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["papers"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      clear();
    },
  });

  const addToProjectMutation = useMutation({
    mutationFn: async ({
      projectId,
      sourceIds,
    }: {
      projectId: number;
      sourceIds: string[];
    }) => {
      await Promise.all(
        sourceIds.map((id) => addPaperToProject(projectId, id))
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setProjectPickerOpen(false);
      setProjectPickerError(null);
      clear();
    },
    onError: (err) => {
      setProjectPickerError(
        err instanceof Error ? err.message : "Failed to add papers to project"
      );
    },
  });

  const allPapers = papersData?.papers ?? [];

  const filtered = allPapers.filter((paper) => {
    if (!matchesPaper(paper, search)) return false;
    if (filterMode === "has_pdf") return paper.has_pdf;
    if (filterMode === "no_pdf") return !paper.has_pdf;
    return true;
  });

  function handleDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    deleteMutation.mutate(ids);
  }

  function handleAddToProject(projectId: number) {
    const ids = Array.from(selectedIds);
    addToProjectMutation.mutate({ projectId, sourceIds: ids });
  }

  const filterLabels: { mode: FilterMode; label: string }[] = [
    { mode: "all", label: "All" },
    { mode: "has_pdf", label: "Has PDF" },
    { mode: "no_pdf", label: "No PDF" },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size={28} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          {error instanceof Error ? error.message : "Failed to load papers"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="shrink-0 px-6 py-4 border-b border-border space-y-3">
        <div className="flex items-center gap-3">
          <Input
            placeholder="Search by title or author…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-sm"
          />
          <span className="text-muted text-sm shrink-0">
            {filtered.length} paper{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {filterLabels.map(({ mode, label }) => (
            <button
              key={mode}
              onClick={() => setFilterMode(mode)}
              className={[
                "px-3 py-1 rounded-full text-xs font-medium transition-colors border",
                filterMode === mode
                  ? "border-[var(--color-accent)] text-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]"
                  : "border-border text-muted hover:border-[var(--color-muted)]",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Paper list */}
      <div
        className="flex-1 overflow-y-auto px-6 py-4 space-y-3"
        style={{ paddingBottom: selectedIds.size > 0 ? "80px" : undefined }}
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-muted text-sm">
              {allPapers.length === 0
                ? "No papers yet. Add some from the Search page."
                : "No papers match your filter."}
            </p>
          </div>
        ) : (
          filtered.map((paper) => (
            <PaperCard
              key={paper.source_id}
              paper={paper}
              showCheckbox
              onNavigate={(id) => navigate(`/library/${id}`)}
            />
          ))
        )}
      </div>

      {/* Selection bar */}
      <SelectionBar
        count={selectedIds.size}
        onAddToProject={() => setProjectPickerOpen(true)}
        onDelete={handleDelete}
        onClear={clear}
      />

      {/* Add to project dialog */}
      <Dialog
        open={projectPickerOpen}
        onClose={() => {
          setProjectPickerOpen(false);
          setProjectPickerError(null);
        }}
        title="Add to Project"
      >
        <div className="space-y-3">
          {projectPickerError && (
            <p className="text-sm" style={{ color: "var(--color-danger)" }}>
              {projectPickerError}
            </p>
          )}
          {!projectsData?.projects?.length ? (
            <p className="text-muted text-sm">No projects found.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {projectsData.projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => handleAddToProject(project.id)}
                  disabled={addToProjectMutation.isPending}
                  className="w-full text-left px-3 py-2 rounded-md border border-border hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] text-text text-sm transition-colors disabled:opacity-50"
                >
                  {project.name}
                  {project.description && (
                    <span className="block text-xs text-muted mt-0.5 truncate">
                      {project.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="flex justify-end pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setProjectPickerOpen(false);
                setProjectPickerError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
