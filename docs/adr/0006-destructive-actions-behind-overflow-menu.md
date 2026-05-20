# ADR 0006: Destructive and secondary actions behind overflow menus

## Status

Accepted

## Context

Several views had destructive actions (Archive, Delete) rendered as first-class buttons at the same visual weight as primary actions (Import, Export, Edit) or as inline card buttons visible at all times. This made the UI feel cluttered and gave equal prominence to rarely-used, hard-to-reverse operations.

Specific instances that triggered this decision:

- **ProjectDetailPage header**: Archive and Delete sat alongside Import / Export / Edit as equal-weight `Button` components.
- **ProjectCard (ProjectsPage list)**: Every card showed Archive and Delete buttons inline, always visible.
- **ProjectsPage tab bar**: An "Archived" tab had equal visual weight to the default "Active" tab, surfacing a secondary view as a peer of the primary one.

## Decision

1. **Overflow menu (`···`) for destructive actions on detail pages.** On `ProjectDetailPage`, Archive and Delete are collapsed into a `···` ghost button that reveals a small dropdown. The dropdown dismisses on outside click. This pattern should be applied to any future detail page that needs status-change or delete actions.

2. **No inline actions on list cards.** `ProjectCard` is navigation-only — clicking it opens the detail page where the `···` menu is available. Cards must not contain action buttons.

3. **Secondary views as subtle links, not tabs.** The Archived projects view is accessible via a small muted `"N archived"` count link next to the page heading rather than a tab. The link only appears when archived projects exist. This pattern applies to any secondary filtered view that is not part of the primary workflow.

## Consequences

### Positive
- Primary actions (Import, Export, Edit, New Project) are unambiguous.
- Destructive actions require an intentional extra click — reducing accidental triggers.
- Card grids are cleaner; the click target for navigation is unambiguous.
- Secondary views (archived, deleted) are discoverable without being prominent.

### Negative / limits
- Archive/Delete are slightly harder to reach — intentional, but may frustrate power users who use them frequently.
- The `···` overflow pattern must be implemented per-page; there is no shared dropdown component yet.

## References

- `src/pages/ProjectDetailPage.tsx` — `···` overflow menu implementation
- `src/components/projects/ProjectCard.tsx` — navigation-only card
- `src/pages/ProjectsPage.tsx` — "N archived" link pattern