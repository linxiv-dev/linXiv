import { Button } from "../ui/button";

interface SelectionBarProps {
  count: number;
  onAddToProject: () => void;
  onDelete: () => void;
  onClear: () => void;
}

export function SelectionBar({
  count,
  onAddToProject,
  onDelete,
  onClear,
}: SelectionBarProps) {
  if (count === 0) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-30 flex items-center justify-between px-6 py-3 border-t border-border shadow-lg"
      style={{ backgroundColor: "var(--color-panel)" }}
    >
      <span className="text-sm font-medium text-text">
        {count} selected
      </span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
        <Button variant="muted" size="sm" onClick={onAddToProject}>
          Add to Project
        </Button>
        <Button variant="danger" size="sm" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}
