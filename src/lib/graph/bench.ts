// Layout + render-sync benchmark on a synthetic 5k-node / 20k-edge graph,
// forces wired as GraphCanvas wires them, cytoscape headless.
// Run: node --no-warnings --experimental-transform-types src/lib/graph/bench.ts

import cytoscape from "cytoscape";
import type { NodeSingular, Position } from "cytoscape";
import { forceLink, forceSimulation, forceX, forceY } from "d3-force";
import type { Force, SimulationNodeDatum } from "d3-force";

import { f32Collide, f32ManyBody } from "./f32forces.ts";
import { DEFAULT_FORCES as F, mulberry32, seedPositions } from "./layout.ts";
import { syncMoved } from "./sync.ts";

type CyNode = NodeSingular & { silentPosition(pos: Position): void };
type Node = SimulationNodeDatum & { id: string; x: number; y: number; cyNode?: CyNode };

const PAPERS = 2000;
const NODES = 5000;
const EDGES = 20000;
const rand = mulberry32(1);
const ids = Array.from({ length: NODES }, (_, i) => `n${i}`);
const edges = Array.from({ length: EDGES }, () => ({
  source: `n${Math.floor(rand() * PAPERS)}`,
  target: `n${PAPERS + Math.floor(rand() * (NODES - PAPERS))}`,
}));

function run(name: string, sync: (nodes: Node[]) => void) {
  const nodes = seedPositions(ids, edges, new Map(), mulberry32(2)) as Node[];
  const members = new Set(ids);
  const ms: Record<string, number> = {};
  const timed = (key: string, f: Force<Node, never>) => {
    const g = ((alpha: number) => {
      const t = performance.now();
      f(alpha);
      ms[key] = (ms[key] ?? 0) + performance.now() - t;
    }) as Force<Node, never>;
    g.initialize = f.initialize;
    return g;
  };
  const sim = forceSimulation(nodes)
    .stop()
    .force(
      "link",
      timed(
        "link",
        forceLink<Node, { source: string; target: string }>(edges.map((e) => ({ ...e })))
          .id((d) => d.id)
          .distance(F.linkDistance)
          .strength(F.linkStrength) as never
      )
    )
    .force("charge", timed("charge", f32ManyBody<Node>(members, F.repel) as never))
    .force("x", timed("x", forceX<Node>(0).strength(F.center) as never))
    .force("y", timed("y", forceY<Node>(0).strength(F.center) as never))
    .force("collision", timed("collide", f32Collide<Node>(members, 14) as never));
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements: [
      ...nodes.map((n) => ({ group: "nodes" as const, data: { id: n.id }, position: { x: n.x, y: n.y } })),
      ...edges.map((e) => ({ group: "edges" as const, data: e })),
    ],
  });
  for (const n of nodes) n.cyNode = cy.getElementById(n.id) as unknown as CyNode;
  let ticks = 0;
  const t0 = performance.now();
  while (sim.alpha() >= 0.001) {
    sim.tick();
    ticks++;
    const t = performance.now();
    cy.batch(() => sync(nodes));
    ms.sync = (ms.sync ?? 0) + performance.now() - t;
  }
  const per = Object.entries(ms).map(([k, v]) => `${k} ${(v / ticks).toFixed(2)}`);
  cy.destroy();
  console.log(`${name}: ${ticks} ticks, ${(performance.now() - t0).toFixed(0)} ms; per tick ms: ${per.join(", ")}`);
}

run("before (position per node)", (nodes) => {
  for (const n of nodes) n.cyNode!.position({ x: n.x, y: n.y });
});
for (const zoom of [1, 10]) {
  run(`after (syncMoved, zoom ${zoom})`, (nodes) => {
    syncMoved(
      nodes,
      (n) => n.cyNode!.position(),
      (n) => n.cyNode!.silentPosition({ x: n.x, y: n.y }),
      0.5 / zoom
    );
  });
}
