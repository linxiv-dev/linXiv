import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchArxiv } from "../api/search";
import { appendSavedId } from "../api/searchState";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import type { SearchResult } from "../types/api";
import { isArxivId } from "../lib/papers";

interface PdfPreviewState {
  result: SearchResult;
  isSaved: boolean;
}

function isValidPdfPreviewState(state: unknown): state is PdfPreviewState {
  if (!state || typeof state !== "object") return false;
  const s = state as Record<string, unknown>;
  if (!s.result || typeof s.result !== "object") return false;
  const r = s.result as Record<string, unknown>;
  return (
    typeof r.source_id === "string" &&
    typeof r.title === "string" &&
    typeof r.paper_url === "string" &&
    typeof s.isSaved === "boolean"
  );
}

export default function PdfPreviewPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const state = isValidPdfPreviewState(location.state) ? location.state : null;
  const [saved, setSaved] = useState(state?.isSaved ?? false);

  const saveMutation = useMutation({
    mutationFn: (sourceId: string) => fetchArxiv(sourceId, true),
    onSuccess: (data) => {
      if (data.saved) {
        // setSaved reflects the backend's confirmed save. appendSavedId syncs the
        // persisted search state so SearchPage shows this paper as saved on remount.
        // If appendSavedId fails the library is still correct (fetchArxiv persisted it);
        // only the search state cache is stale — the user will see the paper as unsaved
        // in search results until the next search. Tracked in TODO.md (deferred).
        setSaved(true);
        appendSavedId(data.source_id).catch((e) =>
          console.error("appendSavedId failed:", e)
        );
        queryClient.invalidateQueries({ queryKey: ["papers"] });
        queryClient.invalidateQueries({ queryKey: ["stats"] });
      }
    },
  });

  if (!state) {
    return (
      <div className="flex items-center justify-center gap-2 h-full text-muted text-sm">
        No PDF selected.
        <button
          type="button"
          className="text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
          onClick={() => navigate("/search")}
        >
          Go to Search
        </button>
      </div>
    );
  }

  const { result } = state;

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div
        className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border"
        style={{ background: "var(--color-bg)" }}
      >
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          ← Back
        </Button>

        <h1
          className="flex-1 text-sm font-medium text-text truncate"
          title={result.title}
        >
          {result.title}
        </h1>

        {isArxivId(result.source_id) && (
          saved ? (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium"
              style={{
                background: "color-mix(in srgb, var(--color-success) 15%, transparent)",
                color: "var(--color-success)",
              }}
            >
              In library
            </span>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate(result.source_id)}
            >
              {saveMutation.isPending ? (
                <span className="flex items-center gap-1.5">
                  <Spinner size={12} /> Saving…
                </span>
              ) : (
                "Save to library"
              )}
            </Button>
          )
        )}

        {saveMutation.isError && (
          <span className="text-xs text-danger">
            {saveMutation.error instanceof Error
              ? saveMutation.error.message
              : "Save failed"}
          </span>
        )}
      </div>

      {/* PDF iframe — only rendered when there is a URL to load.
          allow-scripts is omitted to prevent script execution regardless of content type.
          allow-same-origin without allow-scripts carries no sandbox escape risk and is
          retained so WebKit PDF downloads work correctly. */}
      {result.paper_url ? (
        <iframe
          src={result.paper_url}
          className="flex-1 w-full border-0"
          title={result.title}
          sandbox="allow-forms allow-popups allow-downloads allow-same-origin"
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted text-sm">
          No PDF URL available for this paper.
        </div>
      )}
    </div>
  );
}
