import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings, updateEnv } from "../api/settings";
import { useUiStore, type SidebarPageKey } from "../stores/ui";
import {
  isCliInstalled,
  installCli,
  uninstallCli,
  listMcpClients,
  installMcp,
  uninstallMcp,
  type MpcClientStatus,
} from "../api/integrations";
import { listTrash, restorePaper, hardDeletePaper, restoreProject, hardDeleteProject, type TrashedPaper, type TrashedProject } from "../api/trash";
import { removeFromAllProjects } from "../api/papers";
import { useThemeStore } from "../stores/theme";
import { PRESETS } from "../lib/theme";
import type { PresetName, ThemeColors, ThemeMode } from "../lib/theme";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { Dialog } from "../components/ui/dialog";

// ── Helpers ───────────────────────────────────────────────────────────────────

const PRESET_NAMES: PresetName[] = ["Navy", "Slate", "Charcoal", "Forest", "Ember", "Cupertino"];

const COLOR_OVERRIDE_KEYS: { key: keyof ThemeColors; label: string }[] = [
  { key: "accent",  label: "Accent"     },
  { key: "bg",      label: "Background" },
  { key: "panel",   label: "Panel"      },
  { key: "border",  label: "Border"     },
  { key: "text",    label: "Text"       },
  { key: "muted",   label: "Muted"      },
];

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-panel rounded-lg border border-border p-6 mb-4">
      <h2 className="text-text font-semibold mb-4">{title}</h2>
      {children}
    </div>
  );
}

// ── Password field with show/hide toggle ──────────────────────────────────────

function PasswordField({
  label,
  value,
  onChange,
  onSave,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
}) {
  const [show, setShow] = useState(false);

  return (
    <div className="flex flex-col gap-1 mb-4">
      <label className="text-sm text-muted font-medium">{label}</label>
      <div className="flex gap-2 items-center">
        <div className="relative flex-1">
          <Input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="pr-16"
          />
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-text transition-colors"
            onClick={() => setShow((s) => !s)}
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>
        <Button size="sm" onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  );
}

// ── Color override row ────────────────────────────────────────────────────────

function ColorRow({
  label,
  colorKey,
  currentValue,
  onChangeDebounced,
}: {
  label: string;
  colorKey: keyof ThemeColors;
  currentValue: string;
  onChangeDebounced: () => void;
}) {
  const [localVal, setLocalVal] = useState(currentValue);
  const setOverride = useThemeStore((s) => s.setOverride);

  function handleChange(val: string) {
    setLocalVal(val);
    setOverride(colorKey, val);
    onChangeDebounced();
  }

  return (
    <div className="flex items-center gap-3 mb-3">
      <span
        className="text-sm text-muted font-medium"
        style={{ width: "7rem", flexShrink: 0 }}
      >
        {label}
      </span>
      <span
        className="rounded-full border border-border cursor-pointer flex-shrink-0"
        style={{
          width: 20,
          height: 20,
          background: localVal,
          display: "inline-block",
        }}
        onClick={() =>
          (document.getElementById(`color-input-${colorKey}`) as HTMLInputElement | null)?.click()
        }
      />
      <input
        id={`color-input-${colorKey}`}
        type="color"
        value={localVal}
        onChange={(e) => handleChange(e.target.value)}
        className="opacity-0 absolute w-0 h-0 pointer-events-none"
        tabIndex={-1}
      />
      <Input
        type="text"
        value={localVal}
        onChange={(e) => handleChange(e.target.value)}
        style={{ width: 90, flexShrink: 0 }}
        spellCheck={false}
      />
    </div>
  );
}

// ── Sidebar section ───────────────────────────────────────────────────────────

const SIDEBAR_PAGE_OPTIONS: { key: SidebarPageKey; label: string; description: string }[] = [
  { key: "graph",  label: "Graph",      description: "Citation graph explorer" },
  { key: "search", label: "Search",     description: "arXiv / OpenAlex search" },
  { key: "doi",    label: "DOI Lookup", description: "Resolve papers by DOI" },
  { key: "tags",   label: "Tags",       description: "Tag browser (coming soon)" },
  { key: "notes",  label: "Notes",      description: "Notes editor (coming soon)" },
];

function SidebarSection() {
  const { sidebarPages, setSidebarPage } = useUiStore();

  return (
    <Section title="Sidebar">
      <p className="text-xs text-muted mb-4">
        Choose which pages appear in the sidebar navigation.
      </p>
      {SIDEBAR_PAGE_OPTIONS.map(({ key, label, description }) => (
        <div
          key={key}
          className="flex items-center justify-between py-3 border-b border-border last:border-0"
        >
          <div className="flex-1 min-w-0 mr-4">
            <span className="text-sm font-medium text-text">{label}</span>
            <p className="text-xs text-muted mt-0.5">{description}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={sidebarPages[key]}
            onClick={() => setSidebarPage(key, !sidebarPages[key])}
            className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors"
            style={{
              background: sidebarPages[key] ? "var(--color-accent)" : "var(--color-border)",
            }}
          >
            <span
              className="pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
              style={{ transform: sidebarPages[key] ? "translateX(20px)" : "translateX(0)" }}
            />
          </button>
        </div>
      ))}
    </Section>
  );
}

// ── Integrations section ──────────────────────────────────────────────────────

function IntegrationRow({
  label,
  description,
  installed,
  available = true,
  loading,
  onInstall,
  onUninstall,
}: {
  label: string;
  description: string;
  installed: boolean;
  available?: boolean;
  loading: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between py-3 border-b border-border last:border-0"
      style={{ opacity: available ? 1 : 0.45 }}
    >
      <div className="flex-1 min-w-0 mr-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">{label}</span>
          {installed && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{
                background: "color-mix(in srgb, var(--color-success) 15%, transparent)",
                color: "var(--color-success)",
              }}
            >
              installed
            </span>
          )}
          {!available && (
            <span className="text-xs text-muted">(not detected)</span>
          )}
        </div>
        <p className="text-xs text-muted mt-0.5">{description}</p>
      </div>
      <div className="flex-shrink-0">
        {loading ? (
          <Spinner size={16} />
        ) : installed ? (
          <Button variant="danger" size="sm" onClick={onUninstall}>
            Uninstall
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={onInstall} disabled={!available}>
            Install
          </Button>
        )}
      </div>
    </div>
  );
}

function IntegrationsSection() {
  const qc = useQueryClient();

  const { data: cliInstalled = false, isLoading: cliLoading } = useQuery({
    queryKey: ["cli_installed"],
    queryFn: isCliInstalled,
    staleTime: 10_000,
  });

  const { data: mcpClients = [], isLoading: mcpLoading } = useQuery({
    queryKey: ["mcp_clients"],
    queryFn: listMcpClients,
    staleTime: 10_000,
  });

  const [cliPending, setCliPending] = useState(false);
  const [mcpPending, setMcpPending] = useState<string | null>(null);

  async function handleCli(action: "install" | "uninstall") {
    setCliPending(true);
    try {
      if (action === "install") await installCli();
      else await uninstallCli();
      await qc.invalidateQueries({ queryKey: ["cli_installed"] });
    } catch (e) {
      console.error(e);
    } finally {
      setCliPending(false);
    }
  }

  async function handleMcp(clientId: string, action: "install" | "uninstall") {
    setMcpPending(clientId);
    try {
      if (action === "install") await installMcp(clientId);
      else await uninstallMcp(clientId);
      await qc.invalidateQueries({ queryKey: ["mcp_clients"] });
    } catch (e) {
      console.error(e);
    } finally {
      setMcpPending(null);
    }
  }

  return (
    <Section title="Integrations">
      <p className="text-xs text-muted mb-4">
        Install linXiv tools so other apps can use them outside the GUI.
      </p>

      {/* CLI */}
      <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-1">
        Command Line
      </p>
      <IntegrationRow
        label="linxiv CLI"
        description="Adds the `linxiv` command to your terminal PATH."
        installed={cliInstalled}
        available={true}
        loading={cliLoading || cliPending}
        onInstall={() => handleCli("install")}
        onUninstall={() => handleCli("uninstall")}
      />

      {/* MCP */}
      <p className="text-xs font-semibold text-muted uppercase tracking-wide mt-4 mb-1">
        MCP Clients
      </p>
      {mcpLoading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Spinner size={14} /> Detecting clients…
        </div>
      ) : (
        mcpClients.map((client: MpcClientStatus) => (
          <IntegrationRow
            key={client.id}
            label={client.name}
            description={
              client.id === "claude"
                ? "Registers linXiv as an MCP server in Claude Desktop."
                : client.id === "cursor"
                ? "Registers linXiv as an MCP server in Cursor."
                : "Registers linXiv as an MCP server in Windsurf."
            }
            installed={client.installed}
            available={client.available}
            loading={mcpPending === client.id}
            onInstall={() => handleMcp(client.id, "install")}
            onUninstall={() => handleMcp(client.id, "uninstall")}
          />
        ))
      )}
    </Section>
  );
}

// ── Trash section ─────────────────────────────────────────────────────────────

type ProjectPrompt = {
  paperTitle: string;
  sourceFk: number;
  projectFks: number[];
};

function KeepInProjectsDialog({
  prompt,
  removing,
  removeError,
  onKeep,
  onRemove,
}: {
  prompt: ProjectPrompt | null;
  removing: boolean;
  removeError: string | null;
  onKeep: () => void;
  onRemove: () => void;
}) {
  const count = prompt?.projectFks.length ?? 0;
  return (
    <Dialog open={prompt !== null} onClose={onKeep} title="Project memberships">
      {prompt && (
        <>
          <p className="text-sm text-text mb-1">
            <span className="font-medium">{prompt.paperTitle}</span> was restored.
          </p>
          <p className="text-sm text-muted mb-4">
            It belonged to {count} project{count !== 1 ? "s" : ""} before deletion.
            Keep those memberships?
          </p>
          {removeError && (
            <p className="text-xs text-danger mb-4">{removeError}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onRemove} disabled={removing}>
              {removing ? <><Spinner size={14} /> Removing…</> : "Remove from all projects"}
            </Button>
            <Button variant="primary" size="sm" onClick={onKeep} disabled={removing}>
              Keep memberships
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function TrashRow({
  paper,
  onRestore,
  onDelete,
  restoring,
  deleting,
}: {
  paper: TrashedPaper;
  onRestore: () => void;
  onDelete: () => void;
  restoring: boolean;
  deleting: boolean;
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const isPending = restoring || deleting;

  function handleDeleteClick() {
    if (confirmId === paper.source_id) {
      setConfirmId(null);
      onDelete();
    } else {
      setConfirmId(paper.source_id);
    }
  }

  const authorLine =
    paper.authors && paper.authors.length > 0
      ? paper.authors.length > 1
        ? `${paper.authors[0]} et al.`
        : paper.authors[0]
      : null;

  return (
    <div className="flex items-center justify-between py-3 border-b border-border last:border-0">
      <div className="flex-1 min-w-0 mr-4">
        <p className="text-sm font-medium text-text truncate">{paper.title}</p>
        {authorLine && (
          <p className="text-xs text-muted mt-0.5">{authorLine}</p>
        )}
      </div>
      <div className="flex-shrink-0 flex gap-2">
        {restoring ? (
          <Spinner size={16} />
        ) : (
          <Button variant="ghost" size="sm" onClick={onRestore} disabled={isPending}>
            Restore
          </Button>
        )}
        {deleting ? (
          <Spinner size={16} />
        ) : (
          <Button
            variant="danger"
            size="sm"
            onClick={handleDeleteClick}
            onMouseDown={(e) => e.preventDefault()}
            onBlur={() => setConfirmId(null)}
            disabled={isPending}
          >
            {confirmId === paper.source_id ? "Confirm?" : "Delete forever"}
          </Button>
        )}
      </div>
    </div>
  );
}

function ProjectTrashRow({ project, onRestore, onDelete, restoring, deleting }: {
  project: TrashedProject;
  onRestore: () => void;
  onDelete: () => void;
  restoring: boolean;
  deleting: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const isPending = restoring || deleting;
  return (
    <div className="flex items-center justify-between py-3 border-b border-border last:border-0">
      <div className="flex-1 min-w-0 mr-4">
        <p className="text-sm font-medium text-text truncate">{project.name}</p>
        <p className="text-xs text-muted mt-0.5">{project.paper_count} paper{project.paper_count !== 1 ? "s" : ""}</p>
      </div>
      <div className="flex-shrink-0 flex gap-2">
        {restoring ? <Spinner size={16} /> : (
          <Button variant="ghost" size="sm" onClick={onRestore} disabled={isPending}>Restore</Button>
        )}
        {deleting ? <Spinner size={16} /> : (
          <Button variant="danger" size="sm"
            onClick={() => confirm ? onDelete() : setConfirm(true)}
            onMouseDown={(e) => e.preventDefault()}
            onBlur={() => setConfirm(false)} disabled={isPending}>
            {confirm ? "Confirm?" : "Delete forever"}
          </Button>
        )}
      </div>
    </div>
  );
}

function TrashSection() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["trash"],
    queryFn: listTrash,
    staleTime: 0,
  });

  const papers = data?.papers ?? [];
  const projects = data?.projects ?? [];
  const total = papers.length + projects.length;

  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringProjectId, setRestoringProjectId] = useState<number | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<number | null>(null);
  const [projectPrompt, setProjectPrompt] = useState<ProjectPrompt | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function closeProjectPrompt() {
    if (removing) return;
    setRemoveError(null);
    setProjectPrompt(null);
  }

  async function handleRestore(paper: TrashedPaper) {
    if (removing) return;
    setRestoringId(paper.source_id);
    setActionError(null);
    try {
      const result = await restorePaper(paper.source_id);
      await qc.invalidateQueries({ queryKey: ["trash"] });
      await qc.invalidateQueries({ queryKey: ["papers"] });
      const projectFks = result.project_fks ?? [];
      if (projectFks.length > 0) {
        setProjectPrompt({
          paperTitle: paper.title,
          sourceFk: paper.source_fk,
          projectFks,
        });
      }
    } catch (e) {
      console.error(e);
      setActionError(`Could not restore "${paper.title}". Please try again.`);
    } finally {
      setRestoringId(null);
    }
  }

  async function handleRemoveFromProjects() {
    if (!projectPrompt) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeFromAllProjects(projectPrompt.sourceFk);
      await qc.invalidateQueries({ queryKey: ["projects"] });
      await qc.invalidateQueries({ queryKey: ["papers"] });
      setProjectPrompt(null);
    } catch (e) {
      console.error(e);
      setRemoveError("Failed to remove from projects. Please try again.");
    } finally {
      setRemoving(false);
    }
  }

  async function handleDelete(sourceId: string) {
    setDeletingId(sourceId);
    setActionError(null);
    try {
      await hardDeletePaper(sourceId);
      await qc.invalidateQueries({ queryKey: ["trash"] });
      await qc.invalidateQueries({ queryKey: ["papers"] });
    } catch (e) {
      console.error(e);
      setActionError("Could not permanently delete the paper. Please try again.");
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRestoreProject(id: number) {
    setRestoringProjectId(id);
    setActionError(null);
    try {
      await restoreProject(id);
      await qc.invalidateQueries({ queryKey: ["trash"] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
    } catch (e) {
      console.error(e);
      setActionError("Could not restore the project. Please try again.");
    } finally {
      setRestoringProjectId(null);
    }
  }

  async function handleDeleteProject(id: number) {
    setDeletingProjectId(id);
    setActionError(null);
    try {
      await hardDeleteProject(id);
      await qc.invalidateQueries({ queryKey: ["trash"] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
    } catch (e) {
      console.error(e);
      setActionError("Could not permanently delete the project. Please try again.");
    } finally {
      setDeletingProjectId(null);
    }
  }

  return (
    <>
      <KeepInProjectsDialog
        prompt={projectPrompt}
        removing={removing}
        removeError={removeError}
        onKeep={closeProjectPrompt}
        onRemove={handleRemoveFromProjects}
      />
      <Section title="Trash">
        <p className="text-xs text-muted mb-4">
          Deleted items are kept for 30 days, then permanently removed.
        </p>
        {actionError && (
          <p className="text-xs text-danger mb-3">{actionError}</p>
        )}
        {isLoading ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted">
            <Spinner size={14} /> Loading…
          </div>
        ) : total === 0 ? (
          <p className="text-sm text-muted py-2">Trash is empty</p>
        ) : (
          <>
            {projects.length > 0 && (
              <>
                <p className="text-xs font-semibold text-muted mb-1 mt-2">Projects</p>
                {projects.map((p) => (
                  <ProjectTrashRow
                    key={p.id}
                    project={p}
                    onRestore={() => handleRestoreProject(p.id)}
                    onDelete={() => handleDeleteProject(p.id)}
                    restoring={restoringProjectId === p.id}
                    deleting={deletingProjectId === p.id}
                  />
                ))}
              </>
            )}
            {papers.length > 0 && (
              <>
                <p className="text-xs font-semibold text-muted mb-1 mt-2">Papers</p>
                {papers.map((paper) => (
                  <TrashRow
                    key={paper.source_id}
                    paper={paper}
                    onRestore={() => handleRestore(paper)}
                    onDelete={() => handleDelete(paper.source_id)}
                    restoring={restoringId === paper.source_id}
                    deleting={deletingId === paper.source_id}
                  />
                ))}
              </>
            )}
          </>
        )}
      </Section>
    </>
  );
}

// ── Search section ────────────────────────────────────────────────────────────

function SearchSection({ settings }: { settings: Record<string, unknown> | undefined }) {
  const historyEnabled = settings?.search_history_enabled !== false;
  const historyMax = typeof settings?.search_history_max === "number"
    ? settings.search_history_max
    : 200;
  const [maxInput, setMaxInput] = useState(String(historyMax));

  function handleToggle() {
    updateSettings({ search_history_enabled: !historyEnabled }).catch(console.error);
  }

  function handleMaxBlur() {
    const n = parseInt(maxInput, 10);
    if (!isNaN(n) && n > 0) {
      updateSettings({ search_history_max: n }).catch(console.error);
    } else {
      setMaxInput(String(historyMax));
    }
  }

  return (
    <Section title="Search">
      <div className="flex items-center justify-between py-3 border-b border-border">
        <div>
          <span className="text-sm font-medium text-text">Search history</span>
          <p className="text-xs text-muted mt-0.5">Save clause terms for autocomplete suggestions</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={historyEnabled}
          onClick={handleToggle}
          className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors"
          style={{ background: historyEnabled ? "var(--color-accent)" : "var(--color-border)" }}
        >
          <span
            className="pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
            style={{ transform: historyEnabled ? "translateX(20px)" : "translateX(0)" }}
          />
        </button>
      </div>
      <div className="flex items-center justify-between py-3" style={{ opacity: historyEnabled ? 1 : 0.4 }}>
        <div>
          <span className="text-sm font-medium text-text">Max history entries</span>
          <p className="text-xs text-muted mt-0.5">Oldest terms are pruned when the limit is reached</p>
        </div>
        <Input
          type="number"
          min={1}
          max={10000}
          value={maxInput}
          onChange={(e) => setMaxInput(e.target.value)}
          onBlur={handleMaxBlur}
          disabled={!historyEnabled}
          className="w-24 text-right"
        />
      </div>
    </Section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { preset, mode, overrides, glassEffects, setPreset, setMode, setGlassEffects } = useThemeStore();

  // Remote settings
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
  });

  // API key state
  const [geminiKey, setGeminiKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");

  // Storage state
  const [pdfLimit, setPdfLimit] = useState<string>("");

  // CrossRef state
  const [crossrefEmail, setCrossrefEmail] = useState("");

  // Populate from remote settings once loaded
  const [populated, setPopulated] = useState(false);
  if (settings && !populated) {
    if (typeof settings.pdf_save_limit_mb === "number") {
      setPdfLimit(String(settings.pdf_save_limit_mb));
    }
    if (typeof (settings as Record<string, unknown>)["CROSSREF_MAILTO"] === "string") {
      setCrossrefEmail((settings as Record<string, unknown>)["CROSSREF_MAILTO"] as string);
    }
    setPopulated(true);
  }

  // Collapsed state for overrides
  const [overridesOpen, setOverridesOpen] = useState(false);

  // Reads overrides at fire time (not capture time) so rapid multi-key edits
  // each flush the full object rather than stomping previous keys.
  const saveOverridesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (saveOverridesTimer.current) clearTimeout(saveOverridesTimer.current);
  }, []);
  function scheduleSaveOverrides() {
    if (saveOverridesTimer.current) clearTimeout(saveOverridesTimer.current);
    saveOverridesTimer.current = setTimeout(() => {
      const { overrides } = useThemeStore.getState();
      updateSettings({ theme_overrides: overrides as Record<string, string> }).catch(console.error);
    }, 800);
  }

  function handlePresetClick(name: PresetName) {
    if (saveOverridesTimer.current) clearTimeout(saveOverridesTimer.current);
    setPreset(name);
    updateSettings({ theme_overrides: {} }).catch(console.error);
  }

  // Current color values: preset+mode colors merged with store overrides
  function resolvedColor(key: keyof ThemeColors): string {
    return (overrides[key] as string | undefined) ?? PRESETS[preset][mode][key];
  }

  return (
    <div
      className="overflow-y-auto h-full"
      style={{ background: "var(--color-bg)" }}
    >
      <div className="mx-auto py-8 px-8" style={{ maxWidth: 800 }}>
        <h1 className="text-xl font-bold text-text mb-6">Settings</h1>

        {/* ── Appearance ─────────────────────────────────────────────────── */}
        <Section title="Appearance">
          <p className="text-sm text-muted mb-3">Theme</p>
          <div className="flex flex-wrap gap-2 mb-4">
            {PRESET_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => handlePresetClick(name)}
                className={[
                  "rounded-full px-4 py-2 border font-medium text-sm cursor-pointer transition-colors",
                  preset === name
                    ? "border-accent bg-accent text-white"
                    : "bg-panel text-muted border-border hover:text-text hover:border-accent",
                ].join(" ")}
              >
                {name}
              </button>
            ))}
          </div>

          {/* Dark / Light mode toggle */}
          <div className="flex items-center gap-2 mb-4">
            {(["dark", "light"] as ThemeMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={[
                  "px-3 py-1.5 rounded-md border text-sm font-medium transition-colors capitalize",
                  mode === m
                    ? "bg-accent border-accent text-white"
                    : "bg-panel border-border text-muted hover:text-text",
                ].join(" ")}
              >
                {m === "dark" ? "🌙 Dark" : "☀️ Light"}
              </button>
            ))}
          </div>

          {/* Glass effects toggle — only meaningful for Cupertino */}
          {preset === "Cupertino" && (
            <div className="flex items-center justify-between py-2 mb-2 border-t border-border">
              <div>
                <span className="text-sm text-text font-medium">Glass effects</span>
                <p className="text-xs text-muted mt-0.5">Blur and vibrancy on panels (Cupertino only)</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={glassEffects}
                onClick={() => setGlassEffects(!glassEffects)}
                className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors"
                style={{
                  background: glassEffects ? "var(--color-accent)" : "var(--color-border)",
                }}
              >
                <span
                  className="pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
                  style={{ transform: glassEffects ? "translateX(20px)" : "translateX(0)" }}
                />
              </button>
            </div>
          )}

          {/* Collapsible color overrides */}
          <button
            type="button"
            className="flex items-center gap-2 text-sm text-muted hover:text-text transition-colors mb-2"
            onClick={() => setOverridesOpen((o) => !o)}
          >
            <span
              className="text-xs"
              style={{
                display: "inline-block",
                transform: overridesOpen ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 150ms",
              }}
            >
              ▶
            </span>
            Color Overrides
          </button>

          {overridesOpen && (
            <div className="mt-2">
              {COLOR_OVERRIDE_KEYS.map(({ key, label }) => (
                <ColorRow
                  key={`${preset}-${mode}-${key}`}
                  label={label}
                  colorKey={key}
                  currentValue={resolvedColor(key)}
                  onChangeDebounced={scheduleSaveOverrides}
                />
              ))}
            </div>
          )}
        </Section>

        <div
          className="border-t border-border mb-4"
          style={{ marginLeft: -8, marginRight: -8 }}
        />

        {/* ── API Keys ───────────────────────────────────────────────────── */}
        <Section title="API Keys">
          <PasswordField
            label="Gemini API Key"
            value={geminiKey}
            onChange={setGeminiKey}
            onSave={() => updateEnv("GEMINI_API_KEY", geminiKey).catch(console.error)}
          />
          <PasswordField
            label="OpenAI API Key"
            value={openaiKey}
            onChange={setOpenaiKey}
            onSave={() => updateEnv("OPENAI_API_KEY", openaiKey).catch(console.error)}
          />
        </Section>

        <div
          className="border-t border-border mb-4"
          style={{ marginLeft: -8, marginRight: -8 }}
        />

        {/* ── Storage ────────────────────────────────────────────────────── */}
        <Section title="Storage">
          <div className="flex flex-col gap-1 mb-2">
            <label className="text-sm text-muted font-medium">
              PDF Storage Limit (MB)
            </label>
            <div className="flex gap-2 items-center">
              <Input
                type="number"
                value={pdfLimit}
                onChange={(e) => setPdfLimit(e.target.value)}
                min={1}
                style={{ width: 120 }}
              />
              <Button
                size="sm"
                onClick={() =>
                  updateSettings({
                    pdf_save_limit_mb: Number(pdfLimit),
                  }).catch(console.error)
                }
              >
                Save
              </Button>
            </div>
          </div>
        </Section>

        <div
          className="border-t border-border mb-4"
          style={{ marginLeft: -8, marginRight: -8 }}
        />

        {/* ── CrossRef ───────────────────────────────────────────────────── */}
        <Section title="CrossRef">
          <div className="flex flex-col gap-1 mb-2">
            <label className="text-sm text-muted font-medium">
              Contact Email
            </label>
            <p className="text-xs text-muted mb-2">
              Used as the{" "}
              <code className="text-accent">mailto</code> parameter for polite
              CrossRef API access.
            </p>
            <div className="flex gap-2 items-center">
              <Input
                type="email"
                value={crossrefEmail}
                onChange={(e) => setCrossrefEmail(e.target.value)}
                placeholder="you@example.com"
                style={{ maxWidth: 320 }}
              />
              <Button
                size="sm"
                onClick={() =>
                  updateEnv("CROSSREF_MAILTO", crossrefEmail).catch(console.error)
                }
              >
                Save
              </Button>
            </div>
          </div>
        </Section>

        <div
          className="border-t border-border mb-4"
          style={{ marginLeft: -8, marginRight: -8 }}
        />

        {/* ── Search ─────────────────────────────────────────────────────── */}
        <SearchSection settings={settings as Record<string, unknown> | undefined} />

        {/* ── Sidebar ────────────────────────────────────────────────────── */}
        <SidebarSection />

        <div
          className="border-t border-border mb-4"
          style={{ marginLeft: -8, marginRight: -8 }}
        />

        {/* ── Integrations ───────────────────────────────────────────────── */}
        <IntegrationsSection />

        <div
          className="border-t border-border mb-4"
          style={{ marginLeft: -8, marginRight: -8 }}
        />

        {/* ── Trash ──────────────────────────────────────────────────────── */}
        <TrashSection />
      </div>
    </div>
  );
}
