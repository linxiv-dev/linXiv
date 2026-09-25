import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import cytoscape from "cytoscape";
import type { Core, NodeSingular, Position } from "cytoscape";
import { forceLink, forceSimulation, forceX, forceY } from "d3-force";
import type { ForceLink, Simulation, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";

import { isTauri } from "../../api/client";
import type { ThemeColors } from "../../lib/theme";
import type { GraphIndex, GraphNodeType, GraphView } from "../../lib/graph/model";
import type { GraphMatch } from "../../lib/graph/filter";
import { layoutIds } from "../../lib/graph/filter";
import { f32Collide, f32ManyBody } from "../../lib/graph/f32forces";
import type { ForceSettings } from "../../lib/graph/layout";
import { layoutRng, randomizePositions, seedPositions } from "../../lib/graph/layout";
import { fitViewport, placeFloatingBox, FIT_PADDING } from "../../lib/graph/fit";
import { syncMoved } from "../../lib/graph/sync";
import {
  AUTHOR_LABEL,
  ellipsize,
  eventsFor,
  graphStylesheet,
  highlightColor,
  labelWidth,
  MAX_ZOOM,
  MIN_ZOOM,
  opacityFor,
  PAPER_LABEL,
  paperColor,
  whenLabelFontReady,
} from "../../lib/graph/style";
import { tooltipFor } from "../../lib/graph/tooltip";
import type { TooltipContent } from "../../lib/graph/tooltip";
import { MathText } from "../../lib/tex";

/** The graph engine: one cytoscape instance (drawing) and one d3-force
 *  simulation (placing), wired by a per-tick position sync — the one genuinely
 *  imperative piece; everything around it is ordinary React. */

/** A node as d3 holds it, plus the bookkeeping this component layers on. */
interface SimNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  /** True when the pin under `fx`/`fy` is the FILTER's, not a drag's. Two
   *  writers, two release rules — a filter pin goes when the node re-enters the
   *  layout, a drag pin when the user lets go — and neither clears the other's. */
  filterPinned?: boolean;
  /** `silentPosition` is public cytoscape API its typings omit. */
  cyNode?: NodeSingular & { silentPosition(pos: Position): void };
}

type SimLink = SimulationLinkDatum<SimNode>;

export interface GraphCanvasHandle {
  /** Throw the settled layout away and rebuild it from fresh seed positions. */
  relayout(): void;
}

/** What a right-clicked node hands the page — enough to open or copy it. */
export interface GraphNodeContext {
  id: string;
  type: GraphNodeType;
  label: string;
  sourceId?: string;
  authorId?: number;
}

export interface GraphCanvasProps {
  view: GraphView;
  index: GraphIndex;
  theme: ThemeColors;
  forces: ForceSettings;
  match: GraphMatch;
  selectedIds: ReadonlySet<string>;
  /** Canvas pixels covered by the panel column, so a fit frames the visible strip. */
  gutter: number;
  /**
   * The same number read straight from the DOM. `gutter` is React state, and a
   * fit can run in the same task as the ResizeObserver callback that recomputes
   * it — the reveal of this page from `display: none` is exactly that moment.
   * That `setGutter` has not committed, so a fit reading the prop sees the
   * hidden column's 0 and frames the whole canvas, leaving the rightmost nodes
   * under the panels for the session. Measure, don't remember.
   */
  measureGutter: () => number;
  onPaperTap: (id: string, additive: boolean) => void;
  onAuthorTap: (authorId: number) => void;
  onTagTap: (label: string) => void;
  onBackgroundTap: () => void;
  onNodeContextMenu: (e: MouseEvent, node: GraphNodeContext) => void;
}

interface TooltipState extends TooltipContent {
  left: number;
  top: number;
}

/** Per-node collision radius: node centres stay 28px apart. Bodies are 20px
 *  across (14px for an author diamond), leaving room for the label hanging off
 *  the right. */
const COLLIDE_RADIUS = 14;

/** Main-thread ms per frame the settling layout may spend on extra ticks. */
const TICK_BUDGET_MS = 12;

const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  {
    view,
    index,
    theme,
    forces,
    match,
    selectedIds,
    gutter,
    measureGutter,
    onPaperTap,
    onAuthorTap,
    onTagTap,
    onBackgroundTap,
    onNodeContextMenu,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<Map<string, SimNode>>(new Map());
  const edgesRef = useRef<{ source: string; target: string }[]>([]);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  /** Zoom/pan carried across a rebuild. Cleanup runs before the replacement
   *  effect body, so the new build cannot read the outgoing viewport off
   *  `cyRef` — it is already destroyed. Stash it on the way out, or an in-place
   *  reload throws away the view the user panned to. */
  const lastViewport = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null);

  // Cytoscape handlers are registered once per payload and would close over the
  // props they were built with. Mirrored on refs so one build survives every
  // later change to the filter, the selection or a callback.
  const latest = useRef({ view, index, match, selectedIds, theme, gutter, measureGutter, forces });
  latest.current = { view, index, match, selectedIds, theme, gutter, measureGutter, forces };
  const handlers = useRef({ onPaperTap, onAuthorTap, onTagTap, onBackgroundTap, onNodeContextMenu });
  handlers.current = { onPaperTap, onAuthorTap, onTagTap, onBackgroundTap, onNodeContextMenu };

  /** One-shot: reframe the next time the simulation settles. Armed by a cold
   *  load and by "Randomize & restart" — both seed randomly and then spread well
   *  past that, so the viewport in force frames something that no longer exists.
   *  Cleared on the first grab so a reframe never yanks the view from under a
   *  drag. */
  const fitOnSettle = useRef(false);
  /** A fit skipped because the viewport was 0x0 (`display: none` keep-alive);
   *  replayed on the resize the reveal fires. */
  const fitDeferred = useRef(false);

  const hideTooltip = useCallback(() => setTooltip(null), []);

  const fit = useCallback(() => {
    const cy = cyRef.current;
    if (!cy || cy.nodes().length === 0) return;
    const w = cy.width();
    const h = cy.height();
    if (!w || !h) {
      fitDeferred.current = true;
      return;
    }
    fitDeferred.current = false;

    // Frame the nodes the user can SEE: with "Show highlighted only" on and
    // three papers matching, framing the whole library collapsed them into a
    // speck. An 8% ghost still counts as drawn; only a hidden type or an
    // isolated non-match drops out.
    const framed = drawnCollection(cy, latest.current.match);
    const bb = (framed ?? cy.elements()).boundingBox();
    const viewport = fitViewport(bb, w, h, latest.current.measureGutter(), {
      min: cy.minZoom(),
      max: cy.maxZoom(),
    });
    if (viewport) cy.viewport(viewport);
    else cy.fit(framed ?? undefined, FIT_PADDING);
  }, []);

  /** Both read the CURRENT layout membership: an excluded node is PINNED, not
   *  removed, so at full strength it goes on shoving matching nodes around from
   *  behind its 8% ghost. d3 splits a collision by the SQUARE of the radii, so a
   *  zero radius leaves the member taking none of it. */
  const chargeForce = useCallback(() => {
    const { match: m, forces: f } = latest.current;
    return f32ManyBody<SimNode>(layoutIds(m), f.repel);
  }, []);

  const collideForce = useCallback(
    () => f32Collide<SimNode>(layoutIds(latest.current.match), COLLIDE_RADIUS),
    []
  );

  const applyStyles = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const { match: m, selectedIds: selected, theme: t, index: idx } = latest.current;
    const anySelected = selected.size > 0;

    // Authors and tags joined to a selected paper are highlighted with it.
    const selAuthors = new Set<string>();
    const selTags = new Set<string>();
    for (const pid of selected) {
      for (const nid of idx.neighboursByPaper.get(pid) ?? []) {
        if (idx.typeById.get(nid) === "author") selAuthors.add(nid);
        else if (idx.typeById.get(nid) === "tag") selTags.add(nid);
      }
    }

    const matchedFor = (type: GraphNodeType) =>
      type === "paper" ? m.papers : type === "author" ? m.authors : m.tags;
    const selectedFor = (type: GraphNodeType, id: string) =>
      type === "paper" ? selected.has(id) : type === "author" ? selAuthors.has(id) : selTags.has(id);

    cy.batch(() => {
      cy.nodes().forEach((n) => {
        const type = n.data("type") as GraphNodeType;
        const id = n.id();
        const opacity = m.hiddenTypes.has(type)
          ? 0
          : opacityFor(matchedFor(type).has(id), selectedFor(type, id), anySelected, m.isolate);
        const style: Record<string, unknown> = { opacity, events: eventsFor(opacity) };
        if (type === "paper") {
          // Painted on EVERY selected paper, including one the filter excluded:
          // that node is an 8% ghost, not hidden, so a Ctrl-click selects it and
          // withholding the highlight made the click change nothing visible.
          // The filter owns opacity; the selection owns colour.
          style["background-color"] = selected.has(id) ? highlightColor(t) : paperColor(t);
        }
        n.style(style);
      });

      cy.edges().forEach((e) => {
        const sid = e.source().id();
        const tid = e.target().id();
        const srcType = e.source().data("type") as GraphNodeType;
        const tgtType = e.target().data("type") as GraphNodeType;
        // An edge is only as visible as its endpoints: hiding either type takes
        // the edge with it, so no line dangles into empty canvas.
        if (m.hiddenTypes.has(srcType) || m.hiddenTypes.has(tgtType)) {
          e.style({ opacity: 0, events: "no" });
          return;
        }
        const visible = matchedFor(srcType).has(sid) && matchedFor(tgtType).has(tid);
        const sel = selectedFor(srcType, sid) || selectedFor(tgtType, tid);
        const opacity = opacityFor(visible, sel, anySelected, m.isolate);
        e.style({ opacity, events: eventsFor(opacity) });
      });
    });
  }, []);

  // ── Build: one cytoscape + one simulation per payload ──────────────────────
  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    // Seed surviving nodes from the OUTGOING layout. Whether any survive is the
    // whole test for "this replaces an earlier payload": a cold load has none,
    // so it seeds randomly, fits and arms fit-on-settle, while a refresh or an
    // option toggle keeps both the settled layout and the viewport.
    const previous = new Map<string, { x: number; y: number }>();
    nodesRef.current.forEach((n, id) => previous.set(id, { x: n.x, y: n.y }));
    const preserveView = previous.size > 0;
    const prevViewport = preserveView ? lastViewport.current : null;

    // Wait for the label face before the first paint: cytoscape caches label
    // measurements on the renderer keyed by text and font STYLE, so labels
    // measured in the fallback face keep those widths for the session.
    void whenLabelFontReady().then(() => {
      if (cancelled) return;

      simRef.current?.stop();
      cyRef.current?.destroy();
      simRef.current = null;
      cyRef.current = null;
      setTooltip(null);
      fitDeferred.current = false;
      fitOnSettle.current = !preserveView;

      const nodeIds = [
        ...view.papers.map((p) => p.id),
        ...view.authors.map((a) => a.id),
        ...view.tags.map((t) => t.id),
      ];
      edgesRef.current = view.edges.map((e) => ({ source: e.source, target: e.target }));
      const simNodes = seedPositions(
        nodeIds,
        edgesRef.current,
        previous,
        layoutRng()
      ) as SimNode[];
      nodesRef.current = new Map(simNodes.map((n) => [n.id, n]));

      // `label` stays whole for tag routes and "Copy Label"; `display` is drawn.
      const paperWidth = labelWidth(PAPER_LABEL.size);
      const authorWidth = labelWidth(AUTHOR_LABEL.size);
      const cy = cytoscape({
        container,
        elements: [
          ...view.papers.map((p) => ({
            group: "nodes" as const,
            data: {
              id: p.id,
              type: "paper",
              label: p.label,
              display: ellipsize(p.label, PAPER_LABEL.maxWidth, paperWidth),
              source_id: p.source_id,
            },
            position: { x: nodesRef.current.get(p.id)!.x, y: nodesRef.current.get(p.id)!.y },
          })),
          ...view.authors.map((a) => ({
            group: "nodes" as const,
            data: {
              id: a.id,
              type: "author",
              label: a.label,
              display: ellipsize(a.label, AUTHOR_LABEL.maxWidth, authorWidth),
              author_id: a.author_id,
            },
            position: { x: nodesRef.current.get(a.id)!.x, y: nodesRef.current.get(a.id)!.y },
          })),
          ...view.tags.map((t) => ({
            group: "nodes" as const,
            data: { id: t.id, type: "tag", label: t.label },
            position: { x: nodesRef.current.get(t.id)!.x, y: nodesRef.current.get(t.id)!.y },
          })),
          ...view.edges.map((e) => ({
            group: "edges" as const,
            data: { source: e.source, target: e.target },
          })),
        ],
        style: graphStylesheet(latest.current.theme),
        layout: { name: "preset" },
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        // Cache a texture and drop edges while panning/zooming to keep the
        // viewport smooth as the node count grows.
        textureOnViewport: true,
        hideEdgesOnViewport: true,
      });
      cyRef.current = cy;

      if (prevViewport) cy.viewport(prevViewport);
      else fit();

      // Cache each node's handle so the per-tick sync skips a lookup per node
      // per frame.
      for (const n of simNodes) n.cyNode = cy.getElementById(n.id) as unknown as SimNode["cyNode"];

      cy.on("grab", "node", (e) => {
        fitOnSettle.current = false; // the user took control — don't reframe under them
        setTooltip(null);
        const n = nodesRef.current.get(e.target.id());
        if (n) {
          n.fx = n.x;
          n.fy = n.y;
          // The pin is the DRAG's from here on. A filter-excluded ghost is
          // grabbable and arrives still flagged as the FILTER's, so a filter
          // pass re-admitting it mid-drag would take the "release the pin I own"
          // branch and hand it back to d3 under the cursor — it then drifted
          // between mousemove events. `free` re-pins for the filter at the drop.
          n.filterPinned = false;
        }
        simRef.current?.alphaTarget(0.3).restart();
      });
      cy.on("drag", "node", (e) => {
        const n = nodesRef.current.get(e.target.id());
        if (!n) return;
        const pos = e.target.position();
        n.fx = pos.x;
        n.fy = pos.y;
      });
      // Releasing hands the node back to the layout — unless the filter had
      // EXCLUDED it, in which case the pin was the filter's own. A ghost is
      // grabbable (only opacity 0 turns `events` off), so nulling fx/fy released
      // a pin nothing would restore and the ghost — charge 0, radius 0 — slid
      // off towards the origin. Re-pin at the drop point instead.
      cy.on("free", "node", (e) => {
        const n = nodesRef.current.get(e.target.id());
        if (n) {
          if (!layoutIds(latest.current.match).has(n.id)) {
            if (n.fx == null) {
              n.fx = n.x;
              n.fy = n.y;
            }
            n.filterPinned = true;
          } else {
            n.fx = null;
            n.fy = null;
            n.filterPinned = false;
          }
        }
        simRef.current?.alphaTarget(0);
      });

      cy.on("tap", 'node[type = "paper"]', (e) => {
        const additive = e.originalEvent.ctrlKey || e.originalEvent.metaKey;
        if (!additive) setTooltip(null);
        handlers.current.onPaperTap(e.target.id(), additive);
      });
      // Ctrl/Cmd is reserved for paper multi-select, so it is a no-op on the
      // other two types rather than a navigation.
      cy.on("tap", 'node[type = "author"]', (e) => {
        if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) return;
        const authorId = e.target.data("author_id") as number | undefined;
        if (authorId === undefined || authorId === null) return;
        setTooltip(null);
        handlers.current.onAuthorTap(authorId);
      });
      cy.on("tap", 'node[type = "tag"]', (e) => {
        if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) return;
        const label = e.target.data("label") as string | undefined;
        if (!label) return;
        setTooltip(null);
        handlers.current.onTagTap(label);
      });
      cy.on("tap", (e) => {
        if (e.target !== cy) return;
        if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) return;
        handlers.current.onBackgroundTap();
      });

      // The graph is one canvas, so per-node DOM contextmenu events never
      // happen — cytoscape's own right-click gesture is the hook instead.
      cy.on("cxttap", "node", (e) => {
        setTooltip(null);
        const n = e.target as NodeSingular;
        handlers.current.onNodeContextMenu(e.originalEvent as MouseEvent, {
          id: n.id(),
          type: n.data("type") as GraphNodeType,
          label: n.data("label") as string,
          sourceId: n.data("source_id") as string | undefined,
          authorId: n.data("author_id") as number | undefined,
        });
      });

      cy.on("mouseover", "node", (e) => showTooltipFor(e.target));
      cy.on("mouseout", "node", () => setTooltip(null));
      // The box is placed in rendered (screen) coordinates, so a pan or zoom
      // would leave it pointing at empty canvas.
      cy.on("viewport", () => setTooltip(null));

      const simLinks: SimLink[] = edgesRef.current.map((e) => ({ ...e }));
      const sim = forceSimulation<SimNode>(simNodes)
        .force(
          "link",
          forceLink<SimNode, SimLink>(simLinks)
            .id((d) => d.id)
            .distance(latest.current.forces.linkDistance)
            .strength(latest.current.forces.linkStrength)
        )
        .force("charge", chargeForce())
        .force("x", forceX<SimNode>(0).strength(latest.current.forces.center))
        .force("y", forceY<SimNode>(0).strength(latest.current.forces.center))
        .force("collision", collideForce());
      simRef.current = sim;

      // `silentPosition` still fires the `bounds` notification the renderer
      // redraws on, but skips a `position` event per node that nothing here
      // listens to. Nodes that drifted under half a screen pixel wait a tick.
      const syncPositions = (eps: number) => {
        cy.batch(() => {
          syncMoved(
            simNodes,
            (n) => n.cyNode!.position(),
            (n) => n.cyNode!.silentPosition({ x: n.x, y: n.y }),
            eps
          );
        });
      };
      // d3 ticks once per frame and a frame's redraw costs 10x a tick, so an
      // anneal would crawl at the renderer's pace. Spend a budget on extra ticks
      // first: same ticks, same layout, fewer frames. Not while dragging, where
      // alphaTarget holds the sim warm and extra ticks would speed up the feel.
      let tickMs = 0;
      sim.on("tick", () => {
        const start = performance.now();
        while (
          sim.alphaTarget() === 0 &&
          sim.alpha() >= sim.alphaMin() &&
          performance.now() - start + tickMs < TICK_BUDGET_MS
        ) {
          const t = performance.now();
          sim.tick();
          tickMs = performance.now() - t;
        }
        syncPositions(0.5 / cy.zoom());
      });
      // Frame the settled layout, not the seed positions fitted above. Fires on
      // every drag/filter restart too, hence the one-shot flag.
      sim.on("end", () => {
        syncPositions(0);
        if (!fitOnSettle.current) return;
        fitOnSettle.current = false;
        fit();
      });

      lastLayoutIds.current = null;
      // A cold load is starting from random seeds and must expand out of them;
      // an in-place reload is starting from the settled layout and must not.
      applyPhysics(true, preserveView ? 0.3 : 1);
      applyStyles();

      function showTooltipFor(node: NodeSingular) {
        const { index: idx, match: m } = latest.current;
        const type = node.data("type") as GraphNodeType;
        const content = tooltipFor(node.id(), type, idx, drawnPapers(m));
        const rendered = node.renderedPosition();
        // Placed from the node's rendered position with a nominal box size; the
        // layout effect below re-measures once it is in the DOM and flips it if
        // it would overhang. Measuring first would need a hidden render pass.
        setTooltip({ ...content, left: rendered.x + 14, top: rendered.y + 14 });
      }
    });

    return () => {
      cancelled = true;
      if (cyRef.current) {
        lastViewport.current = { zoom: cyRef.current.zoom(), pan: { ...cyRef.current.pan() } };
      }
      simRef.current?.stop();
      cyRef.current?.destroy();
      simRef.current = null;
      cyRef.current = null;
    };
    // Rebuilt only when the PAYLOAD changes. Theme, forces, filter and selection
    // all ride the effects below, which drive the live instance in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /**
   * Pin the excluded nodes, restrict the link force to edges inside the layout,
   * rebuild charge/collision for the new membership, and reheat.
   *
   * Keyed on membership, not on `match`: reheating shoves every unpinned node
   * around, and "Show highlighted only" leaves `layoutIds` identical — it
   * changes what is DRAWN, not what the layout runs over. A Visibility checkbox
   * DOES drop its type from `layoutIds` and reheats on purpose: an invisible
   * node must not shape the layout of the visible ones.
   *
   * `force` is for callers that need the work regardless: a fresh payload, and
   * "Randomize & restart", which clears every pin — the filter's included.
   *
   * `alpha` anneals afterwards. 0.3 nudges an already-settled layout; random
   * seeds need the full 1, because d3's total impulse is `alpha / alphaDecay`
   * and 0.3 cannot expand out of the SEED_SPREAD box.
   */
  const lastLayoutIds = useRef<Set<string> | null>(null);
  const applyPhysics = useCallback((force = false, alpha = 0.3) => {
    const sim = simRef.current;
    if (!sim) return;
    const ids = layoutIds(latest.current.match);
    if (!force && lastLayoutIds.current && sameIds(lastLayoutIds.current, ids)) return;
    lastLayoutIds.current = ids;

    nodesRef.current.forEach((n) => {
      if (!ids.has(n.id)) {
        // `fx == null` means nothing holds it yet. An already-pinned node is
        // being dragged (see `grab`), and that pin outranks the filter's.
        if (n.fx == null) {
          n.fx = n.x;
          n.fy = n.y;
          n.filterPinned = true;
        }
      } else if (n.filterPinned) {
        // Release only a pin the FILTER owns. `grab` clears the flag for a
        // drag's duration, so a node re-admitted mid-drag stays under the cursor.
        n.fx = null;
        n.fy = null;
        n.filterPinned = false;
      }
    });

    const active = edgesRef.current
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ ...e }));
    (sim.force("link") as ForceLink<SimNode, SimLink>).links(active);
    sim.force("charge", chargeForce());
    sim.force("collision", collideForce());
    sim.alpha(alpha).restart();
  }, [chargeForce, collideForce]);

  useEffect(() => {
    // Styles always; physics only if the layout membership actually moved.
    applyPhysics();
    applyStyles();
  }, [match, applyPhysics, applyStyles]);

  useEffect(() => {
    applyStyles();
  }, [selectedIds, applyStyles]);

  // Reinstall the stylesheet AND repaint: every paper carries a per-element
  // `background-color` bypass (that is how selection is painted) and a bypass
  // outranks the stylesheet, so papers would stay on the OLD accent.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style(graphStylesheet(theme)).update();
    applyStyles();
  }, [theme, applyStyles]);

  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const link = sim.force("link") as ForceLink<SimNode, SimLink>;
    link.distance(forces.linkDistance).strength(forces.linkStrength);
    sim.force("charge", chargeForce());
    sim.force("x", forceX<SimNode>(0).strength(forces.center));
    sim.force("y", forceY<SimNode>(0).strength(forces.center));
    sim.alpha(0.3).restart();
  }, [forces, chargeForce]);

  // Revealing the page takes the container from 0x0 to its real size; run the
  // fit that was skipped while there was nothing to fit.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      cyRef.current?.resize();
      if (fitDeferred.current) fit();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [fit]);

  // Keep the inspector inside the canvas and clear of the panel column. Run
  // after paint, when the box has a real size to flip against.
  useEffect(() => {
    if (!tooltip) return;
    const box = tooltipRef.current;
    const container = containerRef.current;
    if (!box || !container) return;
    const rect = box.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    const placed = placeFloatingBox(
      { x: tooltip.left - 14, y: tooltip.top - 14 },
      { width: rect.width, height: rect.height },
      { width: bounds.width, height: bounds.height, gutter }
    );
    if (placed.left !== tooltip.left || placed.top !== tooltip.top) {
      setTooltip((t) => (t ? { ...t, left: placed.left, top: placed.top } : t));
    }
    // Only re-place when a NEW box appears; re-running on every position write
    // would loop against its own setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tooltip?.title, tooltip?.meta, tooltip?.summary, gutter]);

  useImperativeHandle(
    ref,
    () => ({
      relayout() {
        const sim = simRef.current;
        if (!sim) return;
        // The inspector is placed against a node that is about to jump.
        setTooltip(null);
        const nodes = [...nodesRef.current.values()];
        randomizePositions(nodes, layoutRng());
        for (const n of nodes) {
          n.vx = 0;
          n.vy = 0;
          n.fx = null;
          n.fy = null;
          n.filterPinned = false;
        }
        fitOnSettle.current = true;
        // `force` because randomize cleared the FILTER's pins too and the
        // excluded nodes must be re-pinned at their new seeds; alpha 1 because
        // this re-seeds into the SEED_SPREAD box and has to expand out of it.
        applyPhysics(true, 1);
      },
    }),
    [applyPhysics]
  );

  return (
    <>
      {/* Inline, not `absolute inset-0`: cytoscape injects an unlayered
          `position: relative` on its container class, which outranks
          Tailwind 4's layered utilities and collapses the div to 0 height. */}
      <div
        ref={containerRef}
        style={{ position: "absolute", inset: 0 }}
        onMouseLeave={hideTooltip}
        // cxttap's originalEvent is the press, not this contextmenu event, so
        // the webview's default menu has to be put down here or it opens on
        // top of the native one.
        onContextMenu={(e) => {
          if (isTauri) e.preventDefault();
        }}
      />
      {tooltip && (
        <div
          ref={tooltipRef}
          role="tooltip"
          className="absolute z-20 pointer-events-none max-w-[340px] rounded-md border border-border px-3 py-2 shadow-lg"
          style={{ left: tooltip.left, top: tooltip.top, backgroundColor: "var(--color-panel)" }}
        >
          <div className="text-sm font-semibold text-text">
            <MathText forceInline>{tooltip.title}</MathText>
          </div>
          {tooltip.meta.length > 0 && (
            <div className="mt-1 text-xs text-muted whitespace-pre-line">
              {tooltip.meta.join("\n")}
            </div>
          )}
          {tooltip.summary && (
            <div className="mt-1 text-xs text-muted">
              <MathText forceInline>{tooltip.summary}</MathText>
            </div>
          )}
        </div>
      )}
    </>
  );
});

export default GraphCanvas;

/** Whether two layout-membership sets name the same nodes. */
function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Papers a degree line counts as "shown": matched and of a drawn type. */
function drawnPapers(m: GraphMatch): Set<string> {
  return m.hiddenTypes.has("paper") ? new Set() : new Set(m.papers);
}

/** The nodes a fit should frame: the ones left at a non-zero opacity. `null`
 *  means "nothing is being held back, frame the whole graph". */
function drawnCollection(cy: Core, m: GraphMatch) {
  const isolating = m.isolate;
  if (m.hiddenTypes.size === 0 && !isolating) return null;
  const matchedFor = (type: GraphNodeType) =>
    type === "paper" ? m.papers : type === "author" ? m.authors : m.tags;
  const drawn = cy.nodes().filter((n) => {
    const type = n.data("type") as GraphNodeType;
    if (m.hiddenTypes.has(type)) return false;
    if (!isolating) return true;
    return matchedFor(type).has(n.id());
  });
  // Isolate with a filter matching nothing draws an empty canvas; there is no
  // extent to frame, so fall back to the whole graph rather than a degenerate box.
  return drawn.length > 0 ? drawn : null;
}
