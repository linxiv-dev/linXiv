import { useState } from "react";
import { updateEnv } from "../../api/settings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Section } from "./Section";

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

export function ApiKeysSection() {
  const [geminiKey, setGeminiKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");

  return (
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
  );
}
