import { useState, useRef, useEffect } from "react";
import { useThemeStore } from "../../stores/theme";
import { PRESETS } from "../../lib/theme";
import type { PresetName, ThemeColors, ThemeMode } from "../../lib/theme";
import { updateSettings } from "../../api/settings";
import { Input } from "../ui/input";
import { Section } from "./Section";

const PRESET_NAMES: PresetName[] = ["Navy", "Slate", "Charcoal", "Forest", "Ember", "Cupertino"];

const COLOR_OVERRIDE_KEYS: { key: keyof ThemeColors; label: string }[] = [
  { key: "accent",  label: "Accent"     },
  { key: "bg",      label: "Background" },
  { key: "panel",   label: "Panel"      },
  { key: "border",  label: "Border"     },
  { key: "text",    label: "Text"       },
  { key: "muted",   label: "Muted"      },
];

const VALID_HEX = /^#[0-9a-fA-F]{6}$/;

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
  const colorInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalVal(currentValue);
  }, [currentValue]);

  function handleChange(val: string) {
    setLocalVal(val);
    if (VALID_HEX.test(val)) {
      setOverride(colorKey, val);
      onChangeDebounced();
    }
  }

  const swatchColor = VALID_HEX.test(localVal) ? localVal : currentValue;
  const isInvalid = localVal !== "" && !VALID_HEX.test(localVal);

  return (
    <div className="flex items-center gap-3 mb-3">
      <span
        className="text-sm text-muted font-medium"
        style={{ width: "7rem", flexShrink: 0 }}
      >
        {label}
      </span>
      <span className="relative inline-flex flex-shrink-0">
        <button
          type="button"
          aria-label={`Choose ${label} color`}
          className="rounded-full border border-border cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          style={{ width: 20, height: 20, background: swatchColor, padding: 0 }}
          onClick={() => colorInputRef.current?.click()}
        />
        <input
          ref={colorInputRef}
          type="color"
          value={swatchColor}
          onChange={(e) => handleChange(e.target.value)}
          className="opacity-0 absolute w-0 h-0 pointer-events-none"
          tabIndex={-1}
        />
      </span>
      <Input
        type="text"
        value={localVal}
        onChange={(e) => handleChange(e.target.value)}
        style={{ width: 90, flexShrink: 0 }}
        spellCheck={false}
        aria-invalid={isInvalid}
        className={isInvalid ? "border-[var(--color-danger)]" : ""}
      />
    </div>
  );
}

export function AppearanceSection() {
  const { preset, mode, overrides, glassEffects, setPreset, setMode, setGlassEffects } =
    useThemeStore();
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

  function resolvedColor(key: keyof ThemeColors): string {
    return (overrides[key] as string | undefined) ?? PRESETS[preset][mode][key];
  }

  return (
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
  );
}
