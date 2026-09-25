// Run: node --experimental-transform-types --test src/lib/graph/f32forces.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { forceCollide, forceManyBody } from "d3-force";

import { f32Collide, f32ManyBody } from "./f32forces.ts";
import { mulberry32 } from "./layout.ts";

interface Node {
  id: string;
  /** What d3's own forces key their per-node arrays on. */
  index: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function randomNodes(n: number, spread: number, seed = 42): Node[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    index: i,
    x: (rand() - 0.5) * spread,
    y: (rand() - 0.5) * spread,
    vx: 0,
    vy: 0,
  }));
}

const allIds = (nodes: Node[]) => new Set(nodes.map((n) => n.id));

/** Exact O(n²) many-body with d3's semantics (distanceMin 1, no theta cut). */
function exactManyBody(nodes: Node[], repel: number, alpha: number): { vx: number; vy: number }[] {
  return nodes.map((a) => {
    let vx = 0;
    let vy = 0;
    for (const b of nodes) {
      if (a === b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let l = dx * dx + dy * dy;
      if (l < 1) l = Math.sqrt(l);
      vx += (dx * -repel * alpha) / l;
      vy += (dy * -repel * alpha) / l;
    }
    return { vx, vy };
  });
}

test("f32ManyBody stays within d3's own Barnes-Hut error of the exact answer", () => {
  const ours = randomNodes(120, 1200);
  const theirs = structuredClone(ours);
  const exact = exactManyBody(ours, 180, 0.3);

  const force = f32ManyBody<Node>(allIds(ours), 180);
  force.initialize!(ours, mulberry32(7));
  force(0.3);

  const ref = forceManyBody<Node>().strength(-180);
  ref.initialize!(theirs, mulberry32(7));
  ref(0.3);

  // Both trees use theta 0.9 but cut space differently, so per-node results
  // differ; the yardstick is that our approximation error against the exact
  // O(n²) answer is no worse than d3's own.
  const worstErr = (run: Node[]) =>
    Math.max(
      ...run.map((n, i) => Math.hypot(n.vx - exact[i].vx, n.vy - exact[i].vy))
    );
  const oursErr = worstErr(ours);
  const d3Err = worstErr(theirs);
  assert.ok(oursErr <= d3Err * 1.5 + 0.01, `ours ${oursErr} vs d3 ${d3Err}`);
});

test("f32ManyBody accumulates on top of existing velocity", () => {
  const nodes = randomNodes(10, 300);
  for (const n of nodes) {
    n.vx = 5;
    n.vy = -5;
  }
  const force = f32ManyBody<Node>(allIds(nodes), 100);
  force.initialize!(nodes, mulberry32(7));
  force(0.5);
  // Repulsion is tiny next to the seeded velocity, so the sign survives.
  for (const n of nodes) {
    assert.ok(n.vx > 0 && n.vy < 0, "existing velocity was overwritten");
  }
});

test("f32Collide matches d3 forceCollide on isolated overlapping pairs", () => {
  // Pairs far apart from each other, so resolution order cannot differ.
  const mk = (): Node[] => {
    const nodes: Node[] = [];
    const rand = mulberry32(9);
    for (let p = 0; p < 20; p++) {
      const cx = (p % 5) * 500;
      const cy = Math.floor(p / 5) * 500;
      const dx = (rand() - 0.5) * 20; // within 2*radius=28 → overlap
      const dy = (rand() - 0.5) * 20;
      nodes.push({ id: `a${p}`, index: 2 * p, x: cx, y: cy, vx: 0, vy: 0 });
      nodes.push({ id: `b${p}`, index: 2 * p + 1, x: cx + dx, y: cy + dy, vx: 0, vy: 0 });
    }
    return nodes;
  };
  const ours = mk();
  const theirs = mk();

  const force = f32Collide<Node>(allIds(ours), 14);
  force.initialize!(ours, mulberry32(7));
  force(1);

  const ref = forceCollide<Node>(14);
  ref.initialize!(theirs, mulberry32(7));
  ref(1);

  for (let i = 0; i < ours.length; i++) {
    assert.ok(
      Math.abs(ours[i].vx - theirs[i].vx) < 1e-3 && Math.abs(ours[i].vy - theirs[i].vy) < 1e-3,
      `node ${i}: (${ours[i].vx}, ${ours[i].vy}) vs d3 (${theirs[i].vx}, ${theirs[i].vy})`
    );
  }
});

test("non-members neither push nor get pushed by either force", () => {
  const base = randomNodes(40, 400);
  const members = allIds(base);
  // A ghost dropped right in the middle of the pack.
  const withGhost = [
    ...structuredClone(base),
    { id: "ghost", index: base.length, x: 1, y: 1, vx: 0, vy: 0 },
  ];
  const without = structuredClone(base);

  for (const factory of [
    (ids: Set<string>) => f32ManyBody<Node>(ids, 180),
    (ids: Set<string>) => f32Collide<Node>(ids, 14),
  ]) {
    const a = structuredClone(withGhost);
    const b = structuredClone(without);
    const fa = factory(members);
    fa.initialize!(a, mulberry32(7));
    fa(0.5);
    const fb = factory(members);
    fb.initialize!(b, mulberry32(7));
    fb(0.5);
    const ghost = a.find((n) => n.id === "ghost")!;
    assert.equal(ghost.vx, 0);
    assert.equal(ghost.vy, 0);
    for (let i = 0; i < b.length; i++) {
      assert.equal(a[i].vx, b[i].vx, `member ${i} felt the ghost`);
      assert.equal(a[i].vy, b[i].vy);
    }
  }
});

test("coincident and near-coincident points separate instead of hanging", () => {
  // Exact duplicates exercise the chain + jiggle path; a 1e-9 offset rounds
  // to the same f32 and exercises the depth-capped chain path.
  const nodes: Node[] = [
    { id: "a", index: 0, x: 0, y: 0, vx: 0, vy: 0 },
    { id: "b", index: 1, x: 0, y: 0, vx: 0, vy: 0 },
    { id: "c", index: 2, x: 1e-9, y: 0, vx: 0, vy: 0 },
    { id: "d", index: 3, x: 200, y: 200, vx: 0, vy: 0 },
  ];
  const charge = f32ManyBody<Node>(allIds(nodes), 180);
  charge.initialize!(nodes, mulberry32(7));
  charge(0.5);
  const collide = f32Collide<Node>(allIds(nodes), 14);
  collide.initialize!(nodes, mulberry32(7));
  collide(1);
  for (const n of nodes) {
    assert.ok(Number.isFinite(n.vx) && Number.isFinite(n.vy), `${n.id} went non-finite`);
  }
  // The pile at the origin got pushed apart, not left stacked.
  assert.notEqual(nodes[0].vx, nodes[1].vx);
});

test("axis-aligned nodes get a per-component jiggle, like d3", () => {
  // Same x, different y: d3 jiggles the zero x component so a vertical stack
  // still spreads horizontally under charge alone.
  const nodes: Node[] = [
    { id: "a", index: 0, x: 5, y: 0, vx: 0, vy: 0 },
    { id: "b", index: 1, x: 5, y: 40, vx: 0, vy: 0 },
  ];
  const charge = f32ManyBody<Node>(allIds(nodes), 180);
  charge.initialize!(nodes, mulberry32(7));
  charge(0.5);
  assert.notEqual(nodes[0].vx, 0, "zero x-component was not jiggled");
  assert.notEqual(nodes[1].vx, 0);
});

test("two-node far and near-field charges match d3 to the ulp", () => {
  // Two nodes = pure leaf math, no tree approximation. Coordinates are
  // exactly representable in f32 so the typed-array round-trip is lossless.
  // Covers the plain inverse-square path and the DISTANCE_MIN2 clamp path
  // numerically (the Barnes-Hut error-bound test above covers the theta'd
  // tree path statistically). Tolerance is ulp-scale, not zero: we compute
  // one shared w = value*alpha/l per pair where d3 associates
  // x*value*alpha/l per component — same math, last-bit rounding differs.
  for (const [bx, by] of [
    [320, 64], // far
    [0.375, 0.5], // near: dist^2 < 1 exercises the clamp
  ]) {
    const ours: Node[] = [
      { id: "a", index: 0, x: 0, y: 0, vx: 0, vy: 0 },
      { id: "b", index: 1, x: bx, y: by, vx: 0, vy: 0 },
    ];
    const theirs = structuredClone(ours);
    const f = f32ManyBody<Node>(allIds(ours), 180);
    f.initialize!(ours, mulberry32(7));
    f(0.3);
    const d3f = forceManyBody<Node>().strength(-180);
    d3f.initialize!(theirs, mulberry32(7));
    d3f(0.3);
    const close = (a: number, b: number, what: string) =>
      assert.ok(
        Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)),
        `${what}: ${a} vs d3 ${b}`
      );
    for (let i = 0; i < 2; i++) {
      close(ours[i].vx, theirs[i].vx, `node ${i} vx at (${bx},${by})`);
      close(ours[i].vy, theirs[i].vy, `node ${i} vy at (${bx},${by})`);
    }
  }
});
