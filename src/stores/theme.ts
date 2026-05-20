import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyTheme } from "../lib/theme";
import type { PresetName, ThemeColors, ThemeMode } from "../lib/theme";

const STORAGE_KEY = "linxiv-theme";

interface ThemeState {
  preset: PresetName;
  mode: ThemeMode;
  overrides: Partial<ThemeColors>;
  glassEffects: boolean;
  setPreset: (p: PresetName) => void;
  setMode: (m: ThemeMode) => void;
  setOverride: (key: keyof ThemeColors, val: string) => void;
  setGlassEffects: (enabled: boolean) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      preset: "Navy" as PresetName,
      mode: "dark" as ThemeMode,
      overrides: {},
      glassEffects: true,

      setPreset(p) {
        const { mode, glassEffects } = get();
        applyTheme(p, mode, {}, glassEffects);
        set({ preset: p, overrides: {} });
      },

      setMode(m) {
        const { preset, overrides, glassEffects } = get();
        applyTheme(preset, m, overrides, glassEffects);
        set({ mode: m });
      },

      setOverride(key, val) {
        const { preset, mode, overrides, glassEffects } = get();
        const next = { ...overrides, [key]: val };
        applyTheme(preset, mode, next, glassEffects);
        set({ overrides: next });
      },

      setGlassEffects(enabled) {
        const { preset, mode, overrides } = get();
        applyTheme(preset, mode, overrides, enabled);
        set({ glassEffects: enabled });
      },
    }),
    {
      name: STORAGE_KEY,
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.preset, state.mode, state.overrides, state.glassEffects);
        }
      },
    }
  )
);
