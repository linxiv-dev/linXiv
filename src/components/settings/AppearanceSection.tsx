import { useId, useMemo, useState, useRef, useEffect } from "react";
import { useThemeStore } from "../../stores/theme";
import type { CustomPalette } from "../../stores/theme";
import { PRESETS, VALID_HEX } from "../../lib/theme";
import type { PresetName, ThemeColors, ThemeMode, ColorAlphas } from "../../lib/theme";
import { updateSettings } from "../../api/settings";
import { Input } from "../ui/input";
import { Section } from "./Section";

const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];
const BUILT_IN_LOWER = new Set(PRESET_NAMES.map((n) => n.toLowerCase()));

/** Snapshot current (or supplied) overrides + alphas and write them to the backend. */
function persistThemeOverrides(
  overrides?: Partial<ThemeColors>,
  alphas?: ColorAlphas
): void {
  const state = useThemeStore.getState();
  updateSettings({
    theme_overrides: overrides ?? state.overrides,
    theme_override_alphas: alphas ?? state.overrideAlphas,
  }).catch(console.error);
}

const COLOR_OVERRIDE_KEYS: { key: keyof ThemeColors; label: string }[] = [
  { key: "accent",  label: "Accent"     },
  { key: "bg",      label: "Background" },
  { key: "panel",   label: "Panel"      },
  { key: "border",  label: "Border"     },
  { key: "text",    label: "Text"       },
  { key: "muted",   label: "Muted"      },
  { key: "success", label: "Success"    },
  { key: "danger",  label: "Danger"     },
];

interface HexColorInputProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  /** Shown as a dimmed swatch when value is empty, so users can see the current theme color. */
  presetColor?: string;
  ariaLabel?: string;
}

function HexColorInput({
  value,
  onChange,
  placeholder,
  presetColor,
  ariaLabel,
}: HexColorInputProps) {
  const errorId = useId();
  const [local, setLocal] = useState(value);
  const pickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
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
  const hasPreset = !hasSwatch && VALID_HEX.test(presetColor ?? "");
  const swatchColor = hasSwatch ? local : (hasPreset ? presetColor! : "#888888");
  const isInvalid = local !== "" && !VALID_HEX.test(local);

  function openPicker() {
    pickerRef.current?.click();
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
            background: swatchColor,
            padding: 0,
            opacity: hasPreset ? 0.45 : 1,
          }}
          onClick={openPicker}
        />
        <input
          ref={pickerRef}
          type="color"
          value={hasSwatch ? local : (hasPreset ? presetColor! : "#888888")}
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
  scheduleSave,
}: {
  label: string;
  colorKey: keyof ThemeColors;
  scheduleSave: () => void;
}) {
  const setOverride = useThemeStore((s) => s.setOverride);
  const removeOverride = useThemeStore((s) => s.removeOverride);
  const setOverrideAlpha = useThemeStore((s) => s.setOverrideAlpha);
  const overrideHex = useThemeStore((s) => s.overrides[colorKey] as string | undefined);
  const hasOverride = overrideHex !== undefined;
  const alpha = useThemeStore((s) => s.overrideAlphas[colorKey] ?? 100);
  const preset = useThemeStore((s) => s.preset);
  const mode = useThemeStore((s) => s.mode);
  const presetHex = PRESETS[preset][mode][colorKey];

  function handleHexChange(val: string) {
    if (val === "") {
      removeOverride(colorKey);
      scheduleSave();
    } else if (VALID_HEX.test(val)) {
      setOverride(colorKey, val);
      scheduleSave();
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
        value={overrideHex ?? ""}
        presetColor={VALID_HEX.test(presetHex) ? presetHex : undefined}
        onChange={handleHexChange}
        ariaLabel={`Choose ${label} color`}
      />
      <input
        type="range"
        min={0}
        max={100}
        value={alpha}
        disabled={!hasOverride}
        onChange={(e) => { setOverrideAlpha(colorKey, Number(e.target.value)); scheduleSave(); }}
        className="flex-1"
        style={{
          accentColor: "var(--color-accent)",
          opacity: hasOverride ? 1 : 0.35,
          cursor: hasOverride ? "pointer" : "not-allowed",
        }}
        aria-label={`${label} opacity`}
      />
      <span
        className="text-sm text-muted tabular-nums"
        style={{ width: "2.5rem", textAlign: "right", flexShrink: 0 }}
      >
        {hasOverride ? `${alpha}%` : "—"}
      </span>
    </div>
  );
}

function GlassControls() {
  const glassIntensity = useThemeStore((s) => s.glassIntensity);
  const glassTintColor = useThemeStore((s) => s.glassTintColor);
  const glassTintAlpha = useThemeStore((s) => s.glassTintAlpha);
  const setGlassIntensity = useThemeStore((s) => s.setGlassIntensity);
  const setGlassTintColor = useThemeStore((s) => s.setGlassTintColor);
  const setGlassTintAlpha = useThemeStore((s) => s.setGlassTintAlpha);

  const hasTint = VALID_HEX.test(glassTintColor);

  return (
    <div className="py-2 mb-2 border-t border-border">
      <span className="text-sm text-text font-medium">Glass effects</span>
      <p className="text-xs text-muted mt-0.5 mb-3">
        Blur and vibrancy on panels. Tint applies even at 0% blur.
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

function PresetDots({ preset, mode }: { preset: PresetName; mode: ThemeMode }) {
  const colors = PRESETS[preset][mode];
  return (
    <span className="flex gap-0.5 items-center flex-shrink-0">
      {(["bg", "accent", "text"] as const).map((k) => (
        <span
          key={k}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: colors[k],
            border: "1px solid rgba(128,128,128,0.25)",
            display: "inline-block",
            flexShrink: 0,
          }}
        />
      ))}
    </span>
  );
}

function CustomPaletteDots({ palette, mode }: { palette: CustomPalette; mode: ThemeMode }) {
  const paletteMode = palette.mode ?? mode;
  const base = PRESETS[palette.preset][paletteMode];
  const resolved = { ...base, ...palette.overrides };
  return (
    <span className="flex gap-0.5 items-center flex-shrink-0">
      {(["bg", "accent", "text"] as const).map((k) => (
        <span
          key={k}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: resolved[k],
            border: "1px solid rgba(128,128,128,0.25)",
            display: "inline-block",
            flexShrink: 0,
          }}
        />
      ))}
    </span>
  );
}

function SavePaletteInline({
  onSave,
  existingNames,
}: {
  onSave: (name: string) => void;
  existingNames: Set<string>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    if (BUILT_IN_LOWER.has(trimmed.toLowerCase())) {
      setError("Cannot use a built-in preset name.");
      return;
    }
    if (existingNames.has(trimmed.toLowerCase()) && !confirmOverwrite) {
      setError(`"${trimmed}" already exists. Save again to replace it.`);
      setConfirmOverwrite(true);
      return;
    }
    onSave(trimmed);
    setName("");
    setError("");
    setEditing(false);
    setConfirmOverwrite(false);
  }

  function handleNameChange(val: string) {
    setName(val);
    setError("");
    setConfirmOverwrite(false);
  }

  function handleCancel() {
    setEditing(false);
    setName("");
    setError("");
    setConfirmOverwrite(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-sm text-muted hover:text-text transition-colors mt-1"
      >
        + Save as palette…
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 mt-2">
      <Input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => handleNameChange(e.target.value)}
        placeholder="Palette name"
        style={{ width: 150 }}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSave();
          if (e.key === "Escape") handleCancel();
        }}
      />
      <button
        type="button"
        onClick={handleSave}
        className="px-3 py-1.5 rounded-md border border-accent bg-accent text-white text-sm font-medium cursor-pointer"
      >
        Save
      </button>
      <button
        type="button"
        onClick={handleCancel}
        className="px-3 py-1.5 rounded-md border border-border bg-panel text-muted text-sm font-medium hover:text-text cursor-pointer"
      >
        Cancel
      </button>
      {error && (
        <span className="text-xs text-[var(--color-danger)] w-full mt-0.5">{error}</span>
      )}
    </div>
  );
}

export function AppearanceSection() {
  const preset              = useThemeStore((s) => s.preset);
  const mode                = useThemeStore((s) => s.mode);
  const customPalettes      = useThemeStore((s) => s.customPalettes);
  const setPreset           = useThemeStore((s) => s.setPreset);
  const setMode             = useThemeStore((s) => s.setMode);
  const saveCustomPalette   = useThemeStore((s) => s.saveCustomPalette);
  const deleteCustomPalette = useThemeStore((s) => s.deleteCustomPalette);
  const applyCustomPalette  = useThemeStore((s) => s.applyCustomPalette);
  const [overridesOpen, setOverridesOpen] = useState(false);
  const overridesPanelId = useId();

  const existingPaletteNames = useMemo(
    () => new Set(customPalettes.map((p) => p.name.toLowerCase())),
    [customPalettes]
  );

  const saveOverridesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (saveOverridesTimer.current) {
      clearTimeout(saveOverridesTimer.current);
      // Best-effort flush: fires the save immediately if a debounce is still pending.
      // The fetch completes even after unmount (local desktop API, no abort signal).
      // Changes made in the last ~800ms before navigation may silently drop if the
      // request fails — there is no completion guarantee.
      persistThemeOverrides();
    }
  }, []);

  function scheduleSaveOverrides() {
    if (saveOverridesTimer.current) clearTimeout(saveOverridesTimer.current);
    saveOverridesTimer.current = setTimeout(() => {
      saveOverridesTimer.current = null;
      persistThemeOverrides();
    }, 800);
  }

  function handlePresetClick(name: PresetName) {
    if (saveOverridesTimer.current) {
      clearTimeout(saveOverridesTimer.current);
      saveOverridesTimer.current = null;
    }
    setPreset(name);
    persistThemeOverrides({}, {});
  }

  return (
    <Section title="Appearance">
      <p className="text-sm text-muted mb-3">Theme</p>

      <div className="flex flex-wrap gap-2 mb-2">
        {PRESET_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => handlePresetClick(name)}
            className={[
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 border font-medium text-sm cursor-pointer transition-colors",
              preset === name
                ? "border-accent bg-accent text-white"
                : "bg-panel text-muted border-border hover:text-text hover:border-accent",
            ].join(" ")}
          >
            <PresetDots preset={name} mode={mode} />
            {name}
          </button>
        ))}
      </div>

      {customPalettes.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4 pt-2 border-t border-border">
          {customPalettes.map((palette) => (
            <div key={palette.name} className="flex items-center">
              <button
                type="button"
                onClick={() => {
                  if (saveOverridesTimer.current) {
                    clearTimeout(saveOverridesTimer.current);
                    saveOverridesTimer.current = null;
                  }
                  applyCustomPalette(palette);
                  persistThemeOverrides(palette.overrides, palette.overrideAlphas);
                }}
                className="flex items-center gap-1.5 rounded-l-full pl-3 pr-2 py-1.5 border-y border-l font-medium text-sm cursor-pointer transition-colors bg-panel text-muted border-border hover:text-text hover:border-accent"
              >
                <CustomPaletteDots palette={palette} mode={mode} />
                {palette.name}
              </button>
              <button
                type="button"
                aria-label={`Delete palette ${palette.name}`}
                onClick={() => deleteCustomPalette(palette.name)}
                className="rounded-r-full px-2 py-1.5 border text-sm border-border bg-panel text-muted hover:text-[var(--color-danger)] hover:border-[var(--color-danger)] transition-colors cursor-pointer"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {customPalettes.length === 0 && <div className="mb-4" />}

      <div className="flex items-center gap-2 mb-4">
        {(["dark", "light"] as ThemeMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={[
              "px-3 py-1.5 rounded-md border text-sm font-medium transition-colors",
              mode === m
                ? "bg-accent border-accent text-white"
                : "bg-panel border-border text-muted hover:text-text",
            ].join(" ")}
          >
            {m === "dark"
              ? <><span aria-hidden="true">🌙</span> Dark</>
              : <><span aria-hidden="true">☀️</span> Light</>
            }
          </button>
        ))}
      </div>

      <GlassControls />

      <button
        type="button"
        aria-expanded={overridesOpen}
        aria-controls={overridesPanelId}
        className="flex items-center gap-2 text-sm text-muted hover:text-text transition-colors mb-2"
        onClick={() => setOverridesOpen((o) => !o)}
      >
        <span
          aria-hidden="true"
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

      <div
        id={overridesPanelId}
        className={overridesOpen ? "mt-2" : "hidden"}
      >
        <div className="flex items-center gap-3 mb-2">
          <span style={{ width: "7rem", flexShrink: 0 }} />
          <span className="text-xs text-muted" style={{ width: 112, flexShrink: 0 }}>Color</span>
          <span className="text-xs text-muted flex-1">Opacity</span>
        </div>
        {COLOR_OVERRIDE_KEYS.map(({ key, label }) => (
          <ColorRow
            key={`${preset}-${mode}-${key}`}
            label={label}
            colorKey={key}
            scheduleSave={scheduleSaveOverrides}
          />
        ))}
        <div className="mt-3 pt-2 border-t border-border">
          <SavePaletteInline
            onSave={saveCustomPalette}
            existingNames={existingPaletteNames}
          />
        </div>
      </div>
    </Section>
  );
}
