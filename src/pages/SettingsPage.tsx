import { useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSettings, updateSettings, updateEnv } from "../api/settings";
import {
  isCliInstalled,
  installCli,
  uninstallCli,
  listMcpClients,
  installMcp,
  uninstallMcp,
  type MpcClientStatus,
} from "../api/integrations";
import { listTrash, restorePaper, hardDeletePaper, type TrashedPaper } from "../api/trash";
import { useThemeStore } from "../stores/theme";
import { PRESETS } from "../lib/theme";
import type { PresetName, ThemeColors } from "../lib/theme";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";

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

function useDebounce(fn: (...args: unknown[]) => void, delay: number) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (...args: unknown[]) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  };
}

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
  onChangeDebounced: (key: keyof ThemeColors, value: string) => void;
}) {
  const [localVal, setLocalVal] = useState(currentValue);
  const setOverride = useThemeStore((s) => s.setOverride);

  function handleChange(val: string) {
    setLocalVal(val);
    setOverride(colorKey, val);
    onChangeDebounced(colorKey, val);
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

function TrashSection() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["trash"],
    queryFn: listTrash,
    staleTime: 0,
  });

  const papers = data?.papers ?? [];

  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleRestore(sourceId: string) {
    setRestoringId(sourceId);
    try {
      await restorePaper(sourceId);
      await qc.invalidateQueries({ queryKey: ["trash"] });
      await qc.invalidateQueries({ queryKey: ["papers"] });
    } catch (e) {
      console.error(e);
    } finally {
      setRestoringId(null);
    }
  }

  async function handleDelete(sourceId: string) {
    setDeletingId(sourceId);
    try {
      await hardDeletePaper(sourceId);
      await qc.invalidateQueries({ queryKey: ["trash"] });
      await qc.invalidateQueries({ queryKey: ["papers"] });
    } catch (e) {
      console.error(e);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Section title="Trash">
      <p className="text-xs text-muted mb-4">
        Papers you've deleted. Restore to bring them back, or delete forever to remove permanently.
      </p>
      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Spinner size={14} /> Loading…
        </div>
      ) : papers.length === 0 ? (
        <p className="text-sm text-muted py-2">Trash is empty</p>
      ) : (
        <>
          <p className="text-xs text-muted mb-2">
            {papers.length} {papers.length === 1 ? "item" : "items"}
          </p>
          {papers.map((paper) => (
            <TrashRow
              key={paper.source_id}
              paper={paper}
              onRestore={() => handleRestore(paper.source_id)}
              onDelete={() => handleDelete(paper.source_id)}
              restoring={restoringId === paper.source_id}
              deleting={deletingId === paper.source_id}
            />
          ))}
        </>
      )}
    </Section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { preset, overrides, setPreset } = useThemeStore();

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

  // Debounced save for color overrides
  const debouncedSaveOverride = useDebounce((key: unknown, value: unknown) => {
    updateSettings({ theme_overrides: { [key as string]: value as string } }).catch(console.error);
  }, 800);

  function handlePresetClick(name: PresetName) {
    setPreset(name);
    updateSettings({ theme_overrides: { preset: name } }).catch(console.error);
  }

  // Current color values: preset colors merged with store overrides
  function resolvedColor(key: keyof ThemeColors): string {
    return (overrides[key] as string | undefined) ?? PRESETS[preset][key];
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
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-bg)]"
                    : "bg-panel text-muted border-border hover:text-text hover:border-[var(--color-accent)]",
                ].join(" ")}
              >
                {name}
              </button>
            ))}
          </div>

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
                  key={key}
                  label={label}
                  colorKey={key}
                  currentValue={resolvedColor(key)}
                  onChangeDebounced={(k, v) => debouncedSaveOverride(k, v)}
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
