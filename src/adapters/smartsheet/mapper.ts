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
    // The machine-readable twin of `Source`. `Source` is built for a person to read - path,
    // then an optional line, then the evidence type - and cannot be parsed back reliably,
    // because a filename may itself contain the separators. Anything the engine needs to
    // COMPARE gets its own column; see `Repo Status` and `Repo Review`.
    'Repo Path': item.repositoryPath,
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

/** The shared Status field. The shared checkbox is written separately - see `reviewCells`. */
export function sharedCells(status: Status): CellValues {
  return { 'Status': status };
}

/**
 * The shared checkbox, written as a pair.
 *
 * `Repo Review` mirrors what we wrote, so the next run can tell our checkbox from a person's
 * even with no state file. It is the Human Review analogue of `Repo Status`, and the two MUST
 * move together: writing `Human Review` without `Repo Review` strands our own tick, and
 * writing `Repo Review` over a person's tick relabels their decision as ours.
 */
export function reviewCells(humanReview: boolean): CellValues {
  return { 'Human Review': humanReview, 'Repo Review': humanReview, 'Review Owner': 'tool' };
}

/** Records that the person owns the checkbox from now on, without touching the checkbox. */
export function handReviewToHuman(): CellValues {
  return { 'Review Owner': 'human' };
}
