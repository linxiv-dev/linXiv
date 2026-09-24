// Run: node --experimental-transform-types --test src/stores/stores.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// persist needs localStorage; zoom/density write to the document root.
const storage = new Map<string, string>();
const root = {
  dataset: {} as Record<string, string>,
  style: { props: {} as Record<string, string>, setProperty(k: string, v: string) { this.props[k] = v; } },
};
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
  document: { documentElement: root },
  window: globalThis, // zustand persist reads window.localStorage
});
// A persisted ui blob with out-of-range values, rehydrated at import.
storage.set(
  "linxiv-ui",
  JSON.stringify({ version: 7, state: { zoom: 9, density: "huge", sidebarCollapsed: true } })
);

const { useSelectionStore } = await import("./selection.ts");
const { useImportJobsStore } = await import("./importJobs.ts");
const { useLibraryStore } = await import("./library.ts");
const { useShortcutsStore } = await import("./shortcuts.ts");
const { useBackendStore, libraryFetch } = await import("./backend.ts");
const { useUiStore } = await import("./ui.ts");
const { DEFAULT_SIDEBAR_PAGES, DEFAULT_EXPORT_METHODS } = await import("./migrations.ts");

const persisted = (key: string) => JSON.parse(storage.get(key) ?? "null");

test("selection: a plain click adds then removes, always as a fresh Set", () => {
  const s = useSelectionStore.getState();
  const before = s.selectedIds;
  s.select("a", {}, []);
  const afterAdd = useSelectionStore.getState().selectedIds;
  assert.notEqual(afterAdd, before);
  assert.deepEqual([...afterAdd], ["a"]);
  s.select("a", {}, []);
  assert.equal(useSelectionStore.getState().selectedIds.size, 0);
});

test("selection: selectAll replaces the set, clear empties it", () => {
  const s = useSelectionStore.getState();
  s.select("x", {}, []);
  s.selectAll(["a", "b", "a"]);
  assert.deepEqual([...useSelectionStore.getState().selectedIds], ["a", "b"]);
  s.clear();
  assert.equal(useSelectionStore.getState().selectedIds.size, 0);
});

test("importJobs: new jobs start processing and append in order", () => {
  const s = useImportJobsStore.getState();
  s.clear();
  s.addJobs([{ uid: 1, filename: "a.pdf" }]);
  s.addJobs([{ uid: 2, filename: "b.pdf" }]);
  assert.deepEqual(useImportJobsStore.getState().jobs, [
    { uid: 1, filename: "a.pdf", status: "processing" },
    { uid: 2, filename: "b.pdf", status: "processing" },
  ]);
});

test("importJobs: updateJob patches only the matching uid", () => {
  const s = useImportJobsStore.getState();
  s.clear();
  s.addJobs([{ uid: 1, filename: "a.pdf" }, { uid: 2, filename: "b.pdf" }]);
  s.updateJob(2, { status: "error", error: "bad pdf" });
  s.updateJob(99, { status: "done" });
  const [a, b] = useImportJobsStore.getState().jobs;
  assert.equal(a.status, "processing");
  assert.deepEqual(b, { uid: 2, filename: "b.pdf", status: "error", error: "bad pdf" });
  s.clear();
  assert.deepEqual(useImportJobsStore.getState().jobs, []);
});

test("library: session defaults and setters", () => {
  const s = useLibraryStore.getState();
  assert.equal(s.search, "");
  assert.equal(s.filterMode, "all");
  assert.equal(s.sort, "published_desc");
  s.setSearch("mamba");
  s.setFilterMode("no_pdf");
  s.setSort("title_asc");
  const { search, filterMode, sort } = useLibraryStore.getState();
  assert.deepEqual({ search, filterMode, sort }, { search: "mamba", filterMode: "no_pdf", sort: "title_asc" });
  assert.equal(storage.has("linxiv-library"), false);
});

test("shortcuts: set and clear overrides, persisted at version 1", () => {
  const s = useShortcutsStore.getState();
  const o = { ctrl: true, alt: false, shift: false, key: "k" };
  s.setOverride("search", o);
  s.setOverride("save", { ...o, key: "s" });
  assert.deepEqual(persisted("linxiv-shortcuts"), {
    state: { overrides: { search: o, save: { ...o, key: "s" } } },
    version: 1,
  });
  s.clearOverride("search");
  assert.deepEqual(Object.keys(useShortcutsStore.getState().overrides), ["save"]);
});

test("shortcuts: clearing an unknown id leaves the state untouched", () => {
  const before = useShortcutsStore.getState().overrides;
  useShortcutsStore.getState().clearOverride("nope");
  assert.equal(useShortcutsStore.getState().overrides, before);
});

test("backend: setDefault persists; libraryFetch routes by the default", async () => {
  const lab = { id: "b1", label: "Lab", node_address: "linxivnode" };
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    return Response.json({ ok: true });
  }) as typeof fetch;

  assert.deepEqual(await libraryFetch("/api/papers"), { ok: true });
  assert.deepEqual(urls, ["/api/papers"]);

  useBackendStore.getState().setDefault(lab);
  assert.deepEqual(persisted("linxiv-backend").state, { defaultBackend: lab });
  // Outside the desktop app a remote default refuses instead of fetching locally.
  await assert.rejects(libraryFetch("/api/papers"), {
    name: "ApiError",
    status: 500,
    message: "Remote backends require the desktop app",
  });
  assert.equal(urls.length, 1);

  useBackendStore.getState().setDefault(null);
  assert.equal(useBackendStore.getState().defaultBackend, null);
});

test("ui: rehydration clamps a persisted zoom and density and applies them", () => {
  const s = useUiStore.getState();
  assert.equal(s.zoom, 2);
  assert.equal(s.density, "comfortable");
  assert.equal(s.sidebarCollapsed, true);
  assert.equal(root.style.props.zoom, "2");
  assert.equal(root.dataset.density, "comfortable");
});

test("ui: setZoom clamps, rounds and applies", () => {
  const s = useUiStore.getState();
  s.setZoom(0.1);
  assert.equal(useUiStore.getState().zoom, 0.5);
  s.setZoom(1.234);
  assert.equal(useUiStore.getState().zoom, 1.23);
  assert.equal(root.style.props.zoom, "1.23");
  s.setZoom(NaN);
  assert.equal(useUiStore.getState().zoom, 1);
});

test("ui: setDensity normalizes unknown values to the default", () => {
  const s = useUiStore.getState();
  s.setDensity("compact");
  assert.equal(root.dataset.density, "compact");
  s.setDensity("dense" as never);
  assert.equal(useUiStore.getState().density, "comfortable");
  assert.equal(root.dataset.density, "comfortable");
});

test("ui: page and export toggles change one key and persist", () => {
  const s = useUiStore.getState();
  s.toggleSidebar();
  s.setSidebarPage("tags", true);
  s.setExportMethod("zotero", false);
  s.setHideSingleAuthors(true);
  const st = useUiStore.getState();
  assert.equal(st.sidebarCollapsed, false);
  assert.deepEqual(st.sidebarPages, { ...DEFAULT_SIDEBAR_PAGES, tags: true });
  assert.deepEqual(st.exportMethods, { ...DEFAULT_EXPORT_METHODS, zotero: false });
  const saved = persisted("linxiv-ui");
  assert.equal(saved.version, 8);
  assert.equal(saved.state.hideSingleAuthors, true);
  assert.equal(saved.state.sidebarPages.tags, true);
});
