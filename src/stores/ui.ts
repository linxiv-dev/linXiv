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

interface UiState {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  sidebarPages: SidebarPages;
  setSidebarPage: (page: SidebarPageKey, enabled: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      sidebarPages: DEFAULT_SIDEBAR_PAGES,

      toggleSidebar() {
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
      },

      setSidebarPage(page, enabled) {
        set((state) => ({
          sidebarPages: { ...state.sidebarPages, [page]: enabled },
        }));
      },
    }),
    {
      name: "linxiv-ui",
      version: 1,
      migrate(persisted, fromVersion) {
        const state = (persisted ?? {}) as Partial<UiState>;
        if (fromVersion < 1) {
          state.sidebarPages = { ...DEFAULT_SIDEBAR_PAGES, ...state.sidebarPages };
        }
        return state;
      },
    }
  )
);
