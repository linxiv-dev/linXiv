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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { NoteCard } from "../components/notes/NoteCard";
import { NoteEditor } from "../components/notes/NoteEditor";
import { PaperMetadataEditor } from "../components/papers/PaperMetadataEditor";
import { normalizeAuthors } from "../lib/papers";
import { TagBadge } from "../components/tags/TagBadge";
import { openPath } from "@tauri-apps/plugin-opener";

const LATEST_VERSION_KEY = "latest" as const;

// True only inside the Tauri webview; false in plain browser dev mode.
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  // Slice to 10 chars to handle ISO 8601 timestamps ("2024-01-01T...").
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return dateStr;
  const date = new Date(y, m - 1, d);
  // Detect invalid rollover (e.g. month 13 or day 99): JS silently wraps them.
  if (date.getMonth() !== m - 1 || date.getDate() !== d) return dateStr;
  return date.toLocaleDateString(undefined, {
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
  const [showEditor, setShowEditor] = useState(false);
  const [openNativeError, setOpenNativeError] = useState<string | null>(null);
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
    enabled: !!sfk && Number.isFinite(Number(sfk)),
    placeholderData: keepPreviousData,
  });

  const { data: versionsData } = useQuery({
    queryKey: ["paper", "versions", sfk],
    queryFn: () => getPaperVersions(Number(sfk)),
    enabled: !!sfk && Number.isFinite(Number(sfk)),
    placeholderData: keepPreviousData,
  });

  const versions = versionsData?.versions ?? [];

  const { data: notesData, isLoading: notesLoading } = useQuery({
    queryKey: ["notes", paper?.source_id],
    queryFn: () => getNotes(paper!.source_id),
    enabled: !!paper?.source_id,
  });

  const isViewingLatest =
    selectedVersion === null || selectedVersion === versionsData?.latest_version;

  const downloadPdfMutation = useMutation({
    mutationFn: (sourceId: string) => fetchArxiv(sourceId, true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["paper", "sfk", sfk] });
      queryClient.invalidateQueries({ queryKey: ["paper", "versions", sfk] });
      queryClient.invalidateQueries({ queryKey: ["papers"] });
      queryClient.invalidateQueries({ queryKey: ["stats"] });
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
    if (!deleteNoteMutation.isPending) {
      deleteNoteMutation.mutate(note.id);
    }
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

  async function handleOpenNative() {
    if (!paper?.pdf_path) return;
    setOpenNativeError(null);
    try {
      await openPath(paper.pdf_path);
    } catch (err) {
      setOpenNativeError(
        err instanceof Error ? err.message : "Failed to open PDF"
      );
    }
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
          {paperError instanceof Error ? paperError.message : "Paper not found."}
        </p>
      </div>
    );
  }

  const authors = normalizeAuthors(paper.authors ?? []);
  const notes = notesData?.notes ?? [];
  const tags = paper.tags ?? [];
  const versionedList = versions
    .filter((v) => v.version >= 1)
    .sort((a, b) => a.version - b.version);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-5">
        {/* Header row: back + edit */}
        <div
          className="flex items-center justify-between"
          style={{
            opacity: paperFetching && !paperLoading ? 0.6 : 1,
            transition: "opacity 0.15s",
          }}
        >
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            ← Library
          </Button>
          {isViewingLatest && (
            <Button variant="muted" size="sm" onClick={() => setShowEditor(true)}>
              Edit
            </Button>
          )}
        </div>

        {/* Paper identity: always visible across all tabs */}
        <div
          className="space-y-3"
          style={{
            opacity: paperFetching && !paperLoading ? 0.6 : 1,
            transition: "opacity 0.15s",
          }}
        >
          <h1 className="text-xl font-semibold text-text leading-snug">
            {paper.title}
          </h1>

          {authors.length > 0 && (
            <p className="text-muted text-sm">{authors.join(", ")}</p>
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
                  backgroundColor:
                    "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                }}
              >
                {paper.category}
              </Badge>
            )}
            {versionedList.length > 1 ? (
              <select
                value={selectedVersion ?? versionsData?.latest_version}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setSelectedVersion(
                    v === versionsData?.latest_version ? null : v
                  );
                }}
                className="inline-flex items-center rounded-full font-medium border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-text)] px-2 py-0.5 text-xs cursor-pointer"
                aria-label="Select version"
              >
                {versionedList.map((v) => {
                  const dateStr = v.updated ?? v.published;
                  const label = dateStr ? ` · ${formatDate(dateStr)}` : "";
                  const isLatest = v.version === versionsData?.latest_version;
                  return (
                    <option key={v.version} value={v.version}>
                      v{v.version}
                      {isLatest ? " (latest)" : ""}
                      {label}
                    </option>
                  );
                })}
              </select>
            ) : (
              paper.version > 0 && <Badge>v{paper.version}</Badge>
            )}
          </div>

          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <TagBadge key={tag} label={tag} />
              ))}
            </div>
          )}
        </div>

        {/* Tabs: Overview | Notes | PDF */}
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="notes">
              Notes{notes.length > 0 ? ` (${notes.length})` : ""}
            </TabsTrigger>
            <TabsTrigger value="pdf">PDF</TabsTrigger>
          </TabsList>

          {/* Overview tab: abstract */}
          <TabsContent value="overview" className="pt-5">
            {paper.summary ? (
              <div className="space-y-1.5">
                <h2 className="text-sm font-semibold text-text">Abstract</h2>
                <p className="text-muted text-sm leading-relaxed whitespace-pre-wrap">
                  {paper.summary}
                </p>
              </div>
            ) : (
              <p className="text-muted text-sm">No abstract available.</p>
            )}
          </TabsContent>

          {/* Notes tab: forceMount keeps editor draft state alive across tab switches. */}
          <TabsContent value="notes" forceMount className="pt-5 space-y-4 data-[state=inactive]:hidden">
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

            {showAddNote && !editingNote && (
              <div className="bg-panel rounded-lg border border-border p-4">
                <NoteEditor
                  sourceId={paper.source_id}
                  onSave={handleNotesSaved}
                  onCancel={() => setShowAddNote(false)}
                />
              </div>
            )}

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

            {notesLoading ? (
              <div className="flex justify-center py-6">
                <Spinner size={20} />
              </div>
            ) : (
              <>
                {notes.length === 0 && !showAddNote && !editingNote && (
                  <p className="text-muted text-sm text-center py-8">
                    No notes yet. Add one above.
                  </p>
                )}
                {notes.length > 0 && (
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
              </>
            )}
          </TabsContent>

          {/* PDF tab */}
          <TabsContent value="pdf" className="pt-5 space-y-4">
            {paper.has_pdf ? (
              <>
                <div className="flex items-center gap-3 flex-wrap">
                  {isTauri && paper.pdf_path && (
                    <Button variant="primary" onClick={handleOpenNative}>
                      Open in system viewer
                    </Button>
                  )}
                  {openNativeError && (
                    <span className="text-xs" style={{ color: "var(--color-danger)" }}>
                      {openNativeError}
                    </span>
                  )}
                </div>

                <iframe
                  src={getPaperPdfUrl(
                    paper.source_id,
                    paper.version > 0 ? paper.version : undefined
                  )}
                  className="w-full rounded border border-border"
                  style={{ height: "70vh" }}
                  title="PDF viewer"
                />
              </>
            ) : (
              <div className="space-y-3">
                {paper.source === "arxiv" && isViewingLatest && (
                  <div className="flex items-center gap-3 flex-wrap">
                    <Button
                      variant="muted"
                      onClick={() => downloadPdfMutation.mutate(paper.source_id)}
                      disabled={downloadPdfMutation.isPending}
                    >
                      {downloadPdfMutation.isPending ? "Fetching…" : "Download PDF"}
                    </Button>
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
                {!paper.url && (paper.source !== "arxiv" || !isViewingLatest) && (
                  <p className="text-muted text-sm">No PDF available for this version.</p>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
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
