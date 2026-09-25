// Run: node --experimental-transform-types --test src/lib/graph/sync.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { syncMoved } from "./sync.ts";

function setup() {
  const nodes = [
    { id: "still", x: 10, y: 10 },
    { id: "creep", x: 10.3, y: 9.8 },
    { id: "moved", x: 12, y: 10 },
    { id: "moved-y", x: 10, y: 9.5 },
  ];
  const drawn = new Map(nodes.map((n) => [n.id, { x: 10, y: 10 }]));
  const written: string[] = [];
  const write = (n: (typeof nodes)[number]) => {
    written.push(n.id);
    drawn.set(n.id, { x: n.x, y: n.y });
  };
  return { nodes, drawn: (n: { id: string }) => drawn.get(n.id)!, write, written };
}

test("syncMoved skips sub-eps drift and writes anything at or past eps on either axis", () => {
  const { nodes, drawn, write, written } = setup();
  assert.equal(syncMoved(nodes, drawn, write, 0.5), 2);
  assert.deepEqual(written, ["moved", "moved-y"]);
});

test("syncMoved at eps 0 writes every node, so a settled layout is drawn exactly", () => {
  const { nodes, drawn, write, written } = setup();
  assert.equal(syncMoved(nodes, drawn, write, 0), nodes.length);
  assert.deepEqual(written, nodes.map((n) => n.id));
});

test("sub-eps drift cannot accumulate: it is measured from the drawn position", () => {
  const { nodes, drawn, write, written } = setup();
  const creep = nodes[1];
  creep.x = 10.4;
  syncMoved([creep], drawn, write, 0.5);
  creep.x = 10.6; // 0.6 from the last drawn 10, though only 0.2 from last tick
  syncMoved([creep], drawn, write, 0.5);
  assert.deepEqual(written, ["creep"]);
  assert.equal(drawn(creep).x, 10.6);
});
