export const PRESETS = {
  Navy: {
    bg: "#0f0f1a",
    panel: "#1a1a2e",
    border: "#2e2e50",
    accent: "#5b8dee",
    text: "#ccccdd",
    muted: "#7777aa",
    success: "#4caf88",
    danger: "#e05c6c",
  },
  Slate: {
    bg: "#1a1b1e",
    panel: "#25262b",
    border: "#373a40",
    accent: "#748ffc",
    text: "#c1c2c5",
    muted: "#868e96",
    success: "#51cf66",
    danger: "#ff6b6b",
  },
  Charcoal: {
    bg: "#1c1c1c",
    panel: "#252525",
    border: "#333333",
    accent: "#e8912d",
    text: "#d4d4d4",
    muted: "#888888",
    success: "#6abf69",
    danger: "#e57373",
  },
  Forest: {
    bg: "#0d1b12",
    panel: "#162318",
    border: "#243d2c",
    accent: "#4caf88",
    text: "#c8d8cc",
    muted: "#6b8f72",
    success: "#81c784",
    danger: "#ef9a9a",
  },
  Ember: {
    bg: "#1a1009",
    panel: "#261a0e",
    border: "#3d2b18",
    accent: "#e8912d",
    text: "#ddd0c4",
    muted: "#a0897a",
    success: "#a5d6a7",
    danger: "#ef5350",
  },
  Cupertino: {
    bg: "#f2f2f7",
    panel: "#ffffff",
    border: "#d1d1d6",
    accent: "#007aff",
    text: "#1c1c1e",
    muted: "#8e8e93",
    success: "#34c759",
    danger: "#ff3b30",
  },
} as const;

export type PresetName = keyof typeof PRESETS;
export type ThemeColors = typeof PRESETS.Navy;

export function applyTheme(
  preset: PresetName,
  overrides: Partial<ThemeColors> = {}
): void {
  const colors = { ...PRESETS[preset], ...overrides };
  const root = document.documentElement;
  root.style.setProperty("--color-bg", colors.bg);
  root.style.setProperty("--color-panel", colors.panel);
  root.style.setProperty("--color-border", colors.border);
  root.style.setProperty("--color-accent", colors.accent);
  root.style.setProperty("--color-text", colors.text);
  root.style.setProperty("--color-muted", colors.muted);
  root.style.setProperty("--color-success", colors.success);
  root.style.setProperty("--color-danger", colors.danger);
}
