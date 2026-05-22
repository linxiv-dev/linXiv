import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SidebarPageKey = "graph" | "search" | "doi" | "tags" | "notes";

export type SidebarPages = Record<SidebarPageKey, boolean>;

const DEFAULT_SIDEBAR_PAGES: SidebarPages = {
  graph: true,
  search: true,
  doi: true,
  tags: false,
  notes: false,
};

export type ExportFormatKey = "lxproj" | "bibtex" | "obsidian";

export type ExportMethods = Record<ExportFormatKey, boolean>;

const DEFAULT_EXPORT_METHODS: ExportMethods = {
  lxproj: true,
  bibtex: true,
  obsidian: true,
};

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  sidebarPages: SidebarPages;
  setSidebarPage: (page: SidebarPageKey, enabled: boolean) => void;
  exportMethods: ExportMethods;
  setExportMethod: (format: ExportFormatKey, enabled: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      sidebarPages: DEFAULT_SIDEBAR_PAGES,
      exportMethods: DEFAULT_EXPORT_METHODS,

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
    }),
    {
      name: "linxiv-ui",
      version: 2,
      migrate(persisted, fromVersion) {
        const state = (persisted ?? {}) as Partial<UiState>;
        if (fromVersion < 1) {
          state.sidebarPages = { ...DEFAULT_SIDEBAR_PAGES, ...state.sidebarPages };
        }
        if (fromVersion < 2) {
          state.exportMethods = { ...DEFAULT_EXPORT_METHODS, ...state.exportMethods };
        }
        return state;
      },
    }
  )
);
