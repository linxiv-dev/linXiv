import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getPaper, getPaperPdfUrl } from "../api/papers";
import { getNotes, deleteNote } from "../api/notes";
import { fetchArxiv } from "../api/search";
import type { Note } from "../types/api";
import { Spinner } from "../components/ui/spinner";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { NoteCard } from "../components/notes/NoteCard";
import { NoteEditor } from "../components/notes/NoteEditor";

function normalizeAuthors(authors: string | string[]): string[] {
  if (Array.isArray(authors)) return authors;
  return authors.split(",").map((a) => a.trim()).filter(Boolean);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export default function PaperDetailPage() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [showAddNote, setShowAddNote] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);

  const {
    data: paper,
    isLoading: paperLoading,
    error: paperError,
  } = useQuery({
    queryKey: ["paper", sourceId],
    queryFn: () => getPaper(sourceId!),
    enabled: !!sourceId,
  });

  const {
    data: notesData,
    isLoading: notesLoading,
  } = useQuery({
    queryKey: ["notes", sourceId],
    queryFn: () => getNotes(sourceId!),
    enabled: !!sourceId,
  });

  const downloadPdfMutation = useMutation({
    mutationFn: () => fetchArxiv(sourceId!, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["paper", sourceId] });
    },
  });

  const deleteNoteMutation = useMutation({
    mutationFn: (noteId: number) => deleteNote(noteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notes", sourceId] });
    },
  });

  function handleNotesSaved() {
    queryClient.invalidateQueries({ queryKey: ["notes", sourceId] });
    setShowAddNote(false);
    setEditingNote(null);
  }

  function handleDeleteNote(note: Note) {
    deleteNoteMutation.mutate(note.id);
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
          <div className="flex-1 min-w-0 space-y-5">
            {/* Back button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(-1)}
              className="mb-1"
            >
              ← Library
            </Button>

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
              {paper.version > 0 && (
                <Badge>v{paper.version}</Badge>
              )}
            </div>

            {/* Tags */}
            {paper.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {paper.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
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
            <div className="pt-2">
              {paper.has_pdf ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    const url = getPaperPdfUrl(paper.source_id);
                    window.open(url, "_blank", "noopener,noreferrer");
                  }}
                >
                  Open PDF
                </Button>
              ) : (
                <div className="flex items-center gap-3">
                  <Button
                    variant="muted"
                    onClick={() => downloadPdfMutation.mutate()}
                    disabled={downloadPdfMutation.isPending}
                  >
                    {downloadPdfMutation.isPending ? "Fetching…" : "Download PDF"}
                  </Button>
                  {downloadPdfMutation.isError && (
                    <span
                      className="text-xs"
                      style={{ color: "var(--color-danger)" }}
                    >
                      {downloadPdfMutation.error instanceof Error
                        ? downloadPdfMutation.error.message
                        : "Failed to fetch PDF"}
                    </span>
                  )}
                  {downloadPdfMutation.isSuccess && (
                    <span
                      className="text-xs"
                      style={{ color: "var(--color-success)" }}
                    >
                      PDF saved
                    </span>
                  )}
                </div>
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
                  sourceId={sourceId!}
                  onSave={handleNotesSaved}
                  onCancel={() => setShowAddNote(false)}
                />
              </div>
            )}

            {/* Edit note form */}
            {editingNote && (
              <div className="bg-panel rounded-lg border border-border p-4">
                <NoteEditor
                  sourceId={sourceId!}
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
    </div>
  );
}
