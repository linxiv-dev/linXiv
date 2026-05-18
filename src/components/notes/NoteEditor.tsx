import { useState } from "react";
import type { Note } from "../../types/api";
import { createNote, updateNote } from "../../api/notes";
import { Input, Textarea } from "../ui/input";
import { Button } from "../ui/button";

interface NoteEditorProps {
  sourceId: string;
  projectId?: number | null;
  initialNote?: Note;
  onSave: () => void;
  onCancel: () => void;
}

export function NoteEditor({
  sourceId,
  projectId,
  initialNote,
  onSave,
  onCancel,
}: NoteEditorProps) {
  const [title, setTitle] = useState(initialNote?.title ?? "");
  const [content, setContent] = useState(initialNote?.content ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      if (initialNote) {
        await updateNote(initialNote.id, { title, content });
      } else {
        await createNote({
          source_id: sourceId,
          project_id: projectId ?? null,
          title,
          content,
        });
      }
      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save note");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        placeholder="Note title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={saving}
      />
      <Textarea
        placeholder="Note content…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        disabled={saving}
        className="min-h-[120px]"
      />
      {error && (
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={saving || (!title.trim() && !content.trim())}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
