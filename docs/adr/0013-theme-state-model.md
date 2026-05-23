# ADR 0013: Theme state model — preset/override layering, custom palettes, and glass effect removal

## Status

Accepted

## Context

The app has a Zustand-persisted theme store (`src/stores/theme.ts`) that controls which color preset is active, whether the user has per-color overrides applied, and whether any custom palettes have been saved. Over time the store accumulated three problems:

1. **Overrides were sticky across preset switches.** Per-color overrides accumulated in state and were never cleared when the user switched to a different preset. The result was that a user who had customized colors could not return to any preset's defaults — the overrides always won, silently.

2. **Glass effect was coupled to the Cupertino theme.** Glass rendering properties (`glassEffects`, later `glassIntensity`, `glassTintColor`, `glassTintAlpha`) were stored as theme-level state, making the feature Cupertino-exclusive. Users on other themes could not access it; the coupling also made the store schema increasingly awkward.

3. **Custom palettes had no save/restore primitive.** Users who wanted a repeatable custom look had to re-enter every color override each session.

## Decision

### 1. Preset switch clears overrides

`setPreset` resets both `overrides` and `overrideAlphas` to `{}` before applying the new preset. This makes preset switching a clean operation: the user always gets the unmodified preset. Per-color overrides accumulate on top of the active preset but are scoped to that preset selection — they do not survive a switch.

```ts
setPreset(p) {
  applyAndSet({ preset: p, overrides: {}, overrideAlphas: {} });
}
```

Switching to a custom palette (via `applyCustomPalette`) replaces `preset + overrides + overrideAlphas` atomically from the palette snapshot, so saved customizations still work.

### 2. Custom palettes as full snapshots

A `CustomPalette` captures `{ name, preset, mode, overrides, overrideAlphas }` at save time. Applying one calls `applyAndSet` with the full snapshot, restoring the exact visual state the user had when they saved. Palettes are stored inside the Zustand persist payload alongside built-in preset selection.

Palettes are upserted by name (case-insensitive): saving with an existing name overwrites rather than duplicates.

### 3. Glass effect removed from store

Glass effect properties were removed in two migration steps (store version 0 → 1 and version 2 → 3). They are no longer part of the theme state. The migration function strips all glass-related keys from persisted storage on first load after upgrade:

- v0 → v1: delete `glassEffects`
- v2 → v3: delete `glassIntensity`, `glassTintColor`, `glassTintAlpha` (also strips them from any saved custom palette entries)

The feature is not currently re-exposed as a theme-agnostic toggle. If re-introduced, it should live as a separate store key rather than inside the color preset/override model.

### 4. Color picker pre-populates from active computed color

When the user opens a color input in the palette editor, the initial hex value is sourced from the currently active computed color (i.e. `getColors(preset, mode, overrides, overrideAlphas)[key]`), not from the base preset default. This ensures the picker starts where the user currently is, not where the preset started.

## Store schema version history

| Version | Change |
|---|---|
| 0 | Initial. Glass effect as `glassEffects` boolean. |
| 1 | `glassEffects` removed. |
| 2 | `overrideAlphas` and `customPalettes` added. |
| 3 | `glassIntensity`, `glassTintColor`, `glassTintAlpha` removed from store and from saved palette entries. |

## Consequences

### Positive
- Users can always return to a clean preset by switching to it — no hidden override state persists.
- Custom palettes are self-contained and portable: they include the base preset and all overrides in a single named entry.
- Glass effect removal simplifies the store and migrations; no Cupertino special-casing remains.

### Negative / limits
- Switching presets is destructive to any unsaved overrides. There is no "undo preset switch" — the user must have saved a custom palette beforehand to recover their overrides.
- Custom palettes are stored in the Zustand persist payload (localStorage). They are not synced via the settings API and will not survive a full local storage clear.
- Glass effect is currently unavailable on any theme. The re-introduction path (theme-agnostic toggle) is deferred and undesigned.

## References

- `src/stores/theme.ts` — `useThemeStore`, `CustomPalette`, `setPreset`, `applyCustomPalette`, migration function
- `src/lib/theme.ts` — `getColors`, `applyTheme`, `ThemeColors`
- `src/components/settings/AppearanceSection.tsx` — palette editor UI, color picker initialization
- `CONTEXT.md` — Custom Palette and Glass Effect glossary entries
