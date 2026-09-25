import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyTheme, clampAlpha, sanitizeOverrides, upsertByName, VALID_HEX } from "../lib/theme";
import type { ColorAlphas, PresetName, ThemeColors, ThemeMode } from "../lib/theme";
import { pushThemeToEditor, EDITOR_ORIGIN } from "../pages/editorConfig";
import { migrateTheme } from "./migrations.ts";

const STORAGE_KEY = "linxiv-theme";

// Set by EditorPage on mount/iframe-load (cleared on unmount) so the store can
// push resolved theme colors to the embedded TeXbrain editor whenever the theme
// changes — covers programmatic applyTheme callers outside React's render cycle.
// No-op when no editor is mounted. Acyclic: editorConfig imports nothing, and
// ../lib/editorBridge imports ../lib/theme, not this store.
let editorFrame: Window | null = null;
export function registerEditorFrame(frame: Window | null): void {
  editorFrame = frame;
}

export interface CustomPalette {
  name: string;
  preset: PresetName;
  /** Captured at save time so applying restores the intended mode. Optional for backwards compat. */
  mode?: ThemeMode;
  overrides: Partial<ThemeColors>;
  overrideAlphas: ColorAlphas;
}

interface ThemeState {
  preset: PresetName;
  mode: ThemeMode;
  overrides: Partial<ThemeColors>;
  overrideAlphas: ColorAlphas;
  customPalettes: CustomPalette[];
  setPreset: (p: PresetName) => void;
  setMode: (m: ThemeMode) => void;
  setOverride: (key: keyof ThemeColors, val: string) => void;
  removeOverride: (key: keyof ThemeColors) => void;
  setOverrideAlpha: (key: keyof ThemeColors, alpha: number) => void;
  setOverrideWithAlpha: (key: keyof ThemeColors, hex: string, alpha: number) => void;
  saveCustomPalette: (name: string) => void;
  deleteCustomPalette: (name: string) => void;
  applyCustomPalette: (palette: CustomPalette) => void;
  /** Apply server-persisted overrides + alphas in one shot (used on boot restore). */
  restoreFromSettings: (overrides: Partial<ThemeColors>, overrideAlphas: ColorAlphas) => void;
}

export type AppThemeState = ReturnType<typeof useThemeStore.getState>;

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => {
      function applyAndSet(patch: Partial<ThemeState>) {
        set(patch);
        const next = get();
        applyTheme(next.preset, next.mode, next.overrides, next.overrideAlphas);
        pushThemeToEditor(editorFrame, EDITOR_ORIGIN, {
          preset: next.preset,
          mode: next.mode,
          overrides: next.overrides,
          overrideAlphas: next.overrideAlphas,
        });
      }

      return {
        preset: "Navy" as PresetName,
        mode: "dark" as ThemeMode,
        overrides: {},
        overrideAlphas: {},
        customPalettes: [],

        setPreset(p) {
          applyAndSet({ preset: p, overrides: {}, overrideAlphas: {} });
        },

        setMode(m) {
          applyAndSet({ mode: m });
        },

        setOverride(key, val) {
          if (!VALID_HEX.test(val)) return;
          const next = { ...get().overrides, [key]: val };
          applyAndSet({ overrides: next });
        },

        removeOverride(key) {
          if (!(key in get().overrides)) return;
          const nextOverrides = { ...get().overrides };
          const nextAlphas = { ...get().overrideAlphas };
          delete nextOverrides[key];
          delete nextAlphas[key];
          applyAndSet({ overrides: nextOverrides, overrideAlphas: nextAlphas });
        },

        setOverrideAlpha(key, alpha) {
          if (get().overrides[key] === undefined) return;
          const next = { ...get().overrideAlphas, [key]: clampAlpha(alpha) };
          applyAndSet({ overrideAlphas: next });
        },

        setOverrideWithAlpha(key, hex, alpha) {
          if (!VALID_HEX.test(hex)) return;
          const nextOverrides = { ...get().overrides, [key]: hex };
          const nextAlphas = { ...get().overrideAlphas, [key]: clampAlpha(alpha) };
          applyAndSet({ overrides: nextOverrides, overrideAlphas: nextAlphas });
        },

        saveCustomPalette(name) {
          const { preset, mode, overrides, overrideAlphas, customPalettes } = get();
          const palette: CustomPalette = {
            name,
            preset,
            mode,
            overrides: { ...overrides },
            overrideAlphas: { ...overrideAlphas },
          };
          set({ customPalettes: upsertByName(customPalettes, palette) });
        },

        deleteCustomPalette(name) {
          const lower = name.toLowerCase();
          set({ customPalettes: get().customPalettes.filter((p) => p.name.toLowerCase() !== lower) });
        },

        applyCustomPalette(palette) {
          applyAndSet({
            preset: palette.preset,
            mode: palette.mode ?? get().mode,
            overrides: { ...palette.overrides },
            overrideAlphas: { ...palette.overrideAlphas },
          });
        },

        restoreFromSettings(overrides, overrideAlphas) {
          applyAndSet(sanitizeOverrides(overrides, overrideAlphas));
        },
      };
    },
    {
      name: STORAGE_KEY,
      version: 3,
      migrate: migrateTheme,
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.preset, state.mode, state.overrides, state.overrideAlphas);
        }
      },
    }
  )
);
