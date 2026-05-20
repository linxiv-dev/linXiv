export interface Stats {
  paper_count: number;
  tag_count: number;
  category_count: number;
  pdf_count: number;
  recent_papers: Paper[];
}

export interface Paper {
  source_id: string;
  source_fk: number;
  version: number;
  title: string;
  summary: string | null;
  authors: string | string[];
  published: string | null;
  updated: string | null;
  url: string | null;
  doi: string | null;
  category: string | null;
  categories?: string[];
  journal_ref: string | null;
  comment: string | null;
  tags: string[];
  has_pdf: boolean;
  pdf_path: string | null;
  source: string | null;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  color_hex: string | null;
  project_tags: string[];
  source_ids: string[];
  status: string;
  paper_count?: number;
}

export interface Note {
  id: number;
  source_fk: number;
  project_id: number | null;
  title: string;
  content: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  tags?: string[];
  project_ids?: number[];
}

export interface GraphEdge {
  source: string;
  target: string;
  type?: string;
}

export interface SearchResult {
  source_id: string;
  version: number;
  title: string;
  summary: string;
  authors: string[];
  published: string;
  pdf_url: string;
  primary_category: string;
  entry_id: string;
}

export interface Settings {
  pdf_save_limit_mb: number;
  theme_overrides: Record<string, string>;
  search_history_enabled?: boolean;
  search_history_max?: number;
  [key: string]: unknown;
}

export interface Clause {
  operator: "AND" | "OR" | "AND NOT";
  field: "all" | "ti" | "au" | "abs";
  value: string;
}

export interface SearchState {
  clauses: Clause[];
  source: string;
  max_results: number;
  results: SearchResult[];
  saved_ids: string[];
  updated_at: string;
}
