import { X } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  id?: string;
}

export interface TagInputHandle {
  /** Returns the current committed tags plus any uncommitted draft, deduped. */
  getTagsWithDraft(): string[];
}

function isDuplicate(label: string, existing: string[]): boolean {
  return existing.some((t) => t.toLowerCase() === label.toLowerCase());
}

export const TagInput = forwardRef<TagInputHandle, TagInputProps>(function TagInput(
  { value, onChange, placeholder = "Add tag...", id },
  ref
) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    getTagsWithDraft() {
      const label = draft.trim();
      if (label && !isDuplicate(label, value)) {
        return [...value, label];
      }
      return value;
    },
  }), [draft, value]);

  function commit(raw: string) {
    const label = raw.trim();
    if (label && !isDuplicate(label, value)) {
      onChange([...value, label]);
    }
    setDraft("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-md border border-[var(--color-border)] cursor-text min-h-[38px]"
      style={{ backgroundColor: "var(--color-bg)" }}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((tag, idx) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium select-none"
          style={{
            backgroundColor: "var(--color-panel)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border)",
          }}
        >
          {tag}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onChange(value.filter((_, i) => i !== idx));
            }}
            className="opacity-50 hover:opacity-100 leading-none ml-0.5 flex items-center"
            aria-label={`Remove ${tag}`}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[80px] bg-transparent outline-none text-sm"
        style={{ color: "var(--color-text)" }}
        size={1}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  );
});
