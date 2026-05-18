import { create } from "zustand";

interface SelectionState {
  selectedIds: Set<string>;
  toggle: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedIds: new Set<string>(),

  toggle(id) {
    set((state) => {
      const next = new Set(state.selectedIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { selectedIds: next };
    });
  },

  selectAll(ids) {
    set({ selectedIds: new Set(ids) });
  },

  clear() {
    set({ selectedIds: new Set<string>() });
  },
}));
