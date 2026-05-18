import { create } from "zustand";
import { applyTheme } from "../lib/theme";
import type { PresetName, ThemeColors } from "../lib/theme";

interface ThemeState {
  preset: PresetName;
  overrides: Partial<ThemeColors>;
  setPreset: (p: PresetName) => void;
  setOverride: (key: keyof ThemeColors, val: string) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  // Apply default theme immediately on store creation
  applyTheme("Navy");

  return {
    preset: "Navy",
    overrides: {},

    setPreset(p) {
      const { overrides } = get();
      applyTheme(p, overrides);
      set({ preset: p });
    },

    setOverride(key, val) {
      const { preset, overrides } = get();
      const next = { ...overrides, [key]: val };
      applyTheme(preset, next);
      set({ overrides: next });
    },
  };
});
