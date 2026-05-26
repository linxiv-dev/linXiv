# ADR 0012: postMessage as the graph iframe communication protocol

## Status

Accepted

## Context

The knowledge graph is rendered as a static HTML page (`/graph/graph.html`) loaded inside an `<iframe>` in `GraphPage.tsx`. Because the iframe and the parent React app are separate browsing contexts, they cannot share React state, Zustand stores, or any in-process reference. A communication mechanism that works across this boundary is required for:

1. **Navigation** — clicking a graph node should open the paper detail view in the parent app.
2. **Multi-select** — Ctrl/Cmd+clicking nodes should surface an "Add to Project" action bar in the parent app, driven by the selected node IDs.
3. **Theme sync** — the graph must re-render in the active theme palette; palette changes made in the parent need to propagate to the iframe.

Alternatives considered:
- **URL/query-string parameters**: one-way, no real-time updates, polling required for theme sync.
- **Shared localStorage / BroadcastChannel**: viable for theme, awkward for selection events.
- **Extracting the graph into a React component**: not feasible without rewriting the graph renderer, which is a self-contained non-React visualization.

## Decision

Use `window.postMessage` with same-origin verification for all parent↔iframe communication.

The message protocol is:

| Direction | `type` | Payload | Purpose |
|---|---|---|---|
| iframe → parent | `paper_clicked` | `{ id: string }` | Navigate to paper detail |
| iframe → parent | `selection_changed` | `{ sourceIds: string[] }` | Update selection state in parent |
| parent → iframe | `clear_selection` | — | Tell graph to deselect all nodes |
| parent → iframe | `theme_update` | `{ colors: ThemeColors }` | Push current palette to graph renderer |

All handlers verify `e.origin === window.location.origin` before processing.

`theme_update` is sent on iframe load (`onLoad` prop) and on every theme state change (via `useCallback` + `useEffect` on `preset`, `mode`, `overrides`, `overrideAlphas`).

The Library page's multi-select flow is **not** postMessage-based — it uses a shared Zustand `useSelectionStore` because Library and its paper cards are in the same browsing context. postMessage is used only where a hard context boundary exists.

## Consequences

### Positive
- The graph renderer remains a self-contained static page with no React dependency.
- Communication is explicit and auditable: all cross-boundary events are named message types.
- Same-origin check prevents message injection from other origins.

### Negative / limits
- The message protocol is informal (plain objects, no schema validation). A type mismatch silently does nothing.
- Adding new parent↔graph interactions requires updating both sides of the boundary independently.
- `theme_update` on every theme change adds a serialization + postMessage round-trip on each color edit in the palette editor. Acceptable at current scale; could be debounced if the graph renderer becomes expensive to re-theme.

## References

- `src/pages/GraphPage.tsx` — `postToIframe`, `onMessage`, `sendTheme`
- `public/graph/graph.html` — iframe target; message listener on the graph side
- `src/pages/LibraryPage.tsx` — contrast: uses `useSelectionStore` instead of postMessage
