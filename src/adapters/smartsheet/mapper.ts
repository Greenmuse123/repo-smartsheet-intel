/**
 * ProjectItem → cell values keyed by column title.
 *
 * What: the only place that knows how a model field lands in a sheet column. Truncates long
 *       text below Smartsheet's silent 4000-char limit with a visible marker.
 */
import type { ProjectItem, Status, SyncStatus } from '../../model/types.js';

export const CELL_MAX = 3900;
export type CellValues = Record<string, string | number | boolean | null>;

export function trunc(s: string | undefined): string | null {
  if (!s) return null;
  return s.length > CELL_MAX ? s.slice(0, CELL_MAX - 14) + '… [truncated]' : s;
}

/** Fields the repository owns. Written on create and on every change. */
export function repoCells(item: ProjectItem, syncStatus: SyncStatus, now: string): CellValues {
  return {
    'Item ID': item.itemId,
    'Item': trunc(item.item),
    'Type': item.type,
    'Component': item.component,
    'Description': trunc(item.description),
    'Source': trunc(item.sourceReference),
    'Last Repo Update': item.lastRepositoryUpdate ?? null,
    'Confidence': item.confidence,
    'Sync Status': syncStatus,
    'AI Suggestion': trunc(item.aiSuggestion),
    'Repo Status': item.status,
    'Source Commit': item.sourceCommit ?? null,
    'Last Synced': now,
    'Repo Fingerprint': item.fingerprint,
  };
}

/** Fields humans own. Written ONLY when a row is created, and only if the repo has evidence. */
export function humanSeedCells(item: ProjectItem): CellValues {
  const out: CellValues = {};
  if (item.priority) out['Priority'] = item.priority;
  if (item.owner) out['Owner'] = item.owner;
  if (item.dependency) out['Dependency'] = trunc(item.dependency);
  if (item.milestone) out['Milestone'] = trunc(item.milestone);
  return out;
}

/** Shared fields. */
export function sharedCells(status: Status, humanReview: boolean): CellValues {
  // `Repo Review` mirrors what we wrote, so the next run can tell our checkbox from a human's
  // even with no state file. It is the Human Review analogue of `Repo Status`.
  return { 'Status': status, 'Human Review': humanReview, 'Repo Review': humanReview };
}
