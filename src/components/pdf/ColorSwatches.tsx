import { HIGHLIGHT_COLORS } from "../../lib/pdfAnchor";
import { VALID_HEX } from "../../lib/theme";
import { useUiStore } from "../../stores/ui";

// Highlight color row shared by the reader popup and the Annotations tab:
// default palette plus the user's labelled colors, then a free color picker.
export function ColorSwatches({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  const colorLabels = useUiStore((s) => s.colorLabels);
  const names = new Map<string, string>();
  for (const l of colorLabels) if (l.name.trim()) names.set(l.color.toLowerCase(), l.name);
  const quick = [...new Set([...HIGHLIGHT_COLORS, ...names.keys()])];
  const current = value.toLowerCase();
  const currentName = names.get(current);
  return (
    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
      {quick.map((c) => {
        const name = names.get(c);
        return (
          <button
            key={c}
            type="button"
            title={name ?? c}
            aria-label={`Highlight color ${name ?? c}`}
            aria-pressed={c === current}
            onClick={() => onChange(c)}
            className={`w-4 h-4 rounded-full border border-black/20 transition-transform hover:scale-110 ${
              c === current ? "ring-2 ring-accent ring-offset-1" : ""
            }`}
            style={{ backgroundColor: c }}
          />
        );
      })}
      <input
        type="color"
        title="Custom color"
        aria-label="Custom highlight color"
        value={VALID_HEX.test(value) ? current : "#000000"}
        onChange={(e) => onChange(e.target.value)}
        className="w-5 h-5 cursor-pointer rounded border-0 bg-transparent p-0"
      />
      {currentName && (
        <span className="text-[11px] text-muted truncate max-w-[8rem]">{currentName}</span>
      )}
    </div>
  );
}
