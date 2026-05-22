import { useUiStore, type ExportFormatKey } from "../../stores/ui";
import { Section } from "./Section";

const EXPORT_FORMAT_OPTIONS: { key: ExportFormatKey; label: string; description: string }[] = [
  { key: "lxproj",   label: ".lxproj",  description: "linXiv project archive (papers + metadata + PDFs)" },
  { key: "bibtex",   label: "BibTeX",   description: "Standard .bib citation export" },
  { key: "obsidian", label: "Obsidian", description: "Markdown notes for Obsidian vault" },
];

export function ExportSection() {
  const exportMethods = useUiStore((s) => s.exportMethods);
  const setExportMethod = useUiStore((s) => s.setExportMethod);

  return (
    <Section title="Export Methods">
      <p className="text-xs text-muted mb-4">
        Choose which export formats appear in the project export dialog.
      </p>
      {EXPORT_FORMAT_OPTIONS.map(({ key, label, description }) => (
        <div
          key={key}
          className="flex items-center justify-between py-3 border-b border-border last:border-0"
        >
          <div className="flex-1 min-w-0 mr-4">
            <span className="text-sm font-medium text-text">{label}</span>
            <p id={`export-desc-${key}`} className="text-xs text-muted mt-0.5">{description}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={exportMethods[key]}
            aria-label={`${label} export`}
            aria-describedby={`export-desc-${key}`}
            onClick={() => setExportMethod(key, !exportMethods[key])}
            className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors"
            style={{
              background: exportMethods[key] ? "var(--color-accent)" : "var(--color-border)",
            }}
          >
            {/* translateX: track(44) - 2×border(4) - knob(20) = 20px; update if size classes change */}
            <span
              className="pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
              style={{ transform: exportMethods[key] ? "translateX(20px)" : "translateX(0)" }}
            />
          </button>
        </div>
      ))}
    </Section>
  );
}
