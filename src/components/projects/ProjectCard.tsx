import type { Project } from "../../types/api";
import { Badge } from "../ui/badge";
import { ColorSwatch } from "./ColorSwatch";

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
}

export function ProjectCard({ project, onClick }: ProjectCardProps) {
  const visibleTags = project.project_tags.slice(0, 3);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-5 cursor-pointer transition-all hover:border-[var(--color-accent)] hover:shadow-sm flex flex-col gap-3"
    >
      {/* Top: swatch + name */}
      <div className="flex items-center gap-2">
        <ColorSwatch color={project.color_hex} size={12} />
        <span
          className="font-semibold text-sm truncate"
          style={{ color: "var(--color-text)" }}
        >
          {project.name}
        </span>
      </div>

      {/* Description */}
      {project.description && (
        <p
          className="text-sm leading-snug"
          style={{
            color: "var(--color-muted)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {project.description}
        </p>
      )}

      {/* Bottom row */}
      <div className="flex items-center gap-2 flex-wrap mt-auto">
        <Badge>
          {project.paper_count ?? project.source_ids.length} paper
          {(project.paper_count ?? project.source_ids.length) !== 1 ? "s" : ""}
        </Badge>
        {visibleTags.map((tag) => (
          <Badge key={tag}>{tag}</Badge>
        ))}
      </div>
    </div>
  );
}
