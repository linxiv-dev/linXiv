export type ThemeMode = "dark" | "light";

export type ThemeColors = {
  bg: string;
  panel: string;
  border: string;
  accent: string;
  text: string;
  muted: string;
  success: string;
  danger: string;
};

export const PRESETS = {
  Navy: {
    dark: {
      bg: "#0f0f1a",
      panel: "#1a1a2e",
      border: "#2e2e50",
      accent: "#5b8dee",
      text: "#ccccdd",
      muted: "#7777aa",
      success: "#4caf88",
      danger: "#e05c6c",
    },
    light: {
      bg: "#f0f4ff",
      panel: "#ffffff",
      border: "#c8d4f0",
      accent: "#4a7de0",
      text: "#1a1a3e",
      muted: "#6677aa",
      success: "#3d9e76",
      danger: "#d64e5d",
    },
  },
  Slate: {
    dark: {
      bg: "#1a1b1e",
      panel: "#25262b",
      border: "#373a40",
      accent: "#748ffc",
      text: "#c1c2c5",
      muted: "#868e96",
      success: "#51cf66",
      danger: "#ff6b6b",
    },
    light: {
      bg: "#f5f5f7",
      panel: "#ffffff",
      border: "#e0e1e5",
      accent: "#5a7cf8",
      text: "#1a1b1e",
      muted: "#6b7280",
      success: "#40c057",
      danger: "#fa5252",
    },
  },
  Charcoal: {
    dark: {
      bg: "#1c1c1c",
      panel: "#252525",
      border: "#333333",
      accent: "#e8912d",
      text: "#d4d4d4",
      muted: "#888888",
      success: "#6abf69",
      danger: "#e57373",
    },
    light: {
      bg: "#f6f6f6",
      panel: "#ffffff",
      border: "#dedede",
      accent: "#d4811f",
      text: "#1c1c1c",
      muted: "#666666",
      success: "#57a85a",
      danger: "#cc5252",
    },
  },
  Forest: {
    dark: {
      bg: "#0d1b12",
      panel: "#162318",
      border: "#243d2c",
      accent: "#4caf88",
      text: "#c8d8cc",
      muted: "#6b8f72",
      success: "#81c784",
      danger: "#ef9a9a",
    },
    light: {
      bg: "#f0f5f2",
      panel: "#ffffff",
      border: "#c4d9cc",
      accent: "#3a9a72",
      text: "#0d1b12",
      muted: "#527a5a",
      success: "#5aad5c",
      danger: "#e06060",
    },
  },
  Ember: {
    dark: {
      bg: "#1a1009",
      panel: "#261a0e",
      border: "#3d2b18",
      accent: "#e8912d",
      text: "#ddd0c4",
      muted: "#a0897a",
      success: "#a5d6a7",
      danger: "#ef5350",
    },
    light: {
      bg: "#fdf5ee",
      panel: "#ffffff",
      border: "#eed8be",
      accent: "#cc7a1e",
      text: "#2a1a09",
      muted: "#8a6a50",
      success: "#7ab87c",
      danger: "#d94040",
    },
  },
  Cupertino: {
    light: {
      bg: "#eef1f6",
      panel: "rgba(255,255,255,0.72)",
      border: "rgba(209,209,214,0.6)",
      accent: "#007aff",
      text: "#1c1c1e",
      muted: "#8e8e93",
      success: "#34c759",
      danger: "#ff3b30",
    },
    dark: {
      bg: "#1c1c1e",
      panel: "rgba(44,44,46,0.80)",
      border: "rgba(58,58,60,0.9)",
      accent: "#0a84ff",
      text: "#ffffff",
      muted: "#8e8e93",
      success: "#34c759",
      danger: "#ff3b30",
    },
  },
} as const;

export type PresetName = keyof typeof PRESETS;

// Exported so components can share a single source of truth for hex validation.
export const VALID_HEX = /^#[0-9a-fA-F]{6}$/;

// Glass blur and saturation constants (Cupertino preset at 100% intensity).
const GLASS_BLUR_MAX = 24;
const GLASS_BLUR_SM_MAX = 20;
const GLASS_SAT_RANGE = 0.8; // saturation goes from 1.0 to (1.0 + GLASS_SAT_RANGE)

export function getColors(
  preset: PresetName,
  mode: ThemeMode,
  overrides: Partial<ThemeColors> = {}
): ThemeColors {
  return { ...PRESETS[preset][mode], ...overrides } as ThemeColors;
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

export function applyTheme(
  preset: PresetName,
  mode: ThemeMode,
  overrides: Partial<ThemeColors> = {},
  glassIntensity = 100,
  glassTintColor = "",
  glassTintAlpha = 15
): void {
  const colors = getColors(preset, mode, overrides);
  const root = document.documentElement;
  root.setAttribute("data-theme", preset.toLowerCase());
  root.setAttribute("data-mode", mode);
  root.style.setProperty("--color-bg", colors.bg);
  root.style.setProperty("--color-panel", colors.panel);
  root.style.setProperty("--color-border", colors.border);
  root.style.setProperty("--color-accent", colors.accent);
  root.style.setProperty("--color-text", colors.text);
  root.style.setProperty("--color-muted", colors.muted);
  root.style.setProperty("--color-success", colors.success);
  root.style.setProperty("--color-danger", colors.danger);

  if (preset === "Cupertino") {
    const t = glassIntensity / 100;
    root.style.setProperty("--glass-blur", `${Math.round(t * GLASS_BLUR_MAX)}px`);
    root.style.setProperty("--glass-blur-sm", `${Math.round(t * GLASS_BLUR_SM_MAX)}px`);
    root.style.setProperty("--glass-sat", `${(1 + t * GLASS_SAT_RANGE).toFixed(2)}`);
    // Tint applies independently from blur intensity.
    const tint = VALID_HEX.test(glassTintColor)
      ? hexToRgba(glassTintColor, glassTintAlpha / 100)
      : "transparent";
    root.style.setProperty("--glass-tint", tint);
    // data-glass gates backdrop-filter rules; tint CSS applies regardless.
    if (glassIntensity > 0) {
      root.setAttribute("data-glass", "true");
    } else {
      root.removeAttribute("data-glass");
    }
  } else {
    root.style.setProperty("--glass-blur", "0px");
    root.style.setProperty("--glass-blur-sm", "0px");
    root.style.setProperty("--glass-sat", "1");
    root.style.setProperty("--glass-tint", "transparent");
    root.removeAttribute("data-glass");
  }
}
