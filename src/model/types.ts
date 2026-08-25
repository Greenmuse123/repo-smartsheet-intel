/**
 * Core data model.
 *
 * What: the three shapes every other module speaks — RawEvidence (what the repo literally says),
 *       ProjectItem (the normalized fact), and SyncPlan (what we intend to do to the sheet).
 * Rule: evidence and interpretation are never merged. `ProjectItem.evidence` keeps the raw
 *       excerpts; `aiSuggestion` keeps anything inferred. See DESIGN.md §3.
 */

export const ITEM_TYPES = [
  'Feature', 'Bug', 'Task', 'Technical Debt', 'Documentation', 'Test',
  'Dependency', 'Risk', 'Decision', 'Milestone', 'Release', 'Unknown',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Done', 'Released', 'Unknown'] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ['High', 'Medium', 'Low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CONFIDENCES = ['High', 'Medium', 'Low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const SYNC_STATUSES = ['New', 'Synced', 'Updated', 'Conflict', 'Missing in Repo', 'Error'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** A verbatim observation from the repository. Immutable after extraction. */
export interface RawEvidence {
  extractor: string;
  sourceType: string;
  path: string;
  line?: number;
  section?: string;
  excerpt: string;
  commit?: string;
  lastRepoUpdate?: string;
  refs?: string[];
}

/** A normalized, traceable project fact. */
export interface ProjectItem {
  itemId: string;
  item: string;
  type: ItemType;
  description: string;
  status: Status;
  priority?: Priority;
  owner?: string;
  component: string;
  repositoryPath: string;
  sourceReference: string;
  sourceCommit?: string;
  dependency?: string;
  milestone?: string;
  startDate?: string;
  dueDate?: string;
  lastRepositoryUpdate?: string;
  risk?: string;
  aiSuggestion?: string;
  confidence: Confidence;
  humanReviewRequired: boolean;
  /** sha1 over repo-controlled fields; drives change detection. */
  fingerprint: string;
  evidence: RawEvidence[];
}

/** A file the scanner decided is safe and relevant to read. */
export interface ScannedFile {
  /** repo-relative, forward slashes */
  path: string;
  content: string;
  size: number;
  commit?: string;
  lastRepoUpdate?: string;
}

export interface RepoInventory {
  root: string;
  filesScanned: number;
  filesIgnored: number;
  filesSkippedSensitive: string[];
  languages: Record<string, number>;
  frameworks: string[];
  topLevelDirs: string[];
  hasGit: boolean;
  headCommit?: string;
  sources: Record<string, string[]>; // sourceType -> paths
  /** every file path seen (including ignored ones) — lets heuristics check for lockfiles etc. */
  allPaths: string[];
}

export interface ExtractorContext {
  files: ScannedFile[];
  inventory: RepoInventory;
  perPackageDependencies: boolean;
}

export interface Extractor {
  id: string;
  run(ctx: ExtractorContext): RawEvidence[];
}

/** Sync planning output. Nothing here has touched the network yet. */
export type PlanAction = 'create' | 'update' | 'unchanged' | 'conflict' | 'missing';

export interface PlannedChange {
  action: PlanAction;
  item: ProjectItem;
  rowId?: number;
  /** column title -> value we intend to write */
  cells: Record<string, string | number | boolean | null>;
  reasons: string[];
}

export interface SyncPlan {
  changes: PlannedChange[];
  counts: Record<PlanAction, number>;
  humanReviewCount: number;
}
