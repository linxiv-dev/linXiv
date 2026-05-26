import type { Note } from "../../types/api";
import { Button } from "../ui/button";

interface NoteCardProps {
  note: Note;
  onEdit: (note: Note) => void;
  onDelete: (note: Note) => void;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export function NoteCard({ note, onEdit, onDelete }: NoteCardProps) {
  return (
    <div className="bg-panel rounded border border-border p-3 flex flex-col gap-1.5">
      {/* Header: title + date */}
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-text leading-snug">
          {note.title || "Untitled note"}
        </span>
        <span className="shrink-0 text-muted text-xs mt-0.5">
          {formatDate(note.created_at)}
        </span>
      </div>

      {/* Content preview */}
      {note.content && (
        <p
          className="text-muted text-sm line-clamp-3 leading-relaxed whitespace-pre-wrap"
        >
          {note.content}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1 pt-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onEdit(note)}
        >
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(note)}
          className="hover:text-[var(--color-danger)]"
        >
          Delete
        </Button>
      </div>
    </div>
  );
}
