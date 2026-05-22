import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useThemeStore } from "../stores/theme";
import { getColors } from "../lib/theme";
import { listProjects, addPaperToProject } from "../api/projects";
import { Spinner } from "../components/ui/spinner";
import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";

export default function GraphPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const preset = useThemeStore(s => s.preset);
  const mode = useThemeStore(s => s.mode);
  const overrides = useThemeStore(s => s.overrides);
  const overrideAlphas = useThemeStore(s => s.overrideAlphas);

  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectPickerError, setProjectPickerError] = useState<string | null>(null);

  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ["projects", "active"],
    queryFn: () => listProjects(),
    enabled: projectPickerOpen,
  });

  const addToProjectMutation = useMutation({
    mutationFn: async ({ projectId, sourceIds }: { projectId: number; sourceIds: string[] }) => {
      const results = await Promise.allSettled(
        sourceIds.map(id => addPaperToProject(projectId, id))
      );
      return sourceIds.filter((_, i) => results[i].status === "rejected");
    },
    onMutate: () => {
      setProjectPickerError(null);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onSuccess: (failedIds, { sourceIds }) => {
      if (failedIds.length > 0) {
        setSelectedSourceIds(failedIds);
        setProjectPickerError(
          `${failedIds.length} of ${sourceIds.length} paper${sourceIds.length !== 1 ? "s" : ""} could not be added`
        );
      } else {
        setProjectPickerOpen(false);
        setProjectPickerError(null);
        setSelectedSourceIds([]);
        postToIframe({ type: "clear_selection" });
      }
    },
    onError: (err) => {
      setProjectPickerError(err instanceof Error ? err.message : "Failed to add papers to project");
    },
  });

  function postToIframe(msg: object) {
    iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin);
  }

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!e.data || typeof e.data !== "object") return;
      if (e.origin !== window.location.origin) return;
      if (e.data.type === "paper_clicked" && typeof e.data.id === "string") {
        setSelectedSourceIds([]);
        navigate(`/library/${e.data.id}`);
      } else if (e.data.type === "selection_changed" && Array.isArray(e.data.sourceIds)) {
        setSelectedSourceIds(e.data.sourceIds);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [navigate]);

  const sendTheme = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    const colors = getColors(preset, mode, overrides, overrideAlphas);
    iframe.contentWindow.postMessage({ type: "theme_update", colors }, window.location.origin);
  }, [preset, mode, overrides, overrideAlphas]);

  useEffect(() => {
    sendTheme();
  }, [sendTheme]);

  function handleClearSelection() {
    setSelectedSourceIds([]);
    postToIframe({ type: "clear_selection" });
  }

  return (
    <div className="w-full h-full flex flex-col">
      <div className="p-4 border-b border-border flex items-center gap-3">
        <h1 className="text-lg font-semibold text-text">Knowledge Graph</h1>
        <span className="text-sm text-muted">
          {selectedSourceIds.length > 0
            ? `${selectedSourceIds.length} paper${selectedSourceIds.length !== 1 ? "s" : ""} selected — Ctrl/Cmd+click to add more`
            : "Click a node to open · Ctrl/Cmd+click to select"}
        </span>
      </div>
      <iframe
        ref={iframeRef}
        src="/graph/graph.html"
        className="flex-1 border-0 w-full"
        title="Paper knowledge graph"
        onLoad={sendTheme}
      />

      {selectedSourceIds.length > 0 && (
        <div
          className="shrink-0 flex items-center justify-between px-6 py-3 border-t border-border shadow-lg"
          style={{ backgroundColor: "var(--color-panel)" }}
        >
          <span className="text-sm font-medium text-text">
            {selectedSourceIds.length} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleClearSelection}>
              Clear
            </Button>
            <Button variant="muted" size="sm" onClick={() => setProjectPickerOpen(true)}>
              Add to Project
            </Button>
          </div>
        </div>
      )}

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
          {projectsLoading ? (
            <div className="flex items-center justify-center py-4">
              <Spinner size={20} />
            </div>
          ) : !projectsData?.projects?.length ? (
            <p className="text-muted text-sm">No projects found.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {projectsData.projects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  onClick={() =>
                    addToProjectMutation.mutate({ projectId: project.id, sourceIds: selectedSourceIds })
                  }
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
