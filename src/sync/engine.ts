/**
 * Sync engine.
 *
 * What: turns (items, sheet rows, local state) into a SyncPlan (pure), then applies it in batches.
 *       Ownership model (DESIGN.md §5):
 *         repo-controlled → overwritten when the fingerprint changes
 *         human-controlled → written on create only
 *         shared (Status, Human Review) → 3-way merge; disagreement = Conflict, never overwrite
 *       Rows that vanished from the repo are marked "Missing in Repo", never deleted.
 * Use:  `const plan = planSync(items, rows, state, now)`; `await applyPlan(plan, target, state, now)`.
 */
import type { PlannedChange, ProjectItem, Status, SyncPlan, SyncStatus } from '../model/types.js';
import { humanSeedCells, repoCells, sharedCells } from '../adapters/smartsheet/mapper.js';
import type { SheetTarget, TargetRow, CellValues } from './target.js';
import type { SyncState } from './state.js';
import { log } from '../log/logger.js';

export function planSync(items: ProjectItem[], rows: TargetRow[], state: SyncState, now: string): SyncPlan {
  const byItemId = new Map<string, TargetRow>();
  for (const r of rows) { const id = r.cells['Item ID']; if (typeof id === 'string' && id) byItemId.set(id, r); }

  const changes: PlannedChange[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    seen.add(item.itemId);
    const row = byItemId.get(item.itemId);
    if (!row) {
      changes.push({ action: 'create', item, cells: { ...repoCells(item, 'New', now), ...humanSeedCells(item), ...sharedCells(item.status, item.humanReviewRequired) }, reasons: ['not in sheet yet'] });
      continue;
    }
    const st = state.items[item.itemId];
    const sheetFingerprint = String(row.cells['Repo Fingerprint'] ?? st?.fingerprint ?? '');
    const lastWrittenStatus = String(row.cells['Repo Status'] ?? st?.lastWrittenStatus ?? '');
    const sheetStatus = String(row.cells['Status'] ?? '');
    const humanChangedStatus = sheetStatus !== '' && sheetStatus !== lastWrittenStatus;
    const repoChangedStatus = item.status !== lastWrittenStatus;
    const repoChanged = sheetFingerprint !== item.fingerprint;
    const alreadyConflict = row.cells['Sync Status'] === 'Conflict';

    if (!repoChanged) {
      // Nothing new from the repo. If a human resolved a conflict we leave everything alone.
      changes.push({ action: 'unchanged', item, rowId: row.rowId, cells: {}, reasons: ['fingerprint matches'] });
      continue;
    }

    const reasons: string[] = ['repo-controlled fields changed'];
    let syncStatus: SyncStatus = 'Updated';
    let status: Status = item.status;
    let humanReview = item.humanReviewRequired || Boolean(row.cells['Human Review']);
    let action: PlannedChange['action'] = 'update';

    if (repoChangedStatus && humanChangedStatus && sheetStatus !== item.status) {
      // Both sides moved Status and disagree → keep the human's value, surface ours in Repo Status.
      action = 'conflict';
      syncStatus = 'Conflict';
      status = sheetStatus as Status;
      humanReview = true;
      reasons.push(`status conflict: sheet says "${sheetStatus}", repo says "${item.status}", last synced "${lastWrittenStatus}"`);
    } else if (humanChangedStatus) {
      status = sheetStatus as Status; // human edited, repo didn't move → respect the human
      reasons.push(`kept human status "${sheetStatus}"`);
    } else if (repoChangedStatus) {
      reasons.push(`status ${lastWrittenStatus || '(none)'} → ${item.status}`);
    }
    if (alreadyConflict && action !== 'conflict') reasons.push('previous conflict cleared by new repo change');

    changes.push({ action, item, rowId: row.rowId, cells: { ...repoCells(item, syncStatus, now), ...sharedCells(status, humanReview) }, reasons });
  }

  for (const [id, row] of byItemId) {
    if (seen.has(id)) continue;
    if (row.cells['Sync Status'] === 'Missing in Repo') continue; // already flagged; leave the human to close it
    const ghost = { itemId: id, item: String(row.cells['Item'] ?? id) } as ProjectItem;
    changes.push({ action: 'missing', item: ghost, rowId: row.rowId, cells: { 'Sync Status': 'Missing in Repo', 'Human Review': true, 'Last Synced': now }, reasons: ['item no longer found in repository; row kept for a human to close or merge'] });
  }

  const counts = { create: 0, update: 0, unchanged: 0, conflict: 0, missing: 0 };
  for (const c of changes) counts[c.action]++;
  const humanReviewCount = changes.filter((c) => c.action !== 'unchanged' && c.cells['Human Review'] === true).length;
  return { changes, counts, humanReviewCount };
}

export function describePlan(plan: SyncPlan, sheetRowCount: number): string[] {
  const { counts } = plan;
  const lines = [
    `${sheetRowCount} rows already exist in the sheet.`,
    `${counts.create} new item${counts.create === 1 ? '' : 's'} will be created.`,
    `${counts.update} item${counts.update === 1 ? '' : 's'} will be updated.`,
    `${counts.unchanged} item${counts.unchanged === 1 ? '' : 's'} unchanged.`,
    `${counts.conflict} conflict${counts.conflict === 1 ? '' : 's'} detected (human value kept, flagged for review).`,
    `${counts.missing} row${counts.missing === 1 ? '' : 's'} no longer found in the repository (kept, flagged).`,
    `${plan.humanReviewCount} item${plan.humanReviewCount === 1 ? '' : 's'} require${plan.humanReviewCount === 1 ? 's' : ''} human review.`,
  ];
  return lines;
}

export async function applyPlan(plan: SyncPlan, target: SheetTarget, state: SyncState, now: string): Promise<{ created: number; updated: number }> {
  const creates = plan.changes.filter((c) => c.action === 'create');
  const updates = plan.changes.filter((c) => c.action === 'update' || c.action === 'conflict' || c.action === 'missing');

  let created = 0, updated = 0;
  if (creates.length) {
    const ids = await target.addRows(creates.map((c) => c.cells));
    creates.forEach((c, i) => { if (ids[i] !== undefined) remember(state, c, ids[i], now); });
    created = ids.length;
    log.info(`Created ${created} row${created === 1 ? '' : 's'} in the sheet.`);
  }
  if (updates.length) {
    updated = await target.updateRows(updates.map((c) => ({ rowId: c.rowId!, cells: c.cells })));
    for (const c of updates) if (c.action !== 'missing') remember(state, c, c.rowId!, now);
    log.info(`Updated ${updated} row${updated === 1 ? '' : 's'} in the sheet.`);
  }
  state.lastRunAt = now;
  return { created, updated };
}

function remember(state: SyncState, c: PlannedChange, rowId: number, now: string): void {
  state.items[c.item.itemId] = {
    rowId,
    fingerprint: c.item.fingerprint,
    lastWrittenStatus: String((c.cells as CellValues)['Repo Status'] ?? c.item.status),
    lastWrittenHumanReview: Boolean(c.cells['Human Review']),
    lastSyncedAt: now,
  };
}
