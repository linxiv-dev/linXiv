import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyTheme } from "../lib/theme";
import type { PresetName, ThemeColors, ThemeMode } from "../lib/theme";

const STORAGE_KEY = "linxiv-theme";

interface ThemeState {
  preset: PresetName;
  mode: ThemeMode;
  overrides: Partial<ThemeColors>;
  glassIntensity: number;
  glassTintColor: string;
  glassTintAlpha: number;
  setPreset: (p: PresetName) => void;
  setMode: (m: ThemeMode) => void;
  setOverride: (key: keyof ThemeColors, val: string) => void;
  removeOverride: (key: keyof ThemeColors) => void;
  setGlassIntensity: (v: number) => void;
  setGlassTintColor: (v: string) => void;
  setGlassTintAlpha: (v: number) => void;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => {
      function applyAndSet(patch: Partial<ThemeState>) {
        const s = get();
        const next = { ...s, ...patch } as ThemeState;
        applyTheme(
          next.preset,
          next.mode,
          next.overrides,
          next.glassIntensity,
          next.glassTintColor,
          next.glassTintAlpha
        );
        set(patch);
      }

      return {
        preset: "Navy" as PresetName,
        mode: "dark" as ThemeMode,
        overrides: {},
        glassIntensity: 100,
        glassTintColor: "",
        glassTintAlpha: 15,

        setPreset(p) {
          applyAndSet({ preset: p, overrides: {} });
        },

        setMode(m) {
          applyAndSet({ mode: m });
        },

        setOverride(key, val) {
          const next = { ...get().overrides, [key]: val };
          applyAndSet({ overrides: next });
        },

        removeOverride(key) {
          const next = { ...get().overrides };
          delete next[key];
          applyAndSet({ overrides: next });
        },

        setGlassIntensity(v) {
          applyAndSet({ glassIntensity: clamp(v, 0, 100) });
        },

        setGlassTintColor(v) {
          applyAndSet({ glassTintColor: v });
        },

        setGlassTintAlpha(v) {
          applyAndSet({ glassTintAlpha: clamp(v, 0, 100) });
        },
      };
    },
    {
      name: STORAGE_KEY,
      version: 1,
      migrate(stored: unknown, version: number) {
        const s = { ...(stored as Record<string, unknown>) };
        if (version === 0) {
          s.glassIntensity = s.glassEffects === false ? 0 : 100;
          s.glassTintColor = "";
          s.glassTintAlpha = 15;
          delete s.glassEffects;
        }
        return s;
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(
            state.preset,
            state.mode,
            state.overrides,
            state.glassIntensity,
            state.glassTintColor,
            state.glassTintAlpha
          );
        }
      },
    }
  )
);
