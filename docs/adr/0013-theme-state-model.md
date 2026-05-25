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

### 3. Color picker pre-populates from active computed color

When the user opens a color input in the palette editor, the initial hex value is sourced from the currently active computed color (i.e. `getColors(preset, mode, overrides, overrideAlphas)[key]`), not from the base preset default. This ensures the picker starts where the user currently is, not where the preset started. For all intents and purposes this is equivalent behavior but handles edge cases that could confuse users

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

### Negative / limits
- Custom palettes are stored in the Zustand persist payload (localStorage). They are not synced via the settings API and will not survive a full local storage clear.
- Glass effect is currently unavailable on any theme. The re-introduction path (theme-agnostic toggle) is indefintely deferred.

## References

- `src/stores/theme.ts` — `useThemeStore`, `CustomPalette`, `setPreset`, `applyCustomPalette`, migration function
- `src/lib/theme.ts` — `getColors`, `applyTheme`, `ThemeColors`
- `src/components/settings/AppearanceSection.tsx` — palette editor UI, color picker initialization
