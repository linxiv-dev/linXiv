import type { Project } from "../../types/api";
import { Badge } from "../ui/badge";
import { TagBadge } from "../tags/TagBadge";
import { ColorSwatch } from "./ColorSwatch";

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
  /** Native context menu (Tauri); browser dev falls through to the default. */
  onContextMenu?: React.MouseEventHandler;
}

export function ProjectCard({ project, onClick, onContextMenu }: ProjectCardProps) {
  const visibleTags = project.project_tags.slice(0, 3);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="rounded-lg border border-border bg-panel p-5 cursor-pointer transition-all hover:border-accent hover:shadow-sm flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <ColorSwatch color={project.color_hex} size={12} />
        <span className="font-semibold text-sm truncate text-text">
          {project.name}
        </span>
      </div>

      {project.description && (
        <p
          className="text-sm leading-snug text-muted"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {project.description}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap mt-auto">
        <Badge>
          {project.paper_count ?? project.source_ids.length} paper
          {(project.paper_count ?? project.source_ids.length) !== 1 ? "s" : ""}
        </Badge>
        {visibleTags.map((tag) => (
          <TagBadge key={tag} label={tag} />
        ))}
      </div>
    </div>
  );
}
