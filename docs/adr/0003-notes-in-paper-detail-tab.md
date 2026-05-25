# ADR 0003: Notes live as a tab inside Paper Detail, not a standalone page

## Status

Accepted

## Context

Notes are project-scoped/(project+paper)-scoped markdown blocks attached to a paper. The question was whether to surface note editing as a tab within the Paper Detail view or as a top-level Notes page in the sidebar navigation.

linxiv's core goal is research paper management. Notes are a supporting feature. A richer text editor (block editor, bidirectional links, etc.) is a future goal but is explicitly out of scope until the core is stable — adding it now would introduce unnecessary complexity.

## Decision

Notes are a tab within **Paper Detail** (e.g. Overview | Notes | PDF). The Notes tab contains a simple markdown editor. A scope picker at the top pre-selects the project the user navigated from; it can be changed to any other project the paper belongs to, or set to global (unscoped).

A standalone Notes page and any advanced editor features are deferred until the core app is stable and can be treated as a "plugin" or update.

## Consequences

### Positive
- Note editing stays in context of the paper being read.
- No extra sidebar entry cluttering the navigation.
- Scope defaults correctly from navigation context with no extra user action in the common case.
- Keeps complexity low while the core feature set is still being built out.

### Negative / limits
- When the richer editor is eventually built, the tab UI will need to be revisited.
- Explicitly choosing to require minor migration and refactoring when text editor
is introduced.

## References

- `src/pages/PaperDetailPage.tsx` — where the tab will live
