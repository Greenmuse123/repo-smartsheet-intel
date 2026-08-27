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
  const duplicateIds = new Set<string>();
  for (const r of rows) {
    const id = r.cells['Item ID'];
    if (typeof id !== 'string' || !id) continue;
    if (byItemId.has(id)) duplicateIds.add(id); // two rows claim the same identity
    byItemId.set(id, r);
  }
  if (duplicateIds.size) {
    // Silently keeping only the last row would let the sheet drift forever without anyone knowing.
    log.warn(`${duplicateIds.size} Item ID(s) appear on more than one row: ${[...duplicateIds].join(', ')}. Only the last row of each is synchronized; a human should merge or delete the extras.`);
  }

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
    // A blank Status is not "no human value": a person can clear a Smartsheet dropdown. If it
    // differs from what we last wrote, someone cleared it, and restoring the repository value
    // silently would be exactly the overwrite this tool promises never to do. We restore it -
    // a blank Status breaks every report - but we say so and flag it rather than doing it
    // quietly. `humanChangedStatus` stays false so the restored value is ours, not theirs.
    const humanClearedStatus = sheetStatus === '' && lastWrittenStatus !== '';
    const humanChangedStatus = sheetStatus !== '' && sheetStatus !== lastWrittenStatus;
    const repoChangedStatus = item.status !== lastWrittenStatus;
    const repoChanged = sheetFingerprint !== item.fingerprint;
    const sync = String(row.cells['Sync Status'] ?? '');
    // Both flags read the same cell, which is why that cell has to be able to hold both facts.
    const alreadyConflict = sync === 'Conflict' || sync === 'Conflict (missing in repo)';
    const wasMissing = sync === 'Missing in Repo' || sync === 'Conflict (missing in repo)';
    const statusesDisagree = sheetStatus !== '' && sheetStatus !== item.status;

    // A NEW conflict is a true 3-way disagreement: both sides moved away from the last synced
    // value and landed somewhere different. "Human ahead of a stable repository" (a person
    // marks an open TODO In Progress) is normal and must NOT be a conflict, or almost every
    // in-progress row would be flagged.
    const bothMoved = repoChangedStatus && humanChangedStatus && statusesDisagree;
    // An EXISTING conflict persists until a human makes the sheet agree. It is carried by the
    // Conflict marker itself - which now survives the missing state - and NOT by "this row was
    // missing", which records absence and says nothing about who disagreed with whom. Deriving
    // it from absence turned every ordinary disappear-and-return into a sticky false conflict.
    const carriedConflict = statusesDisagree && alreadyConflict;
    const conflicted = bothMoved || carriedConflict;

    // Human Review is shared, so it needs the same three-way treatment as Status: compare the
    // sheet against what WE last wrote. If they differ, a person deliberately (un)checked it,
    // and that decision outranks our recomputation.
    const sheetReview = row.cells['Human Review'] === true;
    // Prefer the sheet's own mirror column over the local cache, exactly as `Repo Status` is
    // preferred over `st.lastWrittenStatus`: a lost state file must not change any decision.
    const reviewBaseline = typeof row.cells['Repo Review'] === 'boolean'
      ? (row.cells['Repo Review'] as boolean)
      : st?.lastWrittenHumanReview;
    let reviewAfterUpdate: boolean;
    if (reviewBaseline !== undefined) {
      // We know what we last wrote: if the sheet differs, a person changed it and wins.
      reviewAfterUpdate = sheetReview !== reviewBaseline ? sheetReview : item.humanReviewRequired;
    } else {
      // Truly no baseline (a sheet from before `Repo Review` existed, and no state file). We
      // cannot tell our tick from a person's, so keep it: leaving a stale flag costs one
      // glance, clearing a real one loses a decision silently.
      reviewAfterUpdate = sheetReview || item.humanReviewRequired;
    }

    if (!repoChanged) {
      // The repository has not moved. Two things can still legitimately need a write:
      // a row that must come back from "Missing in Repo", and a conflict a human has
      // now resolved by making the sheet agree.
      if (wasMissing) {
        // Back and byte-identical. Fingerprint equality alone would say "unchanged" and
        // leave the row flagged missing forever. If the human's Status still disagrees
        // with the repository, this is a live conflict - never label it Synced.
        const syncStatus: SyncStatus = conflicted ? 'Conflict' : 'Synced';
        const reason = conflicted
          ? `item reappeared with the conflict still unresolved: sheet says "${sheetStatus}", repo says "${item.status}"`
          : 'item reappeared in the repository unchanged; clearing "Missing in Repo"';
        changes.push({
          action: conflicted ? 'conflict' : 'update',
          item,
          rowId: row.rowId,
          cells: { ...repoCells(item, syncStatus, now), ...sharedCells(sheetStatus !== '' ? (sheetStatus as Status) : item.status, conflicted || reviewAfterUpdate) },
          reasons: [reason],
        });
        continue;
      }

      if (alreadyConflict && !statusesDisagree) {
        // The human resolved it by matching the repository. Nothing else changed, so this
        // is the ONLY moment we can clear the flag - waiting for a repo change would leave
        // the row conflicted forever.
        changes.push({
          action: 'update',
          item,
          rowId: row.rowId,
          cells: { ...repoCells(item, 'Synced', now), ...sharedCells(item.status, reviewAfterUpdate) },
          reasons: ['conflict resolved: the sheet now agrees with the repository'],
        });
        continue;
      }

      if (humanClearedStatus) {
        // Someone emptied the Status cell. A blank Status breaks every report and rollup, so
        // the repository value goes back - but loudly, flagged, and never silently.
        changes.push({
          action: 'update',
          item,
          rowId: row.rowId,
          cells: { ...repoCells(item, 'Updated', now), ...sharedCells(item.status, true) },
          reasons: [`Status had been cleared in the sheet; restored "${item.status}" from the repository and flagged for review`],
        });
        continue;
      }
      changes.push({ action: 'unchanged', item, rowId: row.rowId, cells: {}, reasons: [alreadyConflict ? 'fingerprint matches; conflict still unresolved' : 'fingerprint matches'] });
      continue;
    }

    const reasons: string[] = ['repo-controlled fields changed'];
    if (wasMissing) reasons.push('item reappeared in the repository');

    // A conflict is a live disagreement between the two Status values - nothing else.
    //
    // Earlier versions inferred it from the `Sync Status` LABEL, which is unreliable: when a
    // conflicted row is flagged "Missing in Repo" the Conflict marker is overwritten, so a
    // conflicted item that vanished and came back changed looked like an ordinary update
    // while the human and the repository still disagreed. Deriving the state from the values
    // themselves makes every combination of (repoChanged, wasMissing, alreadyConflict)
    // behave the same way, and makes resolution detectable on every path.
    let action: PlannedChange['action'];
    let syncStatus: SyncStatus;
    let status: Status;
    let humanReview: boolean;

    if (conflicted) {
      // The human's value always wins and ours is surfaced in Repo Status.
      action = 'conflict';
      syncStatus = 'Conflict';
      status = sheetStatus as Status;
      humanReview = true;
      reasons.push(
        carriedConflict && !bothMoved
          ? `conflict still unresolved: sheet says "${sheetStatus}", repo says "${item.status}"`
          : `status conflict: sheet says "${sheetStatus}", repo says "${item.status}", last synced "${lastWrittenStatus || '(none)'}"`,
      );
    } else {
      action = 'update';
      syncStatus = 'Updated';
      // A human who moved Status while the repository stayed put is ahead, not wrong.
      status = humanChangedStatus && sheetStatus !== '' ? (sheetStatus as Status) : item.status;
      if (humanClearedStatus) {
        reasons.push(`Status had been cleared in the sheet; restored "${item.status}" from the repository`);
      }
      // Recompute Human Review from the item UNLESS a human moved the checkbox themselves.
      // Carrying our own stale value forward leaves a resolved row flagged forever; blindly
      // resetting it erases a person's deliberate "look at this".
      // A restored Status is something a person should see, whatever the item itself says.
      humanReview = humanClearedStatus ? true : reviewAfterUpdate;
      if (alreadyConflict) reasons.push('conflict resolved: the sheet now agrees with the repository');
      else if (humanChangedStatus) reasons.push(`kept human status "${sheetStatus}"`);
      else if (repoChangedStatus) reasons.push(`status ${lastWrittenStatus || '(none)'} → ${item.status}`);
    }

    changes.push({ action, item, rowId: row.rowId, cells: { ...repoCells(item, syncStatus, now), ...sharedCells(status, humanReview) }, reasons });
  }

  for (const [id, row] of byItemId) {
    if (seen.has(id)) continue;
    const sync = String(row.cells['Sync Status'] ?? '');
    if (sync === 'Conflict (missing in repo)') {
      // A human can resolve a conflict on a row whose item is gone for good. If they have made
      // Status agree with what the repository last said, downgrade to plain "Missing in Repo" -
      // otherwise the conflict marker is stuck forever on an item that will never return.
      const sheetStatus = String(row.cells['Status'] ?? '');
      const repoStatus = String(row.cells['Repo Status'] ?? '');
      if (sheetStatus !== '' && repoStatus !== '' && sheetStatus === repoStatus) {
        // Clearing the review flag here is only safe when the flag is still OURS. If the sheet
        // checkbox no longer matches the value we last wrote, a person moved it deliberately
        // and it is not ours to reset - the same rule the present-item path follows.
        const sheetReview = row.cells['Human Review'] === true;
        const ourReview = typeof row.cells['Repo Review'] === 'boolean' ? (row.cells['Repo Review'] as boolean) : undefined;
        const keepReview = ourReview !== undefined && sheetReview !== ourReview ? sheetReview : false;
        changes.push({
          action: 'missing',
          item: { itemId: id, item: String(row.cells['Item'] ?? id) } as ProjectItem,
          rowId: row.rowId,
          cells: { 'Sync Status': 'Missing in Repo', 'Human Review': keepReview, 'Repo Review': keepReview, 'Last Synced': now },
          reasons: ['conflict resolved by a human; the item is still gone from the repository'],
        });
      }
      continue;
    }
    if (sync === 'Missing in Repo') continue; // already flagged
    // Flagging a CONFLICTED row as missing must not erase the conflict: it is still unresolved,
    // and the human's decision is the thing most worth preserving. Record both facts.
    const wasConflict = sync === 'Conflict';
    const label: SyncStatus = wasConflict ? 'Conflict (missing in repo)' : 'Missing in Repo';
    const ghost = { itemId: id, item: String(row.cells['Item'] ?? id) } as ProjectItem;
    // `Repo Review` must move with `Human Review`. Without it the next run sees our own tick
    // sitting against a stale `false` baseline, calls it a human edit, and strands it checked.
    changes.push({ action: 'missing', item: ghost, rowId: row.rowId, cells: { 'Sync Status': label, 'Human Review': true, 'Repo Review': true, 'Last Synced': now }, reasons: [wasConflict ? 'item no longer found in repository; the unresolved conflict is kept too' : 'item no longer found in repository; row kept for a human to close or merge'] });
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
    // Not dead state: this is the baseline that tells OUR checkbox from a human's.
    lastWrittenHumanReview: (c.cells as CellValues)['Human Review'] === true,
    lastSyncedAt: now,
  };
}
