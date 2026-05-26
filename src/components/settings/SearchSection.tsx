import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSettings, updateSettings } from "../../api/settings";
import { Input } from "../ui/input";
import { Section } from "./Section";

export function SearchSection({ defaultOpen = true }: { defaultOpen?: boolean } = {}) {
  const { data: settings } = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
  });

  const rawSettings = settings as Record<string, unknown> | undefined;
  const historyEnabled = rawSettings?.search_history_enabled !== false;
  const historyMax =
    typeof rawSettings?.search_history_max === "number" ? rawSettings.search_history_max : 200;

  const [maxInput, setMaxInput] = useState("200");
  const [populated, setPopulated] = useState(false);
  if (settings && !populated) {
    setMaxInput(String(historyMax));
    setPopulated(true);
  }

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
    <Section title="Search" defaultOpen={defaultOpen}>
      <div className="flex items-center justify-between py-3 border-b border-border">
        <div>
          <span className="text-sm font-medium text-text">Search history</span>
          <p className="text-xs text-muted mt-0.5">Save clause terms for autocomplete suggestions</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={historyEnabled}
          aria-label="Search history"
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
      <div
        className="flex items-center justify-between py-3"
        style={{ opacity: historyEnabled ? 1 : 0.4 }}
      >
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
