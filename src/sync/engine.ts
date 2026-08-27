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
import { humanSeedCells, repoCells, reviewCells, sharedCells, trunc } from '../adapters/smartsheet/mapper.js';
import type { SheetTarget, TargetRow, CellValues } from './target.js';
import type { SyncState } from './state.js';
import { log } from '../log/logger.js';

/**
 * Who owns the Human Review checkbox right now, and what we are allowed to write to it.
 *
 * There are two records of what WE last wrote: the local cache and the sheet's `Repo Review`
 * mirror. Either can go stale - the cache can be rolled back, copied between machines or
 * interrupted; the mirror can be hand-edited, or added late to an older sheet. Every previous
 * attempt at this picked one of them to trust and simply moved the lost decision to the other
 * direction, so this is the single rule, used by every path that touches the checkbox.
 *
 * - No baseline at all: we cannot tell our tick from a person's. Do not touch the visible
 *   checkbox; adopt whatever it says as the baseline so later runs have one. Writing it and
 *   recording it as ours is what let a later run reverse a real decision.
 * - Two baselines that disagree WITH EACH OTHER: that is technical drift, not a human edit -
 *   they cannot both be right. Preserve what the sheet shows, and re-point both baselines at
 *   it so the drift stops recurring. This is the only way out of a stale mirror that would
 *   otherwise suppress a required flag forever.
 * - Otherwise: the box is ours to recompute only if the sheet still agrees with the baseline.
 *   If it differs, a person moved it - in EITHER direction - and it is theirs from then on.
 */
function reviewRule(sheetReview: boolean, cache: boolean | undefined, mirror: boolean | undefined): {
  baseline: boolean | undefined;
  humanOwns: boolean;
  /** True when the two records of OUR value disagree and the mirror is being re-pointed. */
  drift: boolean;
  write: (want: boolean) => CellValues;
} {
  const baselines = [cache, mirror].filter((b): b is boolean => b !== undefined);
  if (baselines.length === 0) {
    // We have no record of ever writing this cell, so we cannot claim its value - and we must
    // not adopt it as ours either: that only delays the loss by one run, because the next run
    // sees the sheet agreeing with a baseline it thinks is its own and recomputes over it.
    // Leave both cells alone. Only rows that predate the mirror column can be in this state.
    return { baseline: undefined, humanOwns: true, drift: false, write: () => ({}) };
  }
  if (baselines.length === 2 && baselines[0] !== baselines[1]) {
    // Technical drift: the two records of OUR value disagree, so they cannot both be right and
    // this is not a human edit. Preserve what the sheet shows and re-point the mirror at it, so
    // the next run has one agreed baseline. Without this, a stale mirror could stop the tool
    // ever flagging a row its own model says needs review.
    return { baseline: sheetReview, humanOwns: true, drift: true, write: () => ({ 'Repo Review': sheetReview }) };
  }
  const baseline = baselines[0];
  const humanOwns = sheetReview !== baseline;
  return { baseline, humanOwns, drift: false, write: (want) => (humanOwns ? {} : reviewCells(want)) };
}

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

  // Two items must never both write one row. Identities are supposed to be unique, but a
  // 48-bit digest can in principle collide, and when it does the second item silently wins
  // while the first item's Owner and Management Notes stay attached to work that is not
  // theirs. Neither item is written until a person separates them.
  const itemsPerId = new Map<string, number>();
  for (const it of items) itemsPerId.set(it.itemId, (itemsPerId.get(it.itemId) ?? 0) + 1);
  const contestedIds = new Set([...itemsPerId].filter(([, n]) => n > 1).map(([id]) => id));
  if (contestedIds.size) {
    log.warn(`${contestedIds.size} Item ID(s) are claimed by more than one repository item: ${[...contestedIds].join(', ')}. Those items are left untouched - writing either one would attach it to the other's row. Please report this: it means two different items produced the same identity digest.`);
  }

  for (const item of items) {
    seen.add(item.itemId);
    if (contestedIds.has(item.itemId)) {
      changes.push({ action: 'unchanged', item, cells: {}, reasons: [`skipped: another repository item produced the same Item ID ${item.itemId}, so neither can be written safely`] });
      continue;
    }
    if (duplicateIds.has(item.itemId)) {
      // Not a create either - that would add a third row with the same identity.
      changes.push({ action: 'unchanged', item, cells: {}, reasons: [`skipped: ${allRowsForId.get(item.itemId)?.length ?? 2} sheet rows claim Item ID ${item.itemId}, so no update can be applied safely. Delete the extra copies; if they are genuinely different items, this is a digest collision and should be reported.`] });
      continue;
    }
    const row = byItemId.get(item.itemId);
    // Compare the machine-readable `Repo Path`, never the human-readable `Source`. Source is
    // `path[:line] - evidence type`, and a filename may contain those separators, so no amount
    // of parsing tells the two apart: `src/a.ts - evil.ts` is a real file whose Source begins
    // exactly like `src/a.ts`.
    //
    // The column is required, so a sheet without it is refused before we ever get here. A blank
    // VALUE means "written by a build older than the column" - and the only way to believe that
    // of THIS item is a fingerprint that matches what this item computes to right now. A
    // well-formed fingerprint is not enough: any twelve hex characters can be typed into a cell,
    // and the one thing that cannot be guessed is the item's own content.
    //
    // The cost is deliberate. If such a row's content also changed since the last sync there is
    // no proof left, and the row is left alone with an explanation rather than written over -
    // the same choice made about matching old rows generally.
    const rowPath = String(row?.cells['Repo Path'] ?? '');
    const rowIsOurs = String(row?.cells['Repo Fingerprint'] ?? '') === item.fingerprint;
    if (row && (rowPath === '' ? !rowIsOurs : rowPath !== item.repositoryPath)) {
      // The row carries this Item ID but points at a different file. Identity always includes
      // the path, so this cannot be the same item: the ID was hand-edited, or two identities
      // collided. Either way, writing this item's content over that row would destroy whatever
      // it actually describes, along with the Owner and Notes somebody put on it.
      changes.push({ action: 'unchanged', item, cells: {}, reasons: [`skipped: the sheet row using Item ID ${item.itemId} is for a different file (${rowPath || 'no recorded path, and nothing on it proves this tool wrote it for this item'}), so it is not this item. Fix or remove that row and re-run.`] });
      continue;
    }
    if (!row) {
      changes.push({ action: 'create', item, cells: { ...repoCells(item, 'New', now), ...humanSeedCells(item), ...sharedCells(item.status), ...reviewCells(item.humanReviewRequired) }, reasons: ['not in sheet yet'] });
      continue;
    }
    // Carry the cached baselines across the rename, or adoption would look like a row we have
    // never written - which is exactly the "no baseline, never converges" state below.
    //
    // When we adopt, the cache that belongs to the row IN FRONT OF US is the one filed under
    // the OLD id. A cache under the new id describes a different physical row (one an earlier
    // split created and a person has since deleted), and preferring it made the two records
    // disagree, which reads as drift and ends up clearing a real human tick two runs later.
    // Every cache entry records the physical `rowId` it describes. Use it: an entry filed
    // under either id may belong to a DIFFERENT row (one an earlier split created and a person
    // has since deleted), and believing it reads as drift and clears a real human tick.
    const cacheCandidates = [state.items[item.itemId]].filter((c): c is NonNullable<typeof c> => c !== undefined);
    const st = cacheCandidates.find((c) => c.rowId === row.rowId) ?? cacheCandidates[0];
    // A cache that describes some other row tells us nothing about what we wrote to THIS one.
    const stForReview = cacheCandidates.find((c) => c.rowId === row.rowId);
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
    // Adoption must go through the SAME three-way merge as everything else. Writing repoCells
    // and returning early overwrote `Repo Status` and the fingerprint before the merge ran,
    // which permanently laundered a genuine both-sides-moved conflict into "Synced". Treating
    // it as a change also guarantees the write happens - the fingerprint matches, so the
    // ordinary path would call it unchanged and leave the old ID on the sheet forever.
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
    // Once we have raised something on this row, the checkbox belongs to the person from then
    // on and we never write it again - ticked or not. Ending the raise when they untick it was
    // not a dismissal at all: the ownership rule then found the baselines agreeing with the now
    // empty box, called it ours, and re-ticked it on any item the model wants reviewed. A
    // dismissal has to be permanent to mean anything.
    //
    // The cost is that this tool cannot flag that row again by itself, which is the same trade
    // made for rows with no baseline at all: a stale flag costs a glance, an unwanted one that
    // keeps coming back costs trust.
    const raiseOutstanding = stForReview?.reviewRaisedForHuman === true;
    const rule = raiseOutstanding
      ? { baseline: undefined as boolean | undefined, humanOwns: true, drift: false, write: () => ({}) }
      : reviewRule(
      sheetReview,
      stForReview?.lastWrittenHumanReview,
      typeof row.cells['Repo Review'] === 'boolean' ? (row.cells['Repo Review'] as boolean) : undefined,
    );
    const humanOwnsReview = rule.humanOwns;
    const writeReview = rule.write;
    // A row that is STILL in conflict still needs a person, and that has to be part of the
    // desired value. Deriving it from the item alone meant the conflict write ticked the box on
    // run one and the convergence repair unticked it on run two, leaving the row labelled
    // Conflict but absent from every "needs my attention" filter - which is the one thing the
    // flag is for.
    const reviewAfterUpdate = humanOwnsReview ? sheetReview : (item.humanReviewRequired || conflicted);

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
      if (repoChangedStatus) {
        // `Repo Status` disagrees with the repository while the fingerprint says the item has
        // not moved. The fingerprint covers Status, so a current fingerprint PROVES the
        // repository did not move - the mirror is simply stale (hand-edited, imported, written
        // by an older build). Repair it.
        //
        // An earlier version declared a conflict here instead. That was wrong at the root: it
        // trusted the stale mirror over a cache that recorded the true last value, and turned
        // ordinary rows into conflicts that then stuck. With the repository provably still, a
        // human sitting on a different Status is just ahead of it, which is normal.
        // A current fingerprint says the repository did not move, but it is not proof that the
        // row's history was atomic: an interrupted or imported write could have set the
        // fingerprint while leaving the old baseline behind, and then a real disagreement is
        // sitting in front of us wearing the same clothes as ordinary drift. We cannot tell
        // them apart - so repair quietly ONLY when nobody is disagreeing, and otherwise repair
        // and put it in front of a person instead of silently choosing an interpretation.
        const somebodyDisagrees = sheetStatus !== '' && sheetStatus !== item.status;
        changes.push({
          action: 'update',
          item,
          rowId: row.rowId,
          cells: {
            'Repo Status': item.status,
            'Last Synced': now,
            // Tick the box, move the mirror with it, and record separately that WE raised it
            // (see `reviewRaisedForHuman` in the state file). The mirror matters if the local
            // file is later lost: a dismissal then reads as false against a true mirror, which
            // every ownership rule calls the person's, so their decision still survives. The
            // separate flag is what makes the raise durable while the file exists - one boolean
            // cannot say both what the value is and who set it.
            ...(somebodyDisagrees ? { 'Human Review': true, 'Repo Review': true } : {}),
          },
          reviewRaisedForHuman: somebodyDisagrees,
          reasons: somebodyDisagrees
            ? [`Repo Status said "${lastWrittenStatus || '(none)'}" while the repository has not moved from "${item.status}", and the sheet says "${sheetStatus}". Repaired the stale value and flagged the row: your value is kept, but check whether it still reflects reality.`]
            : [`repaired a stale Repo Status: the sheet said "${lastWrittenStatus || '(none)'}" but the repository has not moved from "${item.status}"`],
        });
        continue;
      }

      // A row from an older build has no `Repo Path`, and Source is excluded from the
      // fingerprint so it can drift without anything noticing. Neither is worth a full update -
      // and a full update here would rewrite the merge baselines, which is how a real conflict
      // got destroyed two rounds ago - so repair exactly those two cells and nothing else.
      const backfill: CellValues = {};
      if (rowPath !== item.repositoryPath) backfill['Repo Path'] = item.repositoryPath;
      // Compare and write the value a cell can actually hold. Comparing the raw one against a
      // stored, truncated one never matched, so an overlong Source planned the same repair on
      // every single run.
      const storedSource = String(trunc(item.sourceReference) ?? '');
      if (String(row.cells['Source'] ?? '') !== storedSource) backfill['Source'] = storedSource;
      if (Object.keys(backfill).length) {
        changes.push({
          action: 'update',
          item,
          rowId: row.rowId,
          cells: { ...backfill, 'Last Synced': now },
          reasons: ['brought the recorded path and source line back into step with the repository'],
        });
        continue;
      }

      // Nothing repo-controlled changed - but the checkbox may still be waiting to converge.
      // Drift repair only re-points the mirror, so without this the visible value would stay
      // wrong until some unrelated repository change happened to come along.
      const pendingReview = writeReview(reviewAfterUpdate);
      // Drift must be repaired even when the mirror ALREADY shows the visible value: in that
      // case the write changes no cell, but it is the only thing that makes `remember()` run
      // and bring the local cache back into line. Without it the two records disagree forever.
      const reviewChanges = rule.drift || Object.entries(pendingReview).some(([k, v]) => row.cells[k] !== v);
      if (reviewChanges) {
        // ONLY the review cells. `repoCells` would rewrite `Repo Status` and `Repo Fingerprint`
        // - the merge baselines - for what is a checkbox repair, and on a row whose Status
        // baseline was stale that silently destroyed a real both-sides-moved conflict. A
        // targeted repair must stay targeted.
        changes.push({
          action: 'update',
          item,
          rowId: row.rowId,
          cells: { ...pendingReview, 'Last Synced': now },
          reasons: ['review flag brought back into line with the item'],
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
        // The SAME rule as the present-item paths - not a second copy of it. Selecting one
        // baseline with `??` here let a stale cache hide a disagreeing mirror (and vice versa),
        // which overwrote a human clear on one path and a human tick on the other.
        const absentRule = state.items[id]?.reviewRaisedForHuman === true
          ? { baseline: undefined as boolean | undefined, humanOwns: true, drift: false, write: () => ({}) }
          : reviewRule(
          row.cells['Human Review'] === true,
          state.items[id]?.lastWrittenHumanReview,
          typeof row.cells['Repo Review'] === 'boolean' ? (row.cells['Repo Review'] as boolean) : undefined,
        );
        changes.push({
          action: 'missing',
          item: { itemId: id, item: String(row.cells['Item'] ?? id) } as ProjectItem,
          rowId: row.rowId,
          cells: { 'Sync Status': 'Missing in Repo', ...absentRule.write(false), 'Last Synced': now },
          reasons: ['conflict resolved by a human; the item is still gone from the repository'],
        });
      }
      continue;
    }
    if (sync === 'Missing in Repo') {
      // Already flagged, so there is nothing to say about its Status - but the checkbox can
      // still be mid-convergence after drift repair, and this loop is the ONLY thing that ever
      // looks at this row again. Let the shared rule finish what it started.
      // ONLY repair drift here. The row is already flagged, so its visible checkbox is either
      // ours from the flagging or a decision a person has since made - either way this pass has
      // no business changing it. Re-deriving a desired value would re-tick a box a human
      // cleared when they resolved the row.
      const rule = reviewRule(
        row.cells['Human Review'] === true,
        state.items[id]?.lastWrittenHumanReview,
        typeof row.cells['Repo Review'] === 'boolean' ? (row.cells['Repo Review'] as boolean) : undefined,
      );
      const pending = rule.drift ? rule.write(true) : {};
      // As on the present-item path, drift must be repaired even when the write changes no
      // visible cell: that write is the only thing that makes `remember()` run and bring the
      // local cache back into line.
      const differs = rule.drift || Object.entries(pending).some(([k, v]) => row.cells[k] !== v);
      if (differs) {
        changes.push({
          action: 'missing',
          item: { itemId: id, item: String(row.cells['Item'] ?? id) } as ProjectItem,
          rowId: row.rowId,
          cells: { ...pending, 'Last Synced': now },
          reasons: ['still missing; review flag brought back into line'],
        });
      }
      continue;
    }
    // Flagging a CONFLICTED row as missing must not erase the conflict: it is still unresolved,
    // and the human's decision is the thing most worth preserving. Record both facts.
    const wasConflict = sync === 'Conflict';
    const label: SyncStatus = wasConflict ? 'Conflict (missing in repo)' : 'Missing in Repo';
    const ghost = { itemId: id, item: String(row.cells['Item'] ?? id) } as ProjectItem;
    // `Repo Review` must move with `Human Review` when WE tick it - otherwise the next run
    // reads our own tick as a human edit and strands it. But if the box is already ticked we
    // write neither, so a person's tick stays theirs.
    // The absent path has to honour a raise as well. It did not, so a person could dismiss a
    // raised row, the item could then disappear, and the tool would tick the box straight back.
    const reviewWrite: CellValues = state.items[id]?.reviewRaisedForHuman === true ? {} : reviewRule(
      row.cells['Human Review'] === true,
      state.items[id]?.lastWrittenHumanReview,
      typeof row.cells['Repo Review'] === 'boolean' ? (row.cells['Repo Review'] as boolean) : undefined,
    ).write(true);
    changes.push({ action: 'missing', item: ghost, rowId: row.rowId, cells: { 'Sync Status': label, ...reviewWrite, 'Last Synced': now }, reasons: [wasConflict ? 'item no longer found in repository; the unresolved conflict is kept too' : 'item no longer found in repository; row kept for a human to close or merge'] });
    }
  }

  const counts = { create: 0, update: 0, unchanged: 0, conflict: 0, missing: 0 };
  for (const c of changes) counts[c.action]++;
  // Count identities, not rows: one item represented by two duplicate rows is still one item
  // needing a person, and reporting it twice overstates the work.
  const humanReviewCount = new Set(
    changes.filter((c) => c.action !== 'unchanged' && c.cells['Human Review'] === true).map((c) => c.item.itemId),
  ).size;
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
      const wrote = (c.cells as CellValues)['Human Review'] ?? (c.cells as CellValues)['Repo Review'];
      if (st && wrote !== undefined) {
        st.lastWrittenHumanReview = wrote === true;
        st.lastSyncedAt = now;
      }
    }
    log.info(`Updated ${updated} row${updated === 1 ? '' : 's'} in the sheet.`);
  }
  state.lastRunAt = now;
  return { created, updated };
}

/** Has this row ever been raised with a person? Once true it stays true - see `raiseOutstanding`. */
function raiseStillStanding(state: SyncState, c: PlannedChange, rowId: number): boolean {
  const prev = state.items[c.item.itemId];
  return prev !== undefined && prev.rowId === rowId && prev.reviewRaisedForHuman === true;
}

function remember(state: SyncState, c: PlannedChange, rowId: number, now: string): void {
  // What WE last wrote to the checkbox, carried forward when this write deliberately left the
  // cell alone. It must come from the entry describing THIS physical row: an entry under either
  // id can belong to a row an earlier split created and a person has since deleted, and reading
  // that one put a stale value straight back after planning had correctly ignored it.
  const prev = state.items[c.item.itemId];
  const carried = prev !== undefined && prev.rowId === rowId ? prev.lastWrittenHumanReview : undefined;
  state.items[c.item.itemId] = {
    rowId,
    fingerprint: c.item.fingerprint,
    lastWrittenStatus: String((c.cells as CellValues)['Repo Status'] ?? c.item.status),
    // Not dead state: this is the baseline that tells OUR checkbox from a human's. It may
    // only move when we ACTUALLY wrote the cell - recording `false` because we deliberately
    // left the cell alone would erase the very ownership we were trying to preserve.
    // Only move when we ACTUALLY wrote something: recording a value we deliberately left
    // alone would erase the ownership we were preserving. A write of `Repo Review` on its own
    // is the adopt case - the baseline moves, the visible checkbox does not.
    // A tick we raised for a person is not ours: leaving the baseline where it was makes the
    // sheet and the baseline disagree, which is exactly how the ownership rule records "theirs".
    reviewRaisedForHuman: c.reviewRaisedForHuman ? true : (raiseStillStanding(state, c, rowId) || undefined),
    // A raise writes both the box and the mirror, so record that: the two agreeing is what
    // makes a later dismissal read as the person's, even if this file is lost first.
    lastWrittenHumanReview: c.reviewRaisedForHuman
      ? true
      : (c.cells as CellValues)['Human Review'] !== undefined
      ? (c.cells as CellValues)['Human Review'] === true
      : (c.cells as CellValues)['Repo Review'] !== undefined
        ? (c.cells as CellValues)['Repo Review'] === true
        : carried,
    lastSyncedAt: now,
  };
}
