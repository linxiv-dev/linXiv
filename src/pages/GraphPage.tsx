import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Network } from "lucide-react";

import { useThemeStore } from "../stores/theme";
import { useUiStore } from "../stores/ui";
import { getColors } from "../lib/theme";
import { getGraphView } from "../api/graph";
import { listProjects } from "../api/projects";
import {
  addToProjectMutationOptions,
  createProjectMutationOptions,
  onGraphDirtying,
} from "../lib/paperMutations";
import { indexView } from "../lib/graph/model";
import type { GraphFilterState } from "../lib/graph/filter";
import { EMPTY_FILTER, joinTypes, matchGraph, noMatchCause } from "../lib/graph/filter";
import type { ForceSettings } from "../lib/graph/layout";
import { DEFAULT_FORCES } from "../lib/graph/layout";
import type { GraphCanvasHandle, GraphNodeContext } from "../components/graph/GraphCanvas";
import { copyItem, showContextMenu } from "../lib/contextMenu";
import GraphPanels from "../components/graph/GraphPanels";
import { LogoMark } from "../components/ui/logo-mark";
import { Button } from "../components/ui/button";
import { SelectionBar, SelectionBarButton } from "../components/papers/SelectionBar";
import { formSubmitOnCtrlEnter } from "../lib/submitShortcut";
import { Dialog } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { EmptyState } from "../components/ui/empty-state";

// cytoscape and d3-force are ~400kB of the bundle and are needed by exactly one
// screen. AppShell imports this page eagerly (it is keep-alive, so it must exist
// from boot), so a lazy PAGE would not help — the canvas is the boundary that
// does: it is not rendered until the first visit to /graph.
const GraphCanvas = lazy(() => import("../components/graph/GraphCanvas"));

// Root query keys whose invalidation may change graph-relevant data. The weaker
// of this page's two staleness signals: react-query emits an `invalidate` cache
// event only for queries actually in the cache, so a key here is heard only
// while some page holds one under it. It stays because it covers the call sites
// that invalidate directly instead of going through src/lib/paperMutations.ts
// (StorageSection's blanket invalidate, the ORCID backfill); `onGraphDirtying`
// below covers the operations that registry owns.
const GRAPH_DIRTYING_KEYS = new Set([
  "stats", "papers", "paper", "projects", "project", "tags", "tag", "authors", "author",
]);

export default function GraphPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canvasRef = useRef<GraphCanvasHandle>(null);
  const preset = useThemeStore((s) => s.preset);
  const mode = useThemeStore((s) => s.mode);
  const overrides = useThemeStore((s) => s.overrides);
  const overrideAlphas = useThemeStore((s) => s.overrideAlphas);
  const hideSingleAuthors = useUiStore((s) => s.hideSingleAuthors);
  const setHideSingleAuthors = useUiStore((s) => s.setHideSingleAuthors);

  const theme = useMemo(
    () => getColors(preset, mode, overrides, overrideAlphas),
    [preset, mode, overrides, overrideAlphas]
  );

  const [filter, setFilter] = useState<GraphFilterState>(EMPTY_FILTER);
  const [forces, setForces] = useState<ForceSettings>(DEFAULT_FORCES);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectPickerError, setProjectPickerError] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [dirty, setDirty] = useState(false);

  // AppShell's keep-alive renders this page from app BOOT under `display:
  // none`, where the container lays out 0x0 and cytoscape's fit bails silently —
  // the layout would settle off-screen at zoom 1, and every user would pay the
  // fetch plus the force layout at startup. Mount on the first visit instead; it
  // then stays mounted, so leaving and coming back keeps the settled layout.
  const onGraphRoute = useLocation().pathname === "/graph";
  const [visited, setVisited] = useState(false);
  useEffect(() => {
    if (onGraphRoute) setVisited(true);
  }, [onGraphRoute]);

  const {
    data: view,
    isPending,
    isFetching,
    error,
    refetch,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["graph", hideSingleAuthors],
    queryFn: () => getGraphView(hideSingleAuthors),
    enabled: visited,
    // "Hide single-paper authors" is applied by the BACKEND, so toggling it
    // switches to a query key with nothing cached under it. Without this, `data`
    // drops to undefined for that fetch and unmounts the canvas and panels — the
    // settled positions and last viewport live in refs inside GraphCanvas and
    // die with it, so the payload would land as a COLD load and be reframed.
    placeholderData: keepPreviousData,
    // Fetch when ASKED to and at no other time: a new payload rebuilds the
    // simulation and re-anneals from alpha 1, drifting an arrangement the user
    // built and yanking a grabbed node out from under a drag. These settings
    // close react-query's automatic refetches; the invalidation side is held by
    // `refetchType: "none"` in src/lib/paperMutations.ts. Refresh calls
    // `refetch()`, which ignores all of this and is the point.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const index = useMemo(() => (view ? indexView(view) : null), [view]);

  // Typing in a filter box re-matches every paper. Deferring keeps the keystroke
  // responsive and drops superseded passes on its own, without the guessed
  // debounce interval it replaces.
  const deferredFilter = useDeferredValue(filter);
  const match = useMemo(
    () => (view && index ? matchGraph(view, index, deferredFilter) : null),
    [view, index, deferredFilter]
  );

  // Selected papers the current filter state does not DRAW at all: everything
  // when the Papers checkbox is off, and the non-matching ones under isolate.
  const hiddenSelectedCount = useMemo(() => {
    if (!match || selectedIds.size === 0) return 0;
    if (match.hiddenTypes.has("paper")) return selectedIds.size;
    if (!match.isolate) return 0;
    let n = 0;
    for (const id of selectedIds) if (!match.papers.has(id)) n++;
    return n;
  }, [match, selectedIds]);

  const selectedSourceIds = useMemo(() => {
    if (!index) return [];
    const out: string[] = [];
    for (const id of selectedIds) {
      const source = index.paperById.get(id)?.source_id;
      if (source) out.push(source);
    }
    return out;
  }, [index, selectedIds]);

  const projectPickerUi = {
    setError: setProjectPickerError,
    // The shared partial-failure contract (src/lib/paperMutations.ts) speaks
    // `source_id`, which the canvas does not — map back through the index.
    selectFailures: (sourceIds: string[]) => {
      if (!index) return;
      const wanted = new Set(sourceIds);
      const next = new Set<string>();
      for (const [id, paper] of index.paperById) {
        if (wanted.has(paper.source_id)) next.add(id);
      }
      setSelectedIds(next);
    },
    onDone: () => {
      setProjectPickerOpen(false);
      setSelectedIds(new Set());
    },
    clearName: () => setNewProjectName(""),
  };

  const addToProjectMutation = useMutation(
    addToProjectMutationOptions(queryClient, projectPickerUi)
  );
  const createProjectMutation = useMutation(
    createProjectMutationOptions(queryClient, projectPickerUi)
  );

  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => listProjects(),
    enabled: projectPickerOpen,
  });

  // Flag the Refresh button when a query holding graph-relevant data is
  // invalidated elsewhere (this page is keep-alive, so it sees those events).
  // Bumped on every dirtying signal; the `isFetching` effect below snapshots it
  // so a change landing mid-refresh survives that refresh's success.
  const dirtyEpoch = useRef(0);
  const markDirty = useCallback(() => {
    dirtyEpoch.current++;
    setDirty(true);
  }, []);
  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "invalidate") return;
      const root = event.query.queryKey[0];
      if (typeof root === "string" && GRAPH_DIRTYING_KEYS.has(root)) markDirty();
    });
    return unsubscribe;
  }, [queryClient, markDirty]);

  // The primary signal: the invalidation registry announcing an operation that
  // changes what `/api/graph` would return. Unlike the cache subscription above
  // it does not depend on another page holding a matching query.
  useEffect(() => onGraphDirtying(markDirty), [markDirty]);

  // The dot means "the graph on screen is older than the library", so DATA
  // ARRIVING clears it, not the control that asked for it — a "Hide single-paper
  // authors" toggle re-fetches and redraws too. `dataUpdatedAt` moves only on a
  // SUCCESSFUL fetch, so a failure leaves the dot lit, and the epoch guard
  // spares a change that landed while that fetch was in flight.
  const fetchEpoch = useRef(0);
  useEffect(() => {
    if (isFetching) fetchEpoch.current = dirtyEpoch.current;
  }, [isFetching]);
  useEffect(() => {
    if (!dataUpdatedAt) return;
    if (dirtyEpoch.current === fetchEpoch.current) setDirty(false);
  }, [dataUpdatedAt]);

  const handleRefresh = useCallback(() => {
    void refetch();
  }, [refetch]);

  // The panel column is `position: absolute` over the canvas's right edge, so a
  // plain fit would push the rightmost nodes and their labels underneath it.
  // Measure what it covers and let the canvas frame into the strip that is left.
  const panelsRef = useRef<HTMLDivElement>(null);
  const [gutter, setGutter] = useState(0);
  // Read live by the canvas's fit, which cannot wait for this state to commit.
  // The state above still drives what RENDERS (the no-match notice's centring,
  // the hover inspector's flip point), where a re-render is what is wanted.
  const measureGutter = useCallback(
    () => panelsRef.current?.getBoundingClientRect().width ?? 0,
    []
  );
  useEffect(() => {
    const el = panelsRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setGutter(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const handlePaperTap = useCallback(
    (id: string, additive: boolean) => {
      if (additive) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (!next.delete(id)) next.add(id);
          return next;
        });
        return;
      }
      // This page stays mounted across the route change, so a selection left
      // behind comes back highlighted with an action bar for stale papers.
      setSelectedIds(new Set());
      navigate(`/library/${id}`);
    },
    [navigate]
  );

  const handleAuthorTap = useCallback(
    (authorId: number) => {
      setSelectedIds(new Set());
      navigate(`/authors/${authorId}`);
    },
    [navigate]
  );

  // The same target TagBadge links to everywhere else in the app; TagPage
  // lowercases the param itself, so the node's display casing is fine.
  const handleTagTap = useCallback(
    (label: string) => {
      setSelectedIds(new Set());
      navigate(`/tags/${encodeURIComponent(label)}`);
    },
    [navigate]
  );

  // Open goes wherever a plain tap on the node would have.
  const handleNodeContextMenu = useCallback(
    (e: MouseEvent, node: GraphNodeContext) => {
      showContextMenu(e, [
        {
          text: "Open",
          action: () => {
            if (node.type === "paper") handlePaperTap(node.id, false);
            else if (node.type === "author" && node.authorId != null)
              handleAuthorTap(node.authorId);
            else if (node.type === "tag") handleTagTap(node.label);
          },
        },
        "separator",
        copyItem("Copy Label", node.label),
        ...(node.sourceId ? [copyItem("Copy ID", node.sourceId)] : []),
      ]);
    },
    [handlePaperTap, handleAuthorTap, handleTagTap]
  );

  const handleSelectAllVisible = useCallback(() => {
    if (!match || match.hiddenTypes.has("paper")) return;
    setSelectedIds(new Set(match.papers));
  }, [match]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const clearFilters = useCallback(() => setFilter(EMPTY_FILTER), []);

  const ready = view && index && match;
  const empty = ready && view.papers.length + view.authors.length + view.tags.length === 0;

  return (
    <div className="w-full h-full flex flex-col">
      <div className="p-4 border-b border-border flex items-center gap-3">
        <h1 className="font-display text-[27px] font-semibold leading-tight tracking-[-0.015em] text-text">
          Knowledge Graph
        </h1>
        <span className="text-sm text-muted">
          {selectedIds.size > 0
            ? `${selectedIds.size} paper${selectedIds.size !== 1 ? "s" : ""} selected; Ctrl/Cmd+click to add more`
            : "Click a node to open · Ctrl/Cmd+click to select"}
        </span>
        <div className="ml-auto flex items-center gap-4">
          {/* A refetch that failed over a still-drawn graph says so here rather
              than covering it with the error card — that view is still valid. */}
          {error && view && (
            <span
              role="status"
              className="text-sm max-w-[32ch] truncate"
              style={{ color: "var(--color-danger)" }}
              title={String((error as Error).message ?? error)}
            >
              Refresh failed: {String((error as Error).message ?? error)}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={isFetching}
            title={
              dirty
                ? "Graph data has changed since it was loaded. Click to refresh"
                : "Reload the graph from the latest data"
            }
          >
            {isFetching ? "Refreshing…" : "Refresh"}
            {dirty && !isFetching && (
              <span
                aria-hidden
                className="inline-block w-1.5 h-1.5 rounded-full align-middle"
                style={{ backgroundColor: "var(--color-accent)" }}
              />
            )}
          </Button>
          <label
            className="flex items-center gap-2 text-sm text-muted cursor-pointer select-none"
            title="Drop authors linked to only one paper to declutter the graph. They leave the payload entirely, so the graph's own Author filter can't match them either"
          >
            <input
              type="checkbox"
              checked={hideSingleAuthors}
              onChange={(e) => setHideSingleAuthors(e.target.checked)}
            />
            Hide single-paper authors
          </label>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden" style={{ backgroundColor: "var(--color-bg)" }}>
        {ready && !empty && (
          <>
            <Suspense fallback={<span role="status" aria-label="Loading"><LogoMark size={48} className="animate-pulse" /></span>}>
              <GraphCanvas
                ref={canvasRef}
                view={view}
                index={index}
                theme={theme}
                forces={forces}
                match={match}
                selectedIds={selectedIds}
                gutter={gutter}
                measureGutter={measureGutter}
                onPaperTap={handlePaperTap}
                onAuthorTap={handleAuthorTap}
                onTagTap={handleTagTap}
                onBackgroundTap={clearSelection}
                onNodeContextMenu={handleNodeContextMenu}
              />
            </Suspense>
            {/* A filter matching nothing leaves either a blank rectangle (under
                isolate) or a field of 8% ghosts, neither distinguishable from a
                graph that failed to load. Not a full-bleed overlay either — that
                would bury the panels that undo the filter — so it sits in the
                strip the panel column leaves uncovered. */}
            <NoMatchNotice
              match={match}
              gutter={gutter}
              authorFilter={deferredFilter.author.trim()}
              excludeSingleAuthors={hideSingleAuthors}
              onClearFilters={clearFilters}
              onShowSingleAuthors={() => setHideSingleAuthors(false)}
            />
            <GraphPanels
              columnRef={panelsRef}
              view={view}
              filter={filter}
              onFilterChange={setFilter}
              onClearFilters={clearFilters}
              forces={forces}
              onForcesChange={setForces}
              onRelayout={() => canvasRef.current?.relayout()}
              selectedCount={selectedIds.size}
              hiddenSelectedCount={hiddenSelectedCount}
              onSelectAllVisible={handleSelectAllVisible}
              onClearSelection={clearSelection}
            />
          </>
        )}

        {(!ready || empty) && (
          <div
            className="absolute inset-0 overflow-y-auto flex items-center justify-center"
            style={{ backgroundColor: "var(--color-bg)" }}
          >
            {isPending || !visited ? (
              <span role="status" aria-label="Loading"><LogoMark size={48} className="animate-pulse" /></span>
            ) : error ? (
              <EmptyState
                icon={<AlertCircle size={28} strokeWidth={1.5} />}
                title="Couldn't load the graph"
                description={`The graph data could not be fetched: ${
                  (error as Error).message ?? String(error)
                }`}
                actionLabel={isFetching ? "Retrying…" : "Retry"}
                onAction={handleRefresh}
              />
            ) : (
              <EmptyState
                icon={<Network size={28} strokeWidth={1.5} />}
                title="Nothing to graph yet"
                description="The knowledge graph is drawn from your library. Import a few papers and they'll appear here, linked by their authors and tags."
                actionLabel="Go to Library"
                onAction={() => navigate("/library")}
              />
            )}
          </div>
        )}
      </div>

      <SelectionBar count={selectedIds.size} onClear={clearSelection}>
        <SelectionBarButton onClick={() => setProjectPickerOpen(true)}>
          Add to Project
        </SelectionBarButton>
      </SelectionBar>

      <Dialog
        open={projectPickerOpen}
        onClose={() => {
          setProjectPickerOpen(false);
          setProjectPickerError(null);
          setNewProjectName("");
          createProjectMutation.reset();
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
            <div role="status" aria-label="Loading" className="flex items-center justify-center py-4">
              <LogoMark size={32} className="animate-pulse" />
            </div>
          ) : !projectsData?.projects?.length ? (
            <div className="space-y-2">
              <p className="text-muted text-sm">No projects yet.</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = newProjectName.trim();
                  if (name) createProjectMutation.mutate({ name, sourceIds: selectedSourceIds });
                }}
                onKeyDown={formSubmitOnCtrlEnter}
                className="flex gap-2"
              >
                <Input
                  autoFocus
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="New project name…"
                  className="flex-1 text-sm"
                  disabled={createProjectMutation.isPending}
                />
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={!newProjectName.trim() || createProjectMutation.isPending}
                >
                  {createProjectMutation.isPending ? "Creating…" : "Create"}
                </Button>
              </form>
            </div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {projectsData.projects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  onClick={() =>
                    addToProjectMutation.mutate({
                      projectId: project.id,
                      sourceIds: selectedSourceIds,
                    })
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
                setNewProjectName("");
                createProjectMutation.reset();
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

/**
 * The Filters > Author box matches `GraphPaper.author_keys`, and the BACKEND
 * drops single-paper authors from that index too. So with the option on, a name
 * that is certainly in the library empties the canvas under "No papers match the
 * active filters": true, but not why.
 */
const AUTHOR_HIDDEN_HINT =
  "Authors with a single paper are hidden, so the Author filter cannot match them.";

function NoMatchNotice({
  match,
  gutter,
  authorFilter,
  excludeSingleAuthors,
  onClearFilters,
  onShowSingleAuthors,
}: {
  match: ReturnType<typeof matchGraph>;
  gutter: number;
  authorFilter: string;
  excludeSingleAuthors: boolean;
  onClearFilters: () => void;
  onShowSingleAuthors: () => void;
}) {
  if (match.drawnCount > 0) return null;
  // Visibility all off is a different mistake from a filter that excludes
  // everything, but "Clear all filters" fixes both: one notice, two bodies.
  const cause = noMatchCause(match);
  const hiddenByVisibility = cause.kind === "visibility";
  // Nothing here can tell whether a hidden author is the cause — the names
  // never arrived — so offer it as a possibility only when both halves hold.
  const authorsMayBeHidden = !hiddenByVisibility && !!authorFilter && excludeSingleAuthors;
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute top-1/2 z-10 w-[min(340px,60%)] rounded-md border border-border p-4 text-center shadow-lg"
      style={{
        left: `calc((100% - ${gutter}px) / 2)`,
        transform: "translate(-50%, -50%)",
        backgroundColor: "var(--color-panel)",
      }}
    >
      <div className="text-sm font-semibold text-text">
        {hiddenByVisibility ? "Nothing to draw" : "No matches"}
      </div>
      <p className="mt-1 text-xs text-muted">
        {cause.kind === "visibility"
          ? `${joinTypes(cause.types)} ${
              cause.types.length === 1 ? "is" : "are"
            } switched off under Filters › Visibility.`
          : "No papers match the active filters."}
      </p>
      {authorsMayBeHidden && (
        <>
          <p className="mt-2 text-xs text-muted">{AUTHOR_HIDDEN_HINT}</p>
          <Button variant="muted" size="sm" className="mt-2 w-full" onClick={onShowSingleAuthors}>
            Show single-paper authors
          </Button>
        </>
      )}
      <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={onClearFilters}>
        Clear all filters
      </Button>
    </div>
  );
}
