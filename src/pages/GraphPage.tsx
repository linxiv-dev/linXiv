import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useThemeStore } from "../stores/theme";
import { getColors } from "../lib/theme";

export default function GraphPage() {
  const navigate = useNavigate();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const preset = useThemeStore(s => s.preset);
  const mode = useThemeStore(s => s.mode);
  const overrides = useThemeStore(s => s.overrides);
  const overrideAlphas = useThemeStore(s => s.overrideAlphas);

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

  const sendTheme = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    const colors = getColors(preset, mode, overrides, overrideAlphas);
    iframe.contentWindow.postMessage({ type: "theme_update", colors }, "*");
  }, [preset, mode, overrides, overrideAlphas]);

  useEffect(() => {
    sendTheme();
  }, [sendTheme]);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="p-4 border-b border-border flex items-center gap-3">
        <h1 className="text-lg font-semibold text-text">Knowledge Graph</h1>
        <span className="text-sm text-muted">Click a node to open the paper</span>
      </div>
      <iframe
        ref={iframeRef}
        src="/graph/graph.html"
        className="flex-1 border-0 w-full"
        title="Paper knowledge graph"
        allow="scripts"
        onLoad={sendTheme}
      />
    </div>
  );
}