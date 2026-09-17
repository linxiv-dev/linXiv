// The wire types the frontend consumes.
//
// Anything with a canonical serializer in linxiv-core is GENERATED into
// ./generated.ts (CONTEXT.md § Serializer Convention); this file only aliases
// those to the UI's vocabulary and hand-writes the shapes with no single Rust
// struct. Each hand-written one says why; when the reason goes, generate it.
import type { ThemeColors, ColorAlphas } from "../lib/theme";
import type {
  PaperDetails,
  ProjectOut,
  NoteDetails,
  AnnotationDetails,
  SearchResultOut,
  AuthorWithCount,
  AuthorWithPapers,
  FilterRule,
  SyncSkipped,
  SyncedReceipt,
} from "./generated";

export type {
  PaperDetails,
  ProjectOut,
  NoteDetails,
  AnnotationDetails,
  SearchResultOut,
  ArxivSearchResponse,
  ArxivFetchResponse,
  OpenAlexSearchResponse,
  SavedPdf,
  MergeCandidates,
  BasicAuthorDetails,
  AuthorWithCount,
  AuthorWithPapers,
  AuthorPaperPreview,
  Status,
  Stats,
  DoiVersionCandidate,
  MergeReceipt,
  FullTextReceipt,
  PaperMembershipReceipt,
  BibtexImportReceipt,
  FilterField,
  FilterAction,
  TagWithCount,
  NewVersion,
  OrcidCandidate,
  ImportPreview,
  ImportPreviewResponse,
  ImportedProject,
  PaperImportResult,
  PapersListing,
  PaperVersionMeta,
  PaperVersionsResponse,
  DoiCandidates,
  FullTextPending,
  SavedSourceIds,
  DeletedPaperReceipt,
  RemovedFromProjects,
  OkReceipt,
  SavedPdfListing,
  DeletedPdf,
  BackupInfo,
  PreMigrationBackup,
  ImportReport,
  DeletedPaperDetails,
  TrashedProjectRow,
  RestoredPaper,
  EditorProjectSummary,
  ProjectsResponse,
  CreatedProject,
  BulkAddReceipt,
  TagsResponse,
  TagDetail,
  AuthorsResponse,
  AuthorMergeResponse,
  PaperMetadata,
  OpenAlexSaveResponse,
  DoiResolveResponse,
  DoiSaveResponse,
  NoteListResponse,
  NoteGetResponse,
  DeletedNote,
  AnnotationListResponse,
  CreatedAnnotation,
  ReadingStatusesResponse,
  ReadingStatusReceipt,
  EditorProjectsResponse,
  SearchHistoryResponse,
  VersionCheckResponse,
  NewVersionsResponse,
  FeedRulesResponse,
  OrcidBackfillResponse,
  HardDeletedPaper,
  RestoredProject,
  HardDeletedProject,
  NoteCreateBody,
  NoteUpdateBody,
  AnnotationCreateBody,
  AnnotationUpdateBody,
  AuthorMergeBody,
  AuthorUpdateBody,
  CreateEditorProjectBody,
  ProjectCreateBody,
  ProjectUpdateBody,
  ProjectAddPaperBody,
  ProjectAddPapersBulkBody,
  ProjectExportBody,
  PaperSavedBody,
  PaperMergeBody,
  UploadPdfBody,
  ImportPdfBody,
  RecognizeBody,
  RecognizedInput,
  ImportPdfUrlBody,
  ImportBibtexBody,
  ImportPreviewBody,
  ImportCommitBody,
  ArxivSearchBody,
  ArxivFetchBody,
  OpenAlexSearchBody,
  OpenAlexSaveBody,
  DoiResolveBody,
  DoiSaveBody,
  FeedDismissBody,
  FeedRuleCreateBody,
  StorageBackupBody,
  StorageRestoreBody,
  StorageImportBody,
  OrcidBackfillBody,
  VersionsCheckBody,
  VersionsAckBody,
  ReadingStatusPutBody,
  EnvPatchBody,
  SummaryRow,
  SharedProjectsListing,
  ReceivedListing,
  ImportedReceipt,
  UnpublishedReceipt,
  LeftReceipt,
  UnlinkedReceipt,
  PublishedReceipt,
  TicketMinted,
  MemberCode,
  InviteMinted,
  MembersListing,
  MemberRow,
  PresenceListing,
  PresenceRow,
  PresenceUpdate,
  RoleChanged,
  AdminTransferred,
  RevokedReceipt,
  RekeyedReceipt,
  RemovedReceipt,
  SharedPdfSaved,
  SyncDirection,
  ShareSettings,
  SyncRole,
  SyncReason,
  SyncSkipped,
  SyncedReceipt,
} from "./generated";

// `PUT /api/papers/sfk/{fk}` body; core names it RepairFields.
export type { RepairFields as PaperRepairBody } from "./generated";

// History (`/api/history`): change log, per-change diff, restore.
export type {
  DeviceActor,
  ChangeRow,
  Timeline,
  PaperChange,
  EntryChange,
  FieldChange,
  HistoryDiff,
  RestoredToChange,
  RestoreBody,
} from "./generated";

// Frontend names for the generated serializers.
export type Paper = PaperDetails;
export type Project = ProjectOut;
export type Note = NoteDetails;
export type Annotation = AnnotationDetails;
export type SearchResult = SearchResultOut;
export type Author = AuthorWithCount;
export type AuthorDetail = AuthorWithPapers;
export type FeedFilterRule = FilterRule;

// `POST /api/share/{id}/sync` returns one of two generated shapes
// (share_sync.rs); the union has no Rust struct of its own.
export type SyncReceipt = SyncSkipped | SyncedReceipt;

// --- Not generated ---------------------------------------------------------

// `GET /api/settings` returns `UserSettings::all()` — a free-form JSON object
// seeded from crates/core/assets/default_settings.json, with the mailto env
// keys overlaid by route/settings.rs. No Rust struct, so the index signature
// is honest, not an escape hatch; the keys below are the ones the app reads.
export interface Settings {
  pdf_save_limit_mb: number;
  theme_overrides: Partial<ThemeColors>;
  theme_override_alphas: ColorAlphas;
  search_history_enabled?: boolean;
  search_history_max?: number;
  tex_rendering_enabled?: boolean;
  full_text_worker_enabled?: boolean;
  home_feed_url?: string;
  rss_cache_retention_days?: number;
  update_check_frequency?: string;
  /** Overlaid from the process env; set via `PATCH /api/env`. */
  CROSSREF_MAILTO?: string;
  OPENALEX_MAILTO?: string;
  ARXIV_MAILTO?: string;
  /** Self-hosted iroh relay override; empty keeps n0's public relays. */
  p2p_relay_url?: string;
  p2p_relay_auth_token?: string;
  /** If set, refuse to bind the p2p node rather than use n0's relays. */
  p2p_relay_only?: boolean;
  /** Opt-in: tell share members which shared paper you are reading. */
  share_presence_reading?: boolean;
  /** History attribution: actor hex (lowercase) → display name, overriding a
   *  remote node's host-assigned display_name. */
  actor_names?: Record<string, string>;
  [key: string]: unknown;
}

// The graph's wire shapes are GENERATED from `linxiv_core::graph` (`GraphView`
// and friends in ./generated.ts); `npm run types:check` catches drift.

// Core's `service::feed::FeedResponse` types `entries` as `Vec<Value>` (cached
// entries round-trip through the DB as stored JSON), so generating it would
// give `JsonValue` where the app relies on this shape. Hand-written until core
// types those entries.
export interface FeedEntry {
  title: string;
  link: string;
  authors: string[];
  summary: string;
  published: string;
  arxiv_id: string | null;
  version: number | null;
}

export interface FeedResponse {
  title: string;
  entries: FeedEntry[];
  saved_arxiv_ids: string[];
}

// Request-side only: the search form's clause rows. route/search.rs takes them
// as an untyped `Vec<Map<String, Value>>`.
export interface Clause {
  operator: "AND" | "OR" | "AND NOT";
  field: "all" | "ti" | "au" | "abs";
  value: string;
  uid: string;
}
