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
import { humanSeedCells, repoCells, reviewCells, sharedCells } from '../adapters/smartsheet/mapper.js';
import type { SheetTarget, TargetRow, CellValues } from './target.js';
import type { SyncState } from './state.js';
import { log } from '../log/logger.js';

export function planSync(items: ProjectItem[], rows: TargetRow[], state: SyncState, now: string): SyncPlan {
  const byItemId = new Map<string, TargetRow>();
  const allRowsForId = new Map<string, TargetRow[]>();
  const duplicateIds = new Set<string>();
  for (const r of rows) {
    const id = r.cells['Item ID'];
    if (typeof id !== 'string' || !id) continue;
    if (byItemId.has(id)) duplicateIds.add(id); // two rows claim the same identity
    byItemId.set(id, r);
    // Keep them ALL. Remembering only the last is what let two items take turns overwriting
    // one row, and it also left every earlier copy of a vanished item falsely alive.
    const list = allRowsForId.get(id);
    if (list) list.push(r); else allRowsForId.set(id, [r]);
  }
  if (duplicateIds.size) {
    // Writing to one of several rows that claim the same Item ID is worse than doing nothing:
    // the map keeps only the last, so two different items would take turns overwriting one
    // row's evidence, flipping it on every run. Leave those rows completely alone and say so.
    log.warn(`${duplicateIds.size} Item ID(s) appear on more than one row: ${[...duplicateIds].join(', ')}. Those rows are left untouched until a human resolves them - writing to them would overwrite one item's evidence with another's. If they are copies of one row, delete the extras. If they are genuinely different items that share an ID, that is a digest collision: please report it, because deleting a row will not help.`);
  }

  const changes: PlannedChange[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    seen.add(item.itemId);
    if (duplicateIds.has(item.itemId)) {
      // Not a create either - that would add a third row with the same identity.
      changes.push({ action: 'unchanged', item, cells: {}, reasons: [`skipped: ${allRowsForId.get(item.itemId)?.length ?? 2} sheet rows claim Item ID ${item.itemId}, so no update can be applied safely. Delete the extra copies; if they are genuinely different items, this is a digest collision and should be reported.`] });
      continue;
    }
    const row = byItemId.get(item.itemId);
    if (!row) {
      changes.push({ action: 'create', item, cells: { ...repoCells(item, 'New', now), ...humanSeedCells(item), ...sharedCells(item.status), ...reviewCells(item.humanReviewRequired) }, reasons: ['not in sheet yet'] });
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
    // There are two records of what WE last wrote to this checkbox - the local cache and the
    // sheet's own `Repo Review` mirror - and EITHER can be stale: the cache can be rolled back,
    // copied between machines or interrupted mid-write, and the mirror can be hand-edited or
    // added late to an old sheet. Preferring one over the other only moves the lost decision
    // from one direction to the other, so trust neither alone.
    //
    // The rule: the box is ours to recompute only when EVERY baseline we have agrees with what
    // the sheet says now. If any of them disagrees, someone moved it and it is theirs. That is
    // conservative in the one direction that matters - a stale flag costs somebody a glance, a
    // cleared one loses a decision silently.
    const reviewBaselines = [
      st?.lastWrittenHumanReview,
      typeof row.cells['Repo Review'] === 'boolean' ? (row.cells['Repo Review'] as boolean) : undefined,
    ].filter((b): b is boolean => b !== undefined);
    const reviewBaseline: boolean | undefined = reviewBaselines[0];
    const humanOwnsReview = reviewBaselines.some((b) => b !== sheetReview);
    // Once a person moves it, we stop writing the cell at all - in either direction. Protecting
    // their ticks but not their clears meant a clear was recorded as our own baseline and then
    // re-ticked by the next ordinary update. This mirrors how Priority and Owner already work:
    // seeded once, then hands off.
    const writeReview = (want: boolean): CellValues => (humanOwnsReview ? {} : reviewCells(want));
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
        const reasons = [conflicted
          ? `item reappeared with the conflict still unresolved: sheet says "${sheetStatus}", repo says "${item.status}"`
          : 'item reappeared in the repository unchanged; clearing "Missing in Repo"'];
        // A cleared Status must be reported here too, not only on the plain path below.
        if (humanClearedStatus) reasons.push(`Status had been cleared in the sheet; restored "${item.status}" from the repository`);
        changes.push({
          action: conflicted ? 'conflict' : 'update',
          item,
          rowId: row.rowId,
          cells: {
            ...repoCells(item, syncStatus, now),
            ...sharedCells(sheetStatus !== '' ? (sheetStatus as Status) : item.status),
            ...writeReview(conflicted || humanClearedStatus || reviewAfterUpdate),
          },
          reasons,
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
          cells: {
            ...repoCells(item, 'Synced', now),
            ...sharedCells(item.status),
            ...writeReview(humanClearedStatus || reviewAfterUpdate),
          },
          reasons: humanClearedStatus
            ? ['conflict resolved: the sheet now agrees with the repository', `Status had been cleared in the sheet; restored "${item.status}" from the repository`]
            : ['conflict resolved: the sheet now agrees with the repository'],
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
          cells: { ...repoCells(item, 'Updated', now), ...sharedCells(item.status), ...writeReview(true) },
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

    changes.push({ action, item, rowId: row.rowId, cells: {
      ...repoCells(item, syncStatus, now),
      ...sharedCells(status),
      ...writeReview(humanReview),
    }, reasons });
  }

  for (const [id, rowsForId] of allRowsForId) {
    if (seen.has(id)) continue;
    for (const row of rowsForId) {
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
        // Same rule as the present-item paths: if the person moved the checkbox, it is theirs
        // and we write neither cell. Writing both to one value here relabelled their tick as
        // ours, and the next run then cleared it.
        const sheetReview = row.cells['Human Review'] === true;
        const ourReview = state.items[id]?.lastWrittenHumanReview
          ?? (typeof row.cells['Repo Review'] === 'boolean' ? (row.cells['Repo Review'] as boolean) : undefined);
        const humanOwns = ourReview !== undefined && sheetReview !== ourReview;
        changes.push({
          action: 'missing',
          item: { itemId: id, item: String(row.cells['Item'] ?? id) } as ProjectItem,
          rowId: row.rowId,
          cells: { 'Sync Status': 'Missing in Repo', ...(humanOwns ? {} : reviewCells(false)), 'Last Synced': now },
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
    // `Repo Review` must move with `Human Review` when WE tick it - otherwise the next run
    // reads our own tick as a human edit and strands it. But if the box is already ticked we
    // write neither, so a person's tick stays theirs.
    const sheetReviewNow = row.cells['Human Review'] === true;
    const ourReviewNow = state.items[id]?.lastWrittenHumanReview
      ?? (typeof row.cells['Repo Review'] === 'boolean' ? (row.cells['Repo Review'] as boolean) : undefined);
    const humanOwnsNow = ourReviewNow !== undefined && sheetReviewNow !== ourReviewNow;
    const reviewWrite: CellValues = humanOwnsNow ? {} : reviewCells(true);
    changes.push({ action: 'missing', item: ghost, rowId: row.rowId, cells: { 'Sync Status': label, ...reviewWrite, 'Last Synced': now }, reasons: [wasConflict ? 'item no longer found in repository; the unresolved conflict is kept too' : 'item no longer found in repository; row kept for a human to close or merge'] });
    }
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
    for (const c of updates) {
      if (c.action !== 'missing') { remember(state, c, c.rowId!, now); continue; }
      // A missing write carries no fingerprint (the item is gone), so it must not call
      // remember() - but when it ticks the review box it MUST record that it did, or the
      // cache goes stale and the next run reads our own tick as a human edit.
      const st = state.items[c.item.itemId];
      if (st && (c.cells as CellValues)['Human Review'] !== undefined) {
        st.lastWrittenHumanReview = (c.cells as CellValues)['Human Review'] === true;
        st.lastSyncedAt = now;
      }
    }
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
    // Not dead state: this is the baseline that tells OUR checkbox from a human's. It may
    // only move when we ACTUALLY wrote the cell - recording `false` because we deliberately
    // left the cell alone would erase the very ownership we were trying to preserve.
    lastWrittenHumanReview: (c.cells as CellValues)['Human Review'] === undefined
      ? state.items[c.item.itemId]?.lastWrittenHumanReview
      : (c.cells as CellValues)['Human Review'] === true,
    lastSyncedAt: now,
  };
}
