import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { getStats } from "../api/settings";
import { Spinner } from "../components/ui/spinner";
import { PaperCard } from "../components/papers/PaperCard";

interface StatCardProps {
  label: string;
  value: number | undefined;
  to?: string;
}

function StatCard({ label, value, to }: StatCardProps) {
  const navigate = useNavigate();
  const interactive = to !== undefined;
  const className =
    "bg-panel rounded-lg border border-border p-5 flex flex-col gap-1 text-left" +
    (interactive
      ? " cursor-pointer transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      : "");

  const content = (
    <>
      <span
        className="text-3xl font-bold"
        style={{ color: "var(--color-accent)" }}
      >
        {value ?? "—"}
      </span>
      <span className="text-sm text-muted">{label}</span>
    </>
  );

  if (interactive) {
    return (
      <button type="button" className={className} onClick={() => navigate(to!)}>
        {content}
      </button>
    );
  }
  return <div className={className}>{content}</div>;
}

export default function HomePage() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ["stats"],
    queryFn: getStats,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size={28} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          {error instanceof Error ? error.message : "Failed to load stats"}
        </p>
      </div>
    );
  }

  const recentPapers = data?.recent_papers?.slice(0, 10) ?? [];

  return (
    <div className="p-8 space-y-8 overflow-y-auto">
      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Papers" value={data?.paper_count} to="/library" />
        <StatCard label="PDFs" value={data?.pdf_count} to="/library" />
        <StatCard label="Categories" value={data?.category_count} />
        <StatCard label="Tags" value={data?.tag_count} to="/tags" />
      </div>

      {/* Recent papers */}
      <section>
        <h2 className="text-base font-semibold text-text mb-4">
          Recent Papers
        </h2>
        {recentPapers.length === 0 ? (
          <p className="text-muted text-sm text-center py-12">
            No papers yet. Add some from the Library or Search pages.
          </p>
        ) : (
          <div className="space-y-3">
            {recentPapers.map((paper) => (
              <PaperCard
                key={paper.source_id}
                paper={paper}
                onNavigate={(id) => navigate(`/library/${id}`)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
