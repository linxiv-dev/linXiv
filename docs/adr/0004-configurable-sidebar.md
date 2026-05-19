# ADR 0004: Configurable sidebar with fixed core and optional pages

## Status

Accepted

## Context

The sidebar is the primary navigation. As the app gains more pages (Tags, Notes Editor, DOI Lookup, and future additions), a fixed sidebar grows cluttered for users who don't use every feature.

## Decision

The sidebar is split into a **fixed core** (Library, Projects, Settings — always visible) and **optional pages** that can be individually toggled in Settings. Optional pages and their defaults:

| Page | Default |
|---|---|
| Graph | on |
| Search | on |
| DOI Lookup | on |
| Tags | off |
| Notes Editor | off |

Future optional pages follow the same pattern: on by default if broadly useful, off by default if niche.

## Consequences

### Positive
- Clean navigation for new users; power users can enable everything.
- Tags and Notes Editor can ship without cluttering the default experience.
- Sets a consistent pattern for future additions.

### Negative / limits
- Settings page must maintain the toggle list as pages are added.
- A user who disables a page and forgets may think a feature is missing.

## References

- `CONTEXT.md` — Sidebar definition
- `src/components/layout/Sidebar.tsx` — where toggle state will be consumed
- `src/stores/` — sidebar visibility state will be persisted here
