import type { Paper } from "../../types/api";
import { Badge } from "../ui/badge";
import { useSelectionStore } from "../../stores/selection";

function normalizeAuthors(authors: string | string[]): string[] {
  if (Array.isArray(authors)) return authors;
  // Comma-separated string from API
  return authors.split(",").map((a) => a.trim()).filter(Boolean);
}

interface PaperCardProps {
  paper: Paper;
  showCheckbox?: boolean;
  onNavigate?: (sourceId: string) => void;
}

export function PaperCard({
  paper,
  showCheckbox = false,
  onNavigate,
}: PaperCardProps) {
  const { selectedIds, toggle } = useSelectionStore();
  const isSelected = selectedIds.has(paper.source_id);

  const authors = normalizeAuthors(paper.authors ?? []);
  const displayAuthors = authors.slice(0, 3);
  const hasMoreAuthors = authors.length > 3;

  const displayTags = paper.tags.slice(0, 4);

  const publishedYear = paper.published
    ? new Date(paper.published).getFullYear()
    : null;

  function handleCardClick() {
    onNavigate?.(paper.source_id);
  }

  function handleCheckboxChange(e: React.ChangeEvent<HTMLInputElement>) {
    e.stopPropagation();
    toggle(paper.source_id);
  }

  function handleCheckboxClick(e: React.MouseEvent) {
    e.stopPropagation();
  }

  return (
    <div
      onClick={handleCardClick}
      className={[
        "bg-panel rounded-lg border border-border p-4 transition-all",
        "hover:brightness-110 cursor-pointer",
        isSelected ? "ring-1 ring-accent" : "",
      ].join(" ")}
    >
      {/* Row 1: checkbox + title + pdf badge */}
      <div className="flex items-start gap-2">
        {showCheckbox && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={handleCheckboxChange}
            onClick={handleCheckboxClick}
            className="mt-0.5 shrink-0 accent-[var(--color-accent)] cursor-pointer"
            aria-label={`Select ${paper.title}`}
          />
        )}
        <span className="flex-1 font-medium text-text leading-snug line-clamp-2">
          {paper.title}
        </span>
        {paper.has_pdf && (
          <Badge
            className="shrink-0 ml-1"
            style={{
              borderColor: "var(--color-success)",
              color: "var(--color-success)",
              backgroundColor: "color-mix(in srgb, var(--color-success) 15%, transparent)",
            }}
          >
            PDF
          </Badge>
        )}
      </div>

      {/* Row 2: authors + date */}
      <div className="flex items-center gap-2 mt-1.5 text-muted text-sm">
        <span className="truncate">
          {displayAuthors.join(", ")}
          {hasMoreAuthors && " et al."}
        </span>
        {publishedYear && (
          <>
            <span className="text-border">·</span>
            <span className="shrink-0">{publishedYear}</span>
          </>
        )}
      </div>

      {/* Row 3: category + tags */}
      {(paper.category || displayTags.length > 0) && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {paper.category && (
            <Badge
              style={{
                borderColor: "var(--color-accent)",
                color: "var(--color-accent)",
                backgroundColor: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
              }}
            >
              {paper.category}
            </Badge>
          )}
          {displayTags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
      )}

      {/* Abstract preview */}
      {paper.summary && (
        <p className="mt-2 text-muted text-sm line-clamp-2 leading-relaxed">
          {paper.summary}
        </p>
      )}
    </div>
  );
}
