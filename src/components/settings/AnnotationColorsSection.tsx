import { useUiStore, type ColorLabel } from "../../stores/ui";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingGroup, SettingGroupLabel, SettingRow } from "./SettingRow";

export function AnnotationColorsSection() {
  const { colorLabels, setColorLabels } = useUiStore();

  function update(i: number, patch: Partial<ColorLabel>) {
    setColorLabels(colorLabels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  return (
    <div>
      <SettingGroupLabel>Annotation colors</SettingGroupLabel>
      <p className="mb-2.5 text-xs text-muted">
        Name highlight colors to organize your annotations. Labelled colors appear as quick
        picks in the annotation popup. Labels stay on this device.
      </p>
      <SettingGroup>
        {colorLabels.map((l, i) => (
          <SettingRow
            key={i}
            label={
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  value={l.color}
                  onChange={(e) => update(i, { color: e.target.value })}
                  aria-label={`Color for label ${l.name || i + 1}`}
                  className="w-6 h-6 cursor-pointer rounded border-0 bg-transparent p-0"
                />
                <Input
                  type="text"
                  value={l.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  placeholder="Label name"
                  aria-label={`Name for color ${l.color}`}
                  style={{ width: 200 }}
                />
              </span>
            }
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setColorLabels(colorLabels.filter((_, j) => j !== i))}
              aria-label={`Delete label ${l.name || l.color}`}
            >
              Delete
            </Button>
          </SettingRow>
        ))}
        <SettingRow label="">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setColorLabels([...colorLabels, { color: "#888888", name: "" }])}
          >
            Add label
          </Button>
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
