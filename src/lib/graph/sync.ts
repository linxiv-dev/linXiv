// Which simulated nodes the per-tick render sync has to write. Late in an
// anneal almost every node moves by a fraction of a pixel per tick, and each
// cytoscape write costs a bounds invalidation plus a redraw of its edges.

interface Point {
  x: number;
  y: number;
}

/**
 * Calls `write` for every node whose drawn position is `eps` or more off its
 * simulated one on either axis, and returns how many it wrote. `eps` 0 writes
 * every node: the exact sync a settled layout ends on.
 */
export function syncMoved<N extends Point>(
  nodes: readonly N[],
  drawn: (n: N) => Point,
  write: (n: N) => void,
  eps: number
): number {
  let written = 0;
  for (const n of nodes) {
    const p = drawn(n);
    if (Math.abs(p.x - n.x) >= eps || Math.abs(p.y - n.y) >= eps) {
      write(n);
      written++;
    }
  }
  return written;
}
