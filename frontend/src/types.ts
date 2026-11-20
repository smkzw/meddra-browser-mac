export type Mode = "zh" | "en" | "both";
export type ModuleKey = "search" | "advanced" | "browse" | "coding" | "detail" | "bin" | "history" | "settings";
export type SearchLevel = "SOC" | "HLGT" | "HLT" | "PT" | "LLT" | "SMQ";
export type PaneSide = "left" | "right";

export interface SearchResult {
  level: string;
  level_label: string;
  code: string;
  en_name: string;
  zh_name: string;
  is_current: string;
  category: string;
  category_label: string;
  matched_field: string;
  score: number;
  reason: string;
  version?: string;
}

export interface SearchGroup {
  category: string;
  label: string;
  results: SearchResult[];
  count: number;
  total_count?: number;
}

export interface TreeNode {
  level: string;
  level_label?: string;
  code?: string;
  smq_code?: string;
  display_name: string;
  en_name: string;
  zh_name: string;
  has_children?: boolean;
  is_current?: string;
  smq_level?: string;
}

export interface RelationNode {
  level: string;
  level_label?: string;
  code: string;
  display_name?: string;
  en_name?: string;
  zh_name?: string;
  children_count?: number;
  is_current?: string;
}

export interface RelationshipData {
  parents?: RelationNode[];
  children?: RelationNode[];
  hierarchy_paths?: Array<Record<string, string>>;
  primary_paths?: Array<Record<string, string>>;
  smq_memberships?: Array<Record<string, string>>;
  content?: Array<Record<string, string>>;
  content_count?: number;
}

export interface Detail {
  found: boolean;
  level?: string;
  code?: string;
  term?: {
    level: string;
    code: string;
    en_name: string;
    zh_name: string;
    is_current: string;
    parent_code?: string;
  };
  level_label?: string;
  hierarchies?: Array<Record<string, string>>;
  smq_memberships?: Array<Record<string, string>>;
  children_count?: number;
  relationships?: RelationshipData;
}

export interface SmqDetail {
  found: boolean;
  smq?: TreeNode & Record<string, string>;
  children?: TreeNode[];
  parents?: TreeNode[];
  content?: Array<Record<string, string>>;
  relationships?: RelationshipData;
}

export interface RelationshipTreeNode {
  level: string;
  levelLabel?: string;
  code: string;
  name: string;
  meta?: string;
  current?: boolean;
  inactive?: boolean;
}

export interface ReleaseInfo {
  version: string;
  complete: boolean;
  usable?: boolean;
  available_languages?: string[];
  missing_languages: string[];
}

export interface IndexIdentityObject {
  version?: string;
  source_signature?: string;
  [key: string]: unknown;
}

export interface Status {
  version: string;
  available_languages: string[];
  search_levels: SearchLevel[];
  available_versions: ReleaseInfo[];
  counts: Array<{ lang: string; file_name: string; row_count: number }>;
  term_counts: Array<{ level: string; n: number }>;
  smq_count: number;
  source_identity?: string;
  source_signature?: string;
  index_identity?: string | IndexIdentityObject;
}

export interface IndexStatus {
  version?: string;
  state: "pending" | "running" | "ready" | "error";
  phase?: string;
  message?: string;
  percent: number;
  processed_rows: number;
  total_rows: number;
  started_at?: number;
  updated_at?: number;
  error?: string;
  source_identity?: string;
  source_signature?: string;
  index_identity?: string | IndexIdentityObject;
}

export interface SourceRoot {
  id: string;
  label: string;
  exists: boolean;
  release_count: number;
  releases: ReleaseInfo[];
}

export interface SynonymRow {
  lang: string;
  phrase: string;
  synonym_group: string;
  weight?: number;
}

export interface PaneWidths {
  left: number;
  right: number;
}

export interface RuntimeInfo {
  app_name?: string;
  version?: string;
  app_store_mode?: boolean;
  distribution_mode?: string;
  instance_id?: string;
  shutdown_available?: boolean;
}

export interface HistoryEntry {
  action: string;
  text: string;
  at: string;
  level?: string;
  code?: string;
  version?: string;
}

export interface CodingRuntimeState {
  dirty: boolean;
  boundVersion: string;
  pendingCount: number;
  totalCount: number;
}

export interface ConfirmDialogAction {
  label: string;
  variant?: "primary" | "danger" | "default";
  onClick: () => void;
}

export interface ConfirmDialogState {
  title: string;
  body: string;
  warning?: string;
  actions: ConfirmDialogAction[];
}

declare global {
  interface Window {
    __meddraHasUnsavedWork?: boolean;
    webkit?: {
      messageHandlers?: {
        chooseDictionary?: {
          postMessage: (message: unknown) => Promise<unknown>;
        };
      };
    };
  }
}
