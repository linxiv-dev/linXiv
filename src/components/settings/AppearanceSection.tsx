import { useId, useState, useRef, useEffect } from "react";
import { useThemeStore } from "../../stores/theme";
import { PRESETS, VALID_HEX } from "../../lib/theme";
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

// Default tint color seeded into the picker when user first clicks the empty tint swatch.
const DEFAULT_TINT = "#7fb3f0";

interface HexColorInputProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** When true, clicking the swatch with no color seeds DEFAULT_TINT immediately. */
  seedOnEmpty?: boolean;
}

function HexColorInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  seedOnEmpty = false,
}: HexColorInputProps) {
  const errorId = useId();
  const [local, setLocal] = useState(value);
  const pickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Guard prevents clobbering a partially typed value if the parent re-renders
    // with the same external value.
    setLocal((prev) => (prev !== value ? value : prev));
  }, [value]);

  function handleText(val: string) {
    setLocal(val);
    if (val === "" || VALID_HEX.test(val)) {
      onChange(val);
    }
  }

  function handlePicker(val: string) {
    setLocal(val);
    onChange(val);
  }

  const hasSwatch = VALID_HEX.test(local);
  const swatchColor = hasSwatch ? local : "#888888";
  const isInvalid = local !== "" && !VALID_HEX.test(local);

  function openPicker() {
    const picker = pickerRef.current;
    if (!picker) return;
    if (seedOnEmpty && !hasSwatch) {
      // Set DOM value imperatively before click so the OS picker opens with the
      // seeded color, not the gray fallback from the previous render cycle.
      picker.value = DEFAULT_TINT;
      setLocal(DEFAULT_TINT);
      onChange(DEFAULT_TINT);
    }
    picker.click();
  }

  return (
    <div className="flex items-center gap-2">
      <span className="relative inline-flex flex-shrink-0">
        <button
          type="button"
          aria-label={ariaLabel ?? "Choose color"}
          className="rounded-full border border-border cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          style={{
            width: 20,
            height: 20,
            background: hasSwatch ? swatchColor : "transparent",
            padding: 0,
          }}
          onClick={openPicker}
        />
        <input
          ref={pickerRef}
          type="color"
          value={swatchColor}
          onChange={(e) => handlePicker(e.target.value)}
          aria-hidden="true"
          className="opacity-0 absolute w-0 h-0 pointer-events-none"
          tabIndex={-1}
        />
      </span>
      <Input
        type="text"
        value={local}
        placeholder={placeholder}
        onChange={(e) => handleText(e.target.value)}
        style={{ width: 90, flexShrink: 0 }}
        spellCheck={false}
        aria-invalid={isInvalid}
        aria-describedby={isInvalid ? errorId : undefined}
        className={isInvalid ? "border-[var(--color-danger)]" : ""}
      />
      {isInvalid && (
        <span id={errorId} className="sr-only">
          Enter a 6-character hex color like #ff0000
        </span>
      )}
    </div>
  );
}

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
  const setOverride = useThemeStore((s) => s.setOverride);
  const removeOverride = useThemeStore((s) => s.removeOverride);

  function handleChange(val: string) {
    if (val === "") {
      removeOverride(colorKey);
      onChangeDebounced();
    } else if (VALID_HEX.test(val)) {
      setOverride(colorKey, val);
      onChangeDebounced();
    }
  }

  return (
    <div className="flex items-center gap-3 mb-3">
      <span
        className="text-sm text-muted font-medium"
        style={{ width: "7rem", flexShrink: 0 }}
      >
        {label}
      </span>
      <HexColorInput
        value={currentValue}
        onChange={handleChange}
        ariaLabel={`Choose ${label} color`}
      />
    </div>
  );
}

// Self-subscribed so slider drags only re-render this component.
function GlassControls() {
  const {
    glassIntensity, glassTintColor, glassTintAlpha,
    setGlassIntensity, setGlassTintColor, setGlassTintAlpha,
  } = useThemeStore();

  const hasTint = VALID_HEX.test(glassTintColor);

  return (
    <div className="py-2 mb-2 border-t border-border">
      <span className="text-sm text-text font-medium">Glass effects</span>
      <p className="text-xs text-muted mt-0.5 mb-3">
        Blur and vibrancy on panels (Cupertino only). Tint applies even at 0% blur.
      </p>

      <div className="flex items-center gap-3 mb-3">
        <span
          className="text-sm text-muted font-medium"
          style={{ width: "7rem", flexShrink: 0 }}
        >
          Blur intensity
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={glassIntensity}
          onChange={(e) => setGlassIntensity(Number(e.target.value))}
          className="flex-1"
          style={{ accentColor: "var(--color-accent)" }}
        />
        <span
          className="text-sm text-muted tabular-nums"
          style={{ width: "2.5rem", textAlign: "right", flexShrink: 0 }}
        >
          {glassIntensity}%
        </span>
      </div>

      <div className="flex items-center gap-3 mb-2">
        <span
          className="text-sm text-muted font-medium"
          style={{ width: "7rem", flexShrink: 0 }}
        >
          Tint color
        </span>
        <HexColorInput
          value={glassTintColor}
          onChange={setGlassTintColor}
          placeholder="none"
          ariaLabel="Choose glass tint color"
          seedOnEmpty
        />
      </div>

      {hasTint && (
        <div className="flex items-center gap-3">
          <span
            className="text-sm text-muted font-medium"
            style={{ width: "7rem", flexShrink: 0 }}
          >
            Tint opacity
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={glassTintAlpha}
            onChange={(e) => setGlassTintAlpha(Number(e.target.value))}
            className="flex-1"
            style={{ accentColor: "var(--color-accent)" }}
          />
          <span
            className="text-sm text-muted tabular-nums"
            style={{ width: "2.5rem", textAlign: "right", flexShrink: 0 }}
          >
            {glassTintAlpha}%
          </span>
        </div>
      )}
    </div>
  );
}

export function AppearanceSection() {
  const preset     = useThemeStore((s) => s.preset);
  const mode       = useThemeStore((s) => s.mode);
  const overrides  = useThemeStore((s) => s.overrides);
  const setPreset  = useThemeStore((s) => s.setPreset);
  const setMode    = useThemeStore((s) => s.setMode);
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

      {preset === "Cupertino" && <GlassControls />}

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
