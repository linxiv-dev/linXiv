import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "../components/ui/button";
import { formSubmitOnCtrlEnter } from "../lib/submitShortcut";
import { invalidatePaperMutationQueries } from "../lib/paperMutations";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { LogoMark } from "../components/ui/logo-mark";
import { fetchArxiv, resolveDoi, saveDoi } from "../api/search";
import { importPdfUrl, recognizePaperInput } from "../api/exportImport";
import type { PaperMetadata } from "../types/api";

/** Recognize outcome for the non-DOI paths: paper already saved. */
type AddOutcome = { doi: string } | { savedTitle: string };

export default function DoiPage() {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  // Capture the exact DOI string that was resolved, so Save always uses it
  // even if the user edits the input field afterwards.
  const [resolvedDoi, setResolvedDoi] = useState("");
  const [metadata, setMetadata] = useState<PaperMetadata | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [savedTitle, setSavedTitle] = useState<string | null>(null);

  // Resolve mutation (DOI preview flow)
  const resolveMutation = useMutation({
    mutationFn: (d: string) => resolveDoi(d),
    onSuccess: (data, variables) => {
      setMetadata(data.metadata);
      setResolvedDoi(variables);
      setSaveSuccess(false);
    },
  });

  // Recognize + dispatch: a DOI hands off to the preview flow above; arXiv ids
  // and direct PDF URLs save immediately.
  const addMutation = useMutation({
    mutationFn: async (raw: string): Promise<AddOutcome> => {
      const rec = await recognizePaperInput(raw);
      switch (rec.kind) {
        case "doi":
          return { doi: rec.value };
        case "arxiv_id": {
          const r = await fetchArxiv(rec.value, true);
          return { savedTitle: r.paper.title };
        }
        case "direct_pdf_url": {
          const r = await importPdfUrl(rec.value);
          return { savedTitle: r.title };
        }
        default:
          throw new Error(
            "Not a recognized paper reference. Paste an arXiv link or ID, a DOI, or a direct PDF link."
          );
      }
    },
    onSuccess: (outcome) => {
      if ("doi" in outcome) {
        resolveMutation.mutate(outcome.doi);
      } else {
        setSavedTitle(outcome.savedTitle);
        invalidatePaperMutationQueries(queryClient);
      }
    },
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: (d: string) => saveDoi(d),
    onSuccess: () => {
      setSaveSuccess(true);
      invalidatePaperMutationQueries(queryClient);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    setMetadata(null);
    setSaveSuccess(false);
    setSavedTitle(null);
    resolveMutation.reset();
    addMutation.mutate(trimmed);
  }

  function handleClear() {
    setMetadata(null);
    setSaveSuccess(false);
    setSavedTitle(null);
    setInput("");
    setResolvedDoi("");
    addMutation.reset();
    resolveMutation.reset();
    saveMutation.reset();
  }

  const pending = addMutation.isPending || resolveMutation.isPending;
  const resolveError = (addMutation.error ?? resolveMutation.error) as Error | null;
  const saveError = saveMutation.error as Error | null;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[640px] px-6 py-8">
        <h1 className="font-display text-[27px] font-semibold leading-tight tracking-[-0.015em] text-text mb-6">
          Add Paper
        </h1>
        <p className="text-sm mb-4" style={{ color: "var(--color-muted)" }}>
          Paste an arXiv link or ID, a DOI or doi.org link, or a direct PDF link.
        </p>

        {/* Input form */}
        <form onSubmit={handleSubmit} onKeyDown={formSubmitOnCtrlEnter} className="flex gap-2 mb-2">
          <Input
            placeholder="https://arxiv.org/abs/2312.00752"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={pending}
            className="flex-1 h-9"
            aria-label="Paper link, DOI, or arXiv ID"
          />
          <Button
            type="submit"
            variant="primary"
            size="md"
            disabled={pending || !input.trim()}
          >
            {pending && <Spinner size={14} />}
            {pending ? "Adding…" : "Add"}
          </Button>
        </form>

        {/* Resolve error */}
        {resolveError && (
          <p className="text-sm mt-2 mb-4" style={{ color: "var(--color-danger)" }}>
            {resolveError.message}
          </p>
        )}

        {/* Loading state */}
        {pending && (
          <div role="status" aria-label="Loading" className="flex items-center justify-center gap-3 py-16 text-[var(--color-muted)]">
            <LogoMark size={32} className="animate-pulse" />
          </div>
        )}

        {/* Direct-save confirmation (arXiv id / PDF URL paths) */}
        {!pending && savedTitle !== null && (
          <div className="flex items-center gap-3 mt-4">
            <p className="text-sm font-medium" style={{ color: "var(--color-success)" }}>
              Saved to library ✓ {savedTitle && `"${savedTitle}"`}
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={handleClear}>
              Clear
            </Button>
          </div>
        )}

        {/* Result card */}
        {!pending && metadata && (
          <div
            className="rounded-lg border border-[var(--color-border)] p-5 mt-4"
            style={{ background: "var(--color-panel)" }}
          >
            {/* Title */}
            {metadata.title && (
              <h2 className="font-semibold text-[var(--color-text)] leading-snug mb-2">
                {metadata.title}
              </h2>
            )}

            {/* Authors */}
            {metadata.authors.length > 0 && (
              <p className="text-sm text-[var(--color-muted)] mb-3">
                {metadata.authors.join(", ")}
              </p>
            )}

            {/* Abstract (the wire field is `summary`) */}
            {metadata.summary && (
              <p
                className="text-sm text-[var(--color-muted)] leading-relaxed mb-4"
                style={{
                  display: "-webkit-box",
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {metadata.summary}
              </p>
            )}

            {/* Meta row */}
            <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-muted)] mb-4 border-t border-[var(--color-border)] pt-3">
              {metadata.source && (
                <span>
                  <span className="text-[var(--color-text)]">Source:</span>{" "}
                  {metadata.source}
                </span>
              )}
              {metadata.doi && (
                <span>
                  <span className="text-[var(--color-text)]">DOI:</span>{" "}
                  {metadata.doi}
                </span>
              )}
              {metadata.published && (
                <span>
                  <span className="text-[var(--color-text)]">Published:</span>{" "}
                  {metadata.published.slice(0, 10)}
                </span>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 flex-wrap">
              {saveSuccess ? (
                <p
                  className="text-sm font-medium"
                  style={{ color: "var(--color-success)" }}
                >
                  Saved to library ✓
                </p>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate(resolvedDoi)}
                >
                  {saveMutation.isPending && <Spinner size={12} />}
                  {saveMutation.isPending ? "Saving…" : "Save to Library"}
                </Button>
              )}

              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleClear}
              >
                Clear
              </Button>
            </div>

            {/* Save error */}
            {saveError && (
              <p
                className="text-sm mt-2"
                style={{ color: "var(--color-danger)" }}
              >
                {saveError.message}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
