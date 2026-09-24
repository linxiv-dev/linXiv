import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { formSubmitOnCtrlEnter } from "../../lib/submitShortcut";
import { invalidatePaperMutationQueries } from "../../lib/paperMutations";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { LogoMark } from "../ui/logo-mark";
import { fetchArxiv, resolveDoi, saveDoi } from "../../api/search";
import { importPdfUrl, recognizePaperInput } from "../../api/exportImport";
import { addPaper } from "../../lib/addPaper";
import type { PaperMetadata } from "../../types/api";

/** Paste-a-reference add flow, shared by the /doi page and the sidebar popover.
 *  `compact` drops the large loading mark for tight containers. */
export function AddPaperForm({ compact = false }: { compact?: boolean }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  // Capture the exact DOI string that was resolved, so Save always uses it
  // even if the user edits the input field afterwards.
  const [resolvedDoi, setResolvedDoi] = useState("");
  // Publisher PDF link recognized alongside the DOI, tried on Save.
  const [pdfUrl, setPdfUrl] = useState<string | undefined>();
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
    mutationFn: (raw: string) =>
      addPaper(raw, { recognize: recognizePaperInput, fetchArxiv, importPdfUrl }),
    onSuccess: (outcome) => {
      if ("doi" in outcome) {
        setPdfUrl(outcome.pdfUrl);
        resolveMutation.mutate(outcome.doi);
      } else {
        setSavedTitle(outcome.savedTitle);
        invalidatePaperMutationQueries(queryClient);
      }
    },
  });

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: (d: string) => saveDoi(d, pdfUrl),
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
    setPdfUrl(undefined);
    addMutation.reset();
    resolveMutation.reset();
    saveMutation.reset();
  }

  const pending = addMutation.isPending || resolveMutation.isPending;
  const resolveError = (addMutation.error ?? resolveMutation.error) as Error | null;
  const saveError = saveMutation.error as Error | null;

  return (
    <>
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
      {pending && !compact && (
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
                {saveMutation.data?.pdf_saved === false && (
                  <span className="font-normal" style={{ color: "var(--color-muted)" }}>
                    {" "}(PDF not retrieved: the publisher may require access)
                  </span>
                )}
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
    </>
  );
}
