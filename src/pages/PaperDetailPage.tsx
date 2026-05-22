import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { getPaperBySfk, getPaperVersions, getPaperPdfUrl } from "../api/papers";
import { getNotes, deleteNote } from "../api/notes";
import { fetchArxiv } from "../api/search";
import type { Note, Paper } from "../types/api";
import { Spinner } from "../components/ui/spinner";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { NoteCard } from "../components/notes/NoteCard";
import { NoteEditor } from "../components/notes/NoteEditor";
import { PaperMetadataEditor } from "../components/papers/PaperMetadataEditor";
import { normalizeAuthors } from "../lib/papers";
import { TagBadge } from "../components/tags/TagBadge";

const LATEST_VERSION_KEY = "latest" as const;

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function PaperDetailPage() {
  const { sfk } = useParams<{ sfk: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [showAddNote, setShowAddNote] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [showPdfViewer, setShowPdfViewer] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  // null means "latest"; a number means a specific stored version
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

  const {
    data: paper,
    isLoading: paperLoading,
    isFetching: paperFetching,
    error: paperError,
  } = useQuery({
    queryKey: ["paper", "sfk", sfk, selectedVersion ?? LATEST_VERSION_KEY],
    queryFn: () => getPaperBySfk(Number(sfk), selectedVersion ?? undefined),
    enabled: !!sfk,
    placeholderData: keepPreviousData,
  });

  const { data: versionsData } = useQuery({
    queryKey: ["paper", "versions", sfk],
    queryFn: () => getPaperVersions(Number(sfk)),
    enabled: !!sfk,
  });

  const versions = versionsData?.versions ?? [];

  const {
    data: notesData,
    isLoading: notesLoading,
  } = useQuery({
    queryKey: ["notes", paper?.source_id],
    queryFn: () => getNotes(paper!.source_id),
    enabled: !!paper?.source_id,
  });

  const isViewingLatest = selectedVersion === null || selectedVersion === versionsData?.latest_version;

  const downloadPdfMutation = useMutation({
    mutationFn: () => fetchArxiv(paper!.source_id, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["paper", "sfk", sfk] });
      queryClient.invalidateQueries({ queryKey: ["paper", "versions", sfk] });
    },
  });

  const deleteNoteMutation = useMutation({
    mutationFn: (noteId: number) => deleteNote(noteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes", paper?.source_id] });
    },
  });

  function handleNotesSaved() {
    queryClient.invalidateQueries({ queryKey: ["notes", paper?.source_id] });
    setShowAddNote(false);
    setEditingNote(null);
  }

  function handleDeleteNote(note: Note) {
    deleteNoteMutation.mutate(note.id);
  }

  function handlePaperSaved(_updated: Paper) {
    // source_id is immutable via the repair endpoint (see ADR-0008), so
    // updated.source_id === paper.source_id is always true here. The notes
    // cache key is tied to source_id; one invalidation is sufficient.
    // The repair endpoint always returns the latest version regardless of
    // which version the user was viewing, so setQueryData is unsafe here.
    // Invalidate all ["paper","sfk",sfk,*] slots via prefix match.
    queryClient.invalidateQueries({ queryKey: ["paper", "sfk", sfk] });
    queryClient.invalidateQueries({ queryKey: ["paper", "versions", sfk] });
    queryClient.invalidateQueries({ queryKey: ["notes", paper?.source_id] });
    queryClient.invalidateQueries({ queryKey: ["papers"] });
    queryClient.invalidateQueries({ queryKey: ["graph"] });
    queryClient.invalidateQueries({ queryKey: ["stats"] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
    queryClient.invalidateQueries({ queryKey: ["tag"] });
  }

  if (paperLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner size={28} />
      </div>
    );
  }

  if (paperError || !paper) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          {paperError instanceof Error
            ? paperError.message
            : "Paper not found."}
        </p>
      </div>
    );
  }

  const authors = normalizeAuthors(paper.authors ?? []);
  const notes = notesData?.notes ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Two-column layout */}
        <div className="flex flex-col lg:flex-row gap-8">
          {/* Left column — paper details */}
          <div
            className="flex-1 min-w-0 space-y-5"
            style={{
              opacity: paperFetching && !paperLoading ? 0.6 : 1,
              transition: "opacity 0.15s",
            }}
          >
            {/* Back button + Edit */}
            <div className="flex items-center justify-between mb-1">
              <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
                ← Library
              </Button>
              {isViewingLatest && (
                <Button variant="muted" size="sm" onClick={() => setShowEditor(true)}>
                  Edit
                </Button>
              )}
            </div>

            {/* Title */}
            <h1 className="text-xl font-semibold text-text leading-snug">
              {paper.title}
            </h1>

            {/* Authors */}
            {authors.length > 0 && (
              <p className="text-muted text-sm">
                {authors.join(", ")}
              </p>
            )}

            {/* Meta row */}
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {paper.published && (
                <span className="text-muted">{formatDate(paper.published)}</span>
              )}
              {paper.doi && (
                <>
                  <span className="text-border">·</span>
                  <a
                    href={`https://doi.org/${paper.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="transition-colors hover:text-text"
                    style={{ color: "var(--color-accent)" }}
                  >
                    DOI: {paper.doi}
                  </a>
                </>
              )}
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
              {versions.length > 1 && (versionsData?.latest_version ?? 0) >= 1 ? (
                // Version selector — only rendered when multiple versions are stored.
                // Native <select> is styled to match Badge; acceptable in the
                // Tauri/WebKit target environment.
                <select
                  value={selectedVersion ?? versionsData?.latest_version}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSelectedVersion(v === versionsData?.latest_version ? null : v);
                  }}
                  className="inline-flex items-center rounded-full font-medium border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-text)] px-2 py-0.5 text-xs cursor-pointer"
                  aria-label="Select version"
                >
                  {versions.filter((v) => v.version >= 1).map((v) => {
                    const dateStr = v.updated ?? v.published;
                    const label = dateStr ? ` · ${formatDate(dateStr)}` : "";
                    const isLatest = v.version === versionsData?.latest_version;
                    return (
                      <option key={v.version} value={v.version}>
                        v{v.version}{isLatest ? " (latest)" : ""}{label}
                      </option>
                    );
                  })}
                </select>
              ) : paper.version > 0 && (
                // Static badge when only one version is stored (v0 = no version info).
                <Badge>v{paper.version}</Badge>
              )}
            </div>

            {/* Tags */}
            {paper.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {paper.tags.map((tag) => (
                  <TagBadge key={tag} label={tag} />
                ))}
              </div>
            )}

            {/* Abstract */}
            {paper.summary && (
              <div className="space-y-1.5">
                <h2 className="text-sm font-semibold text-text">Abstract</h2>
                <p className="text-muted text-sm leading-relaxed whitespace-pre-wrap">
                  {paper.summary}
                </p>
              </div>
            )}

            {/* PDF section */}
            <div className="pt-2 space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                {paper.has_pdf ? (
                  <Button
                    variant="primary"
                    onClick={() => setShowPdfViewer((v) => !v)}
                  >
                    {showPdfViewer ? "Hide PDF" : "View PDF"}
                  </Button>
                ) : (
                  <>
                    {paper.source === "arxiv" && isViewingLatest && (
                      <Button
                        variant="muted"
                        onClick={() => downloadPdfMutation.mutate()}
                        disabled={downloadPdfMutation.isPending}
                      >
                        {downloadPdfMutation.isPending ? "Fetching…" : "Download PDF"}
                      </Button>
                    )}
                    {paper.url && (
                      <a
                        href={paper.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm hover:underline"
                        style={{ color: "var(--color-accent)" }}
                      >
                        View online ↗
                      </a>
                    )}
                  </>
                )}
                {downloadPdfMutation.isError && (
                  <span className="text-xs" style={{ color: "var(--color-danger)" }}>
                    {downloadPdfMutation.error instanceof Error
                      ? downloadPdfMutation.error.message
                      : "Failed to fetch PDF"}
                  </span>
                )}
                {downloadPdfMutation.isSuccess && (
                  <span className="text-xs" style={{ color: "var(--color-success)" }}>
                    PDF saved
                  </span>
                )}
              </div>

              {showPdfViewer && paper.has_pdf && (
                <iframe
                  src={getPaperPdfUrl(paper.source_id, paper.version > 0 ? paper.version : undefined)}
                  className="w-full rounded border border-border"
                  style={{ height: "70vh" }}
                  title="PDF viewer"
                />
              )}
            </div>
          </div>

          {/* Right column — notes */}
          <div className="lg:w-80 xl:w-96 shrink-0 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-text">Notes</h2>
              {!showAddNote && !editingNote && (
                <Button
                  variant="muted"
                  size="sm"
                  onClick={() => setShowAddNote(true)}
                >
                  + Add note
                </Button>
              )}
            </div>

            {/* Add note form */}
            {showAddNote && !editingNote && (
              <div className="bg-panel rounded-lg border border-border p-4">
                <NoteEditor
                  sourceId={paper.source_id}
                  onSave={handleNotesSaved}
                  onCancel={() => setShowAddNote(false)}
                />
              </div>
            )}

            {/* Edit note form */}
            {editingNote && (
              <div className="bg-panel rounded-lg border border-border p-4">
                <NoteEditor
                  sourceId={paper.source_id}
                  initialNote={editingNote}
                  onSave={handleNotesSaved}
                  onCancel={() => setEditingNote(null)}
                />
              </div>
            )}

            {/* Notes list */}
            {notesLoading ? (
              <div className="flex justify-center py-6">
                <Spinner size={20} />
              </div>
            ) : notes.length === 0 ? (
              <p className="text-muted text-sm text-center py-8">
                No notes yet. Add one above.
              </p>
            ) : (
              <div className="space-y-3">
                {notes.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    onEdit={(n) => {
                      setEditingNote(n);
                      setShowAddNote(false);
                    }}
                    onDelete={handleDeleteNote}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showEditor && (
        <PaperMetadataEditor
          onClose={() => setShowEditor(false)}
          paper={paper}
          onSaved={handlePaperSaved}
        />
      )}
    </div>
  );
}
