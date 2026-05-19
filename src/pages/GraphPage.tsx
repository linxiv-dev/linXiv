import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function GraphPage() {
  const navigate = useNavigate();

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (!e.data || typeof e.data !== "object") return;
      if (e.data.type === "paper_clicked" && e.data.id) {
        navigate(`/library/${e.data.id}`);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [navigate]);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="p-4 border-b border-border flex items-center gap-3">
        <h1 className="text-lg font-semibold text-text">Knowledge Graph</h1>
        <span className="text-sm text-muted">Click a node to open the paper</span>
      </div>
      <iframe
        src="/graph/graph.html"
        className="flex-1 border-0 w-full"
        title="Paper knowledge graph"
        allow="scripts"
      />
    </div>
  );
}
