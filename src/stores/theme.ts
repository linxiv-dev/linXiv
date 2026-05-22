import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyTheme } from "../lib/theme";
import type { ColorAlphas, PresetName, ThemeColors, ThemeMode } from "../lib/theme";

const STORAGE_KEY = "linxiv-theme";

export interface CustomPalette {
  name: string;
  preset: PresetName;
  /** Captured at save time so applying restores the intended mode. Optional for backwards compat. */
  mode?: ThemeMode;
  overrides: Partial<ThemeColors>;
  overrideAlphas: ColorAlphas;
  glassIntensity: number;
  glassTintColor: string;
  glassTintAlpha: number;
}

interface ThemeState {
  preset: PresetName;
  mode: ThemeMode;
  overrides: Partial<ThemeColors>;
  overrideAlphas: ColorAlphas;
  glassIntensity: number;
  glassTintColor: string;
  glassTintAlpha: number;
  customPalettes: CustomPalette[];
  setPreset: (p: PresetName) => void;
  setMode: (m: ThemeMode) => void;
  setOverride: (key: keyof ThemeColors, val: string) => void;
  removeOverride: (key: keyof ThemeColors) => void;
  setOverrideAlpha: (key: keyof ThemeColors, alpha: number) => void;
  setGlassIntensity: (v: number) => void;
  setGlassTintColor: (v: string) => void;
  setGlassTintAlpha: (v: number) => void;
  saveCustomPalette: (name: string) => void;
  deleteCustomPalette: (name: string) => void;
  applyCustomPalette: (palette: CustomPalette) => void;
  /** Apply server-persisted overrides + alphas in one shot (used on boot restore). */
  restoreFromSettings: (overrides: Partial<ThemeColors>, overrideAlphas: ColorAlphas) => void;
}

export type AppThemeState = ReturnType<typeof useThemeStore.getState>;

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
          next.overrideAlphas,
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
        overrideAlphas: {},
        glassIntensity: 100,
        glassTintColor: "",
        glassTintAlpha: 15,
        customPalettes: [],

        setPreset(p) {
          applyAndSet({ preset: p, overrides: {}, overrideAlphas: {} });
        },

        setMode(m) {
          applyAndSet({ mode: m });
        },

        setOverride(key, val) {
          const next = { ...get().overrides, [key]: val };
          applyAndSet({ overrides: next });
        },

        removeOverride(key) {
          const nextOverrides = { ...get().overrides };
          const nextAlphas = { ...get().overrideAlphas };
          delete nextOverrides[key];
          delete nextAlphas[key];
          applyAndSet({ overrides: nextOverrides, overrideAlphas: nextAlphas });
        },

        setOverrideAlpha(key, alpha) {
          const next = { ...get().overrideAlphas, [key]: clamp(alpha, 0, 100) };
          applyAndSet({ overrideAlphas: next });
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

        saveCustomPalette(name) {
          const { preset, mode, overrides, overrideAlphas, glassIntensity, glassTintColor, glassTintAlpha, customPalettes } = get();
          const palette: CustomPalette = {
            name,
            preset,
            mode,
            overrides: { ...overrides },
            overrideAlphas: { ...overrideAlphas },
            glassIntensity,
            glassTintColor,
            glassTintAlpha,
          };
          const nameLower = name.toLowerCase();
          const idx = customPalettes.findIndex((p) => p.name.toLowerCase() === nameLower);
          if (idx === -1) {
            set({ customPalettes: [...customPalettes, palette] });
          } else {
            const next = [...customPalettes];
            next[idx] = palette;
            set({ customPalettes: next });
          }
        },

        deleteCustomPalette(name) {
          set({ customPalettes: get().customPalettes.filter((p) => p.name !== name) });
        },

        applyCustomPalette(palette) {
          applyAndSet({
            preset: palette.preset,
            mode: palette.mode ?? get().mode,
            overrides: { ...palette.overrides },
            overrideAlphas: { ...palette.overrideAlphas },
            glassIntensity: palette.glassIntensity,
            glassTintColor: palette.glassTintColor,
            glassTintAlpha: palette.glassTintAlpha,
          });
        },

        restoreFromSettings(overrides, overrideAlphas) {
          applyAndSet({ overrides: { ...overrides }, overrideAlphas: { ...overrideAlphas } });
        },
      };
    },
    {
      name: STORAGE_KEY,
      version: 2,
      migrate(stored: unknown, version: number) {
        const s = { ...(stored as Record<string, unknown>) };
        if (version === 0) {
          s.glassIntensity = s.glassEffects === false ? 0 : 100;
          s.glassTintColor = "";
          s.glassTintAlpha = 15;
          delete s.glassEffects;
        }
        if (version <= 1) {
          s.overrideAlphas = {};
          s.customPalettes = [];
        }
        // version 2+ CustomPalette.mode is optional — no migration needed, applyCustomPalette falls back to current mode
        return s;
      },
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(
            state.preset,
            state.mode,
            state.overrides,
            state.overrideAlphas,
            state.glassIntensity,
            state.glassTintColor,
            state.glassTintAlpha
          );
        }
      },
    }
  )
);
