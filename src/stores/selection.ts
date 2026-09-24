import { create } from "zustand";

/** Click modifiers; `ctrl` covers Cmd on macOS. */
export interface ClickMods {
  ctrl?: boolean;
  shift?: boolean;
}

export function clickMods(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): ClickMods {
  return { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
}

/** Next selection for a click on `id`: Shift adds the anchor..id range of
 *  `order`, anything else toggles `id` and makes it the anchor. */
export function applyClick(
  selected: ReadonlySet<string>,
  anchor: string | null,
  id: string,
  mods: ClickMods,
  order: readonly string[],
): { selectedIds: Set<string>; anchor: string | null } {
  const next = new Set(selected);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  if (mods.shift && from !== -1 && to !== -1) {
    for (const rid of order.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(rid);
    return { selectedIds: next, anchor };
  }
  if (!next.delete(id)) next.add(id);
  return { selectedIds: next, anchor: id };
}

interface SelectionState {
  selectedIds: Set<string>;
  /** Last toggled paper; the fixed end of a Shift range. */
  anchor: string | null;
  select: (id: string, mods: ClickMods, visibleOrder: readonly string[]) => void;
  selectAll: (ids: string[]) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedIds: new Set<string>(),
  anchor: null,

  select(id, mods, visibleOrder) {
    set((state) => applyClick(state.selectedIds, state.anchor, id, mods, visibleOrder));
  },

  selectAll(ids) {
    set({ selectedIds: new Set(ids), anchor: null });
  },

  clear() {
    set({ selectedIds: new Set<string>(), anchor: null });
  },
}));
