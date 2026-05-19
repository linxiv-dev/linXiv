import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyTheme } from "../lib/theme";
import type { PresetName, ThemeColors } from "../lib/theme";

const STORAGE_KEY = "linxiv-theme";

interface ThemeState {
  preset: PresetName;
  overrides: Partial<ThemeColors>;
  glassEffects: boolean;
  setPreset: (p: PresetName) => void;
  setOverride: (key: keyof ThemeColors, val: string) => void;
  setGlassEffects: (enabled: boolean) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      preset: "Navy" as PresetName,
      overrides: {},
      glassEffects: true,

      setPreset(p) {
        const { overrides, glassEffects } = get();
        applyTheme(p, overrides, glassEffects);
        set({ preset: p });
      },

      setOverride(key, val) {
        const { preset, overrides, glassEffects } = get();
        const next = { ...overrides, [key]: val };
        applyTheme(preset, next, glassEffects);
        set({ overrides: next });
      },

      setGlassEffects(enabled) {
        const { preset, overrides } = get();
        applyTheme(preset, overrides, enabled);
        set({ glassEffects: enabled });
      },
    }),
    {
      name: STORAGE_KEY,
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.preset, state.overrides, state.glassEffects);
        }
      },
    }
  )
);
