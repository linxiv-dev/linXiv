import { create } from "zustand";
import { persist } from "zustand/middleware";
import { applyZoom, clampZoom, DEFAULT_ZOOM } from "../lib/zoom.ts";
import { applyDensity, normalizeDensity, DEFAULT_DENSITY, type Density } from "../lib/density.ts";
import {
  DEFAULT_EXPORT_METHODS,
  DEFAULT_SIDEBAR_PAGES,
  migrateUi,
  type ColorLabel,
  type ExportFormatKey,
  type ExportMethods,
  type SidebarPageKey,
  type SidebarPages,
} from "./migrations.ts";

export type { ColorLabel, ExportFormatKey, ExportMethods, SidebarPageKey, SidebarPages };

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  sidebarPages: SidebarPages;
  setSidebarPage: (page: SidebarPageKey, enabled: boolean) => void;
  exportMethods: ExportMethods;
  setExportMethod: (format: ExportFormatKey, enabled: boolean) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
  density: Density;
  setDensity: (density: Density) => void;
  hideSingleAuthors: boolean;
  setHideSingleAuthors: (hide: boolean) => void;
  colorLabels: ColorLabel[];
  setColorLabels: (labels: ColorLabel[]) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      sidebarPages: DEFAULT_SIDEBAR_PAGES,
      exportMethods: DEFAULT_EXPORT_METHODS,
      zoom: DEFAULT_ZOOM,
      density: DEFAULT_DENSITY,
      hideSingleAuthors: false,
      colorLabels: [],

      toggleSidebar() {
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
      },

      setSidebarPage(page, enabled) {
        set((state) => ({
          sidebarPages: { ...state.sidebarPages, [page]: enabled },
        }));
      },

      setExportMethod(format, enabled) {
        set((state) => ({
          exportMethods: { ...state.exportMethods, [format]: enabled },
        }));
      },

      setZoom(zoom) {
        const next = clampZoom(zoom);
        set({ zoom: next });
        applyZoom(next);
      },

      setDensity(density) {
        const next = normalizeDensity(density);
        set({ density: next });
        applyDensity(next);
      },

      setHideSingleAuthors(hide) {
        set({ hideSingleAuthors: hide });
      },

      setColorLabels(labels) {
        set({ colorLabels: labels });
      },
    }),
    {
      name: "linxiv-ui",
      version: 8,
      migrate: migrateUi,
      // The webview starts every launch at the defaults; re-apply the persisted
      // zoom and density, normalized in case a stored value is out of range.
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.zoom = clampZoom(state.zoom);
          applyZoom(state.zoom);
          state.density = normalizeDensity(state.density);
          applyDensity(state.density);
        }
      },
    }
  )
);
