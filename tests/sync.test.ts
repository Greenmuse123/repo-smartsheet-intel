import { describe, it, expect, beforeEach } from 'vitest';
import { planSync, applyPlan } from '../src/sync/engine.js';
import { MemoryTarget } from '../src/sync/target.js';
import type { SyncState } from '../src/sync/state.js';
import { normalize } from '../src/model/normalize.js';
import { COLUMN_TITLES } from '../src/adapters/smartsheet/schema.js';
import type { ProjectItem, RawEvidence } from '../src/model/types.js';
import { log } from '../src/log/logger.js';

log.silent();

/** The Item ID an older build would have written: the same digest, cut to 8 hex characters. */
const oldStyleId = (itemId: string): string => itemId.slice(0, itemId.lastIndexOf('-') + 9);

const todoFor = (path: string): RawEvidence => ({ extractor: 'todo-comments', sourceType: 'TODO comment', path, line: 10, excerpt: 'TODO: add retry' });
const ev = (path: string, text: string, over: Partial<RawEvidence> = {}): RawEvidence => ({ extractor: 'todo-comments', sourceType: 'TODO comment', path, line: 1, excerpt: `TODO: ${text}`, ...over });
const items = (...e: RawEvidence[]): ProjectItem[] => normalize(e);
const T1 = '2026-08-24T10:00:00Z', T2 = '2026-08-24T11:00:00Z', T3 = '2026-08-24T12:00:00Z';

let target: MemoryTarget;
let state: SyncState;
beforeEach(() => { target = new MemoryTarget(COLUMN_TITLES, 'sheet-1'); state = { version: 1, sheetId: 'sheet-1', items: {} }; });

async function run(its: ProjectItem[], now: string) {
  const rows = await target.readRows();
  const plan = planSync(its, rows, state, now);
  await applyPlan(plan, target, state, now);
  return plan;
}

describe('idempotent sync', () => {
  it('first run creates rows; second identical run creates nothing and updates nothing', async () => {
    const its = items(ev('src/a.js', 'one'), ev('src/b.js', 'two'));
    const p1 = await run(its, T1);
    expect(p1.counts).toMatchObject({ create: 2, update: 0, unchanged: 0 });
    expect(target.rows).toHaveLength(2);
    const p2 = await run(its, T2);
    expect(p2.counts).toMatchObject({ create: 0, update: 0, unchanged: 2, conflict: 0, missing: 0 });
    expect(target.rows).toHaveLength(2);
    expect(target.writes).toBe(1);
  });
  it('rebuilds identity from the sheet alone when the local state file is lost', async () => {
    const its = items(ev('src/a.js', 'one'));
    await run(its, T1);
    state = { version: 1, sheetId: 'sheet-1', items: {} }; // simulate fresh clone
    const p = await run(its, T2);
    expect(p.counts.create).toBe(0);
    expect(target.rows).toHaveLength(1);
  });
});

describe('updates hit the right row', () => {
  it('a changed item updates its existing row (same Item ID) instead of adding one', async () => {
    await run(items(ev('src/a.js', 'one')), T1);
    const rowId = target.rows[0].rowId;
    const changed = items(ev('src/a.js', 'one', { commit: 'abc1234' })); // same identity, new repo-controlled data
    const p = await run(changed, T2);
    expect(p.counts).toMatchObject({ create: 0, update: 1 });
    expect(target.rows).toHaveLength(1);
    expect(target.rows[0].rowId).toBe(rowId);
    expect(target.rows[0].cells['Source Commit']).toBe('abc1234');
    expect(target.rows[0].cells['Sync Status']).toBe('Updated');
  });
});

describe('human fields are protected', () => {
  it('never overwrites Priority, Owner, Due Date or Management Notes after creation', async () => {
    await run(items(ev('src/a.js', 'one')), T1);
    Object.assign(target.rows[0].cells, { Priority: 'High', Owner: 'pm@example.com', 'Due Date': '2026-09-01', 'Management Notes': 'talk to Sam' });
    await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(target.rows[0].cells).toMatchObject({ Priority: 'High', Owner: 'pm@example.com', 'Due Date': '2026-09-01', 'Management Notes': 'talk to Sam', 'Source Commit': 'abc1234' });
  });
  it('keeps a human Status edit when the repo did not change status', async () => {
    await run(items(ev('src/a.js', 'one')), T1);
    target.rows[0].cells['Status'] = 'In Progress';
    await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(target.rows[0].cells['Status']).toBe('In Progress');
    expect(target.rows[0].cells['Sync Status']).toBe('Updated');
  });
});

describe('conflicts', () => {
  it('flags Conflict when human and repo both changed Status and disagree; human value wins', async () => {
    const check = (state: 'x' | ' ') => ({ extractor: 'readme-checklist', sourceType: state === 'x' ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)', path: 'README.md', line: 5, section: 'Roadmap', excerpt: 'ship it' } as RawEvidence);
    await run(normalize([check(' ')]), T1); // repo: Not Started
    target.rows[0].cells['Status'] = 'Blocked'; // human: Blocked
    const p = await run(normalize([check('x')]), T2); // repo now: Done
    expect(p.counts.conflict).toBe(1);
    const c = target.rows[0].cells;
    expect(c['Status']).toBe('Blocked');
    expect(c['Repo Status']).toBe('Done');
    expect(c['Sync Status']).toBe('Conflict');
    expect(c['Human Review']).toBe(true);
  });
});

describe('missing items', () => {
  it('rows whose item vanished are flagged, never deleted, and flagged only once', async () => {
    await run(items(ev('src/a.js', 'one'), ev('src/b.js', 'two')), T1);
    const p = await run(items(ev('src/a.js', 'one')), T2);
    expect(p.counts.missing).toBe(1);
    expect(target.rows).toHaveLength(2);
    const gone = target.rows.find((r) => r.cells['Item ID'] !== items(ev('src/a.js', 'one'))[0].itemId)!;
    expect(gone.cells['Sync Status']).toBe('Missing in Repo');
    expect(gone.cells['Human Review']).toBe(true);
    const p3 = await run(items(ev('src/a.js', 'one')), T3);
    expect(p3.counts.missing).toBe(0);
  });
});

describe('lifecycle after the happy path', () => {
  it('clears "Missing in Repo" when the item reappears unchanged (regression)', async () => {
    // Regression: fingerprint equality returned "unchanged" before the missing marker was
    // cleared, so a file that came back stayed flagged as missing forever.
    const a = ev('src/a.js', 'one'), b = ev('src/b.js', 'two');
    await run(items(a, b), T1);
    await run(items(a), T2);                       // b vanishes -> flagged
    const bId = items(b)[0].itemId;
    const gone = target.rows.find((r) => r.cells['Item ID'] === bId)!;
    expect(gone.cells['Sync Status']).toBe('Missing in Repo');

    const p = await run(items(a, b), T3);          // b comes back, byte-identical
    expect(p.counts.unchanged).toBeLessThan(2);
    const back = target.rows.find((r) => r.cells['Item ID'] === bId)!;
    expect(back.cells['Sync Status']).not.toBe('Missing in Repo');
    expect(back.cells['Sync Status']).toBe('Synced');
    expect(target.rows).toHaveLength(2);           // still never deleted or duplicated
  });

  it('keeps an unresolved conflict when a later, unrelated repo change lands (regression)', async () => {
    // Regression: alreadyConflict only appended a reason, so any later fingerprint change
    // silently downgraded Conflict to Updated while the two sides still disagreed.
    // Item ID is sha1(path|text), so the text must stay fixed to keep the SAME row; the
    // checked state moves Status and the section moves the fingerprint.
    const check = (state: 'x' | ' ', section = 'Roadmap') => ({
      extractor: 'readme-checklist',
      sourceType: state === 'x' ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
      path: 'README.md', line: 5, section, excerpt: 'ship it',
    } as RawEvidence);

    await run(normalize([check(' ')]), T1);                 // repo: Not Started
    target.rows[0].cells['Status'] = 'Blocked';             // human decides Blocked
    const p2 = await run(normalize([check('x')]), T2);      // repo: Done -> conflict
    expect(p2.counts.conflict).toBe(1);
    expect(target.rows[0].cells['Sync Status']).toBe('Conflict');

    // An unrelated repo change (section moves) while the two sides STILL disagree.
    const p3 = await run(normalize([check('x', 'Known issues')]), T3);
    expect(target.rows).toHaveLength(1);                    // same row, not a new one
    expect(target.rows[0].cells['Status']).toBe('Blocked'); // human value still wins
    expect(target.rows[0].cells['Sync Status']).toBe('Conflict'); // and it is STILL a conflict
    expect(p3.counts.conflict).toBe(1);
  });

  it('does not silently collapse two rows that claim the same Item ID', async () => {
    const a = ev('src/a.js', 'one');
    await run(items(a), T1);
    const dup = { rowId: 'dup-1', cells: { ...target.rows[0].cells } };
    target.rows.push(dup as typeof target.rows[number]);
    const rows = await target.readRows();
    const plan = planSync(items(a), rows, state, T2);
    // Both rows survive; the planner must not treat the sheet as if only one existed.
    expect(target.rows).toHaveLength(2);
    expect(plan.changes.filter((c) => c.action === 'create')).toHaveLength(0);
  });
});

describe('conflict state survives every path (round-2 review regressions)', () => {
  const check = (state: 'x' | ' ', section = 'Roadmap') => ({
    extractor: 'readme-checklist',
    sourceType: state === 'x' ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
    path: 'README.md', line: 5, section, excerpt: 'ship it',
  } as RawEvidence);

  it('a human can resolve a conflict without the repository changing (R2-03)', async () => {
    await run(normalize([check(' ')]), T1);
    target.rows[0].cells['Status'] = 'Blocked';
    await run(normalize([check('x')]), T2);                 // conflict: Blocked vs Done
    expect(target.rows[0].cells['Sync Status']).toBe('Conflict');

    target.rows[0].cells['Status'] = 'Done';                // human agrees with the repo
    await run(normalize([check('x')]), T3);                 // repo unchanged
    expect(target.rows[0].cells['Sync Status']).toBe('Synced');
    expect(target.rows[0].cells['Human Review']).toBe(false);
  });

  it('an unresolved conflict is not laundered into Synced by disappearing and returning (R2-01)', async () => {
    const other = ev('src/other.js', 'keep me');
    await run(normalize([check(' '), other]), T1);
    const checkId = normalize([check(' ')])[0].itemId;
    const row = target.rows.find((r) => r.cells['Item ID'] === checkId)!;
    row.cells['Status'] = 'Blocked';
    await run(normalize([check('x'), other]), T2); // conflict
    expect(row.cells['Sync Status']).toBe('Conflict');

    await run(normalize([other]), T3);                       // the checklist item vanishes
    // Both facts survive: it is gone AND still disagreed-about. Collapsing this to plain
    // "Missing in Repo" is what lost the conflict in the first place.
    expect(row.cells['Sync Status']).toBe('Conflict (missing in repo)');

    await run(normalize([check('x'), other]), '2026-08-24T13:00:00Z'); // it returns
    expect(row.cells['Status']).toBe('Blocked');             // human value still kept
    expect(row.cells['Sync Status']).not.toBe('Synced');     // must NOT claim synchronized
    expect(row.cells['Sync Status']).toBe('Conflict');
  });
});

describe('dry run', () => {
  it('planning alone never writes to the target', async () => {
    const its = items(ev('src/a.js', 'one'));
    const rows = await target.readRows();
    const plan = planSync(its, rows, state, T1);
    expect(plan.counts.create).toBe(1);
    expect(target.writes).toBe(0);
    expect(target.rows).toHaveLength(0);
    expect(state.items).toEqual({});
  });
});

describe('conflict state survives every path (round-3 review regressions)', () => {
  const check = (state: 'x' | ' ', section = 'Roadmap') => ({
    extractor: 'readme-checklist',
    sourceType: state === 'x' ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
    path: 'README.md', line: 5, section, excerpt: 'ship it',
  } as RawEvidence);
  const T4 = '2026-08-24T13:00:00Z', T5 = '2026-08-24T14:00:00Z';

  it('a conflict that vanishes and returns WITH a repo change is still a conflict (R3-01)', async () => {
    // The missing pass overwrites Sync Status, so the "Conflict" label is gone by the time
    // the item comes back. If the return also carries a fingerprint change, the row took the
    // update path and was relabelled "Updated" while the two Status values still disagreed.
    const other = ev('src/other.js', 'keep me');
    await run(normalize([check(' '), other]), T1);
    const checkId = normalize([check(' ')])[0].itemId;
    const row = target.rows.find((r) => r.cells['Item ID'] === checkId)!;
    row.cells['Status'] = 'Blocked';
    await run(normalize([check('x'), other]), T2);
    expect(row.cells['Sync Status']).toBe('Conflict');

    await run(normalize([other]), T3);                        // vanishes, conflict preserved
    expect(row.cells['Sync Status']).toBe('Conflict (missing in repo)');

    // Returns AND the fingerprint moved (section changed) -> the update path.
    const p = await run(normalize([check('x', 'Known issues'), other]), T4);
    expect(target.rows).toHaveLength(2);                      // same row, not a new one
    expect(row.cells['Status']).toBe('Blocked');              // human value still wins
    expect(row.cells['Repo Status']).toBe('Done');            // repo value still surfaced
    expect(row.cells['Sync Status']).toBe('Conflict');        // and it is NOT "Updated"
    expect(row.cells['Human Review']).toBe(true);
    expect(p.counts.conflict).toBe(1);
  });

  it('resolving a conflict clears Human Review even when the repo also changed (R3-02)', async () => {
    // Human Review was latched by the conflict and only ever OR-ed forward, so a row that a
    // human had since agreed with stayed in the "needs my attention" filter forever.
    await run(normalize([check(' ')]), T1);
    target.rows[0].cells['Status'] = 'Blocked';
    await run(normalize([check('x')]), T2);
    expect(target.rows[0].cells['Human Review']).toBe(true);

    target.rows[0].cells['Status'] = 'Done';                  // human agrees with the repo
    await run(normalize([check('x', 'Known issues')]), T3);   // and the repo moved too
    expect(target.rows[0].cells['Sync Status']).toBe('Updated');
    expect(target.rows[0].cells['Human Review']).toBe(false); // no longer needs attention
  });

  it('a human ahead of a stable repository is an update, never a conflict', async () => {
    // Guards the opposite failure: deriving conflict from "the values differ" alone would
    // flag every in-progress row, because a person marking an open TODO In Progress always
    // disagrees with a repo that still reports Not Started.
    await run(items(ev('src/a.js', 'one')), T1);
    target.rows[0].cells['Status'] = 'In Progress';
    const p = await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(p.counts.conflict).toBe(0);
    expect(target.rows[0].cells['Status']).toBe('In Progress');
    expect(target.rows[0].cells['Sync Status']).toBe('Updated');
    expect(target.rows[0].cells['Human Review']).toBe(false);

    // ...and it stays that way run after run.
    const p2 = await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T5);
    expect(p2.counts.conflict).toBe(0);
    expect(target.rows[0].cells['Status']).toBe('In Progress');
  });
});

describe('the missing state must not manufacture conflicts (round-4 review regressions)', () => {
  const T4 = '2026-08-24T13:00:00Z';

  it('a human ahead of a stable repo does NOT become a conflict by disappearing and returning (N-01)', async () => {
    // Regression: conflict was carried across the missing state by `wasMissing`, which records
    // absence and says nothing about who disagreed with whom. Any live disagreement on a
    // returning row therefore became a Conflict - including the "human is simply ahead of the
    // repository" case the engine explicitly treats as normal. It was sticky, too: the next
    // run took the unchanged branch and kept it.
    const other = ev('src/other.js', 'keep me');
    const a = ev('src/a.js', 'one');
    await run(items(a, other), T1);
    const aId = items(a)[0].itemId;
    const row = target.rows.find((r) => r.cells['Item ID'] === aId)!;
    row.cells['Status'] = 'In Progress';                 // human moves ahead; repo stays put

    await run(items(other), T2);                          // a vanishes
    expect(row.cells['Sync Status']).toBe('Missing in Repo'); // plain missing: never conflicted

    const p = await run(items(a, other), T3);             // and comes back
    expect(p.counts.conflict).toBe(0);
    expect(row.cells['Status']).toBe('In Progress');      // human value still kept
    expect(row.cells['Sync Status']).not.toBe('Conflict');

    const p2 = await run(items(a, other), T4);            // ...and it does not stick
    expect(p2.counts.conflict).toBe(0);
    expect(row.cells['Sync Status']).not.toBe('Conflict');
  });

  it('a repo-only status change while an item is absent is not a conflict either (N-01)', async () => {
    // Nobody touched the sheet. The repository moved on while the item was gone. That is an
    // ordinary update, not a disagreement between a person and the code.
    const other = ev('src/other.js', 'keep me');
    const check = (state: 'x' | ' ') => ({
      extractor: 'readme-checklist',
      sourceType: state === 'x' ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
      path: 'README.md', line: 5, section: 'Roadmap', excerpt: 'ship it',
    } as RawEvidence);

    await run(normalize([check(' '), other]), T1);
    const id = normalize([check(' ')])[0].itemId;
    const row = target.rows.find((r) => r.cells['Item ID'] === id)!;

    await run(normalize([other]), T2);                    // vanishes, nobody edits the sheet
    expect(row.cells['Sync Status']).toBe('Missing in Repo');

    const p = await run(normalize([check('x'), other]), T3); // returns, repo now says Done
    expect(p.counts.conflict).toBe(0);
    expect(row.cells['Status']).toBe('Done');
    expect(row.cells['Sync Status']).not.toBe('Conflict');
  });

  it('keeps a deliberate human Human Review tick through an unrelated repo change (N-02)', async () => {
    // Regression: resetting Human Review from the item on every non-conflict path fixed the
    // stuck-forever case but erased a person's own "look at this" on the next repo change.
    await run(items(ev('src/a.js', 'one')), T1);
    expect(target.rows[0].cells['Human Review']).toBe(false);
    target.rows[0].cells['Human Review'] = true;          // a person ticks it deliberately

    await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2); // unrelated repo change
    expect(target.rows[0].cells['Sync Status']).toBe('Updated');
    expect(target.rows[0].cells['Human Review']).toBe(true); // their decision survives

    target.rows[0].cells['Human Review'] = false;         // and they can clear it again
    await run(items(ev('src/a.js', 'one', { commit: 'def5678' })), T3);
    expect(target.rows[0].cells['Human Review']).toBe(false);
  });

  it('still clears the flag it set itself once a conflict is resolved (R3-02 must not regress)', async () => {
    const check = (state: 'x' | ' ', section = 'Roadmap') => ({
      extractor: 'readme-checklist',
      sourceType: state === 'x' ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
      path: 'README.md', line: 5, section, excerpt: 'ship it',
    } as RawEvidence);
    await run(normalize([check(' ')]), T1);
    target.rows[0].cells['Status'] = 'Blocked';
    await run(normalize([check('x')]), T2);
    expect(target.rows[0].cells['Human Review']).toBe(true);   // we set it

    target.rows[0].cells['Status'] = 'Done';                   // human agrees with the repo
    await run(normalize([check('x', 'Known issues')]), T3);
    expect(target.rows[0].cells['Sync Status']).toBe('Updated');
    expect(target.rows[0].cells['Human Review']).toBe(false);  // ours, so ours to clear
  });
});

describe('losing state.json must not lose a human decision (round-5 self-review)', () => {
  it('keeps a human Human Review tick when there is no baseline to compare against', async () => {
    // The three-way checkbox merge needs to know what WE last wrote. On a fresh clone there is
    // no state.json, so recomputing from the item would silently clear a person's tick on the
    // very first run - exactly the kind of silent human-input loss this tool exists to prevent.
    await run(items(ev('src/a.js', 'one')), T1);
    target.rows[0].cells['Human Review'] = true;         // a person ticks it

    state = { version: 1, sheetId: 'sheet-1', items: {} }; // fresh clone: baseline is gone
    await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(target.rows[0].cells['Sync Status']).toBe('Updated');
    expect(target.rows[0].cells['Human Review']).toBe(true);
  });

  it('still clears its own flag with no baseline when the row carries one of our markers', async () => {
    // A row labelled Conflict is one WE ticked, so with no baseline it is still ours to clear
    // once the human has made the sheet agree. Otherwise a lost state file would strand every
    // resolved conflict in the "needs my attention" filter forever.
    const check = (state: 'x' | ' ', section = 'Roadmap') => ({
      extractor: 'readme-checklist',
      sourceType: state === 'x' ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
      path: 'README.md', line: 5, section, excerpt: 'ship it',
    } as RawEvidence);

    await run(normalize([check(' ')]), T1);
    target.rows[0].cells['Status'] = 'Blocked';
    await run(normalize([check('x')]), T2);
    expect(target.rows[0].cells['Sync Status']).toBe('Conflict');
    expect(target.rows[0].cells['Human Review']).toBe(true);

    state = { version: 1, sheetId: 'sheet-1', items: {} }; // lose the state file
    target.rows[0].cells['Status'] = 'Done';              // human resolves it
    await run(normalize([check('x', 'Known issues')]), T3);
    expect(target.rows[0].cells['Human Review']).toBe(false);
  });
});

describe('round-5 review regressions', () => {
  const T4 = '2026-08-24T13:00:00Z', T5 = '2026-08-24T14:00:00Z';
  const check = (state: 'x' | ' ', section = 'Roadmap') => ({
    extractor: 'readme-checklist',
    sourceType: state === 'x' ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
    path: 'README.md', line: 5, section, excerpt: 'ship it',
  } as RawEvidence);

  it('does not mistake its own missing-row tick for a human edit (R5-01)', async () => {
    // The missing write sets Human Review, but skipped recording that it had. On return, our
    // own tick sat against a stale `false` baseline, was read as a human decision, and stuck.
    const a = ev('src/a.js', 'one'), other = ev('src/other.js', 'keep me');
    await run(items(a, other), T1);
    const aId = items(a)[0].itemId;
    const row = target.rows.find((r) => r.cells['Item ID'] === aId)!;
    expect(row.cells['Human Review']).toBe(false);

    await run(items(other), T2);                       // vanishes: WE tick the box
    expect(row.cells['Human Review']).toBe(true);
    expect(row.cells['Repo Review']).toBe(true);       // and we record that it was ours

    await run(items(a, other), T3);                    // returns unchanged
    expect(row.cells['Sync Status']).toBe('Synced');
    expect(row.cells['Human Review']).toBe(false);     // ours, so ours to clear
  });

  it('uses the sheet as the review baseline, so a lost state file changes nothing (R5-02)', async () => {
    // Human Review's "what did WE last write" lived only in state.json, while Status had a
    // sheet-side mirror in `Repo Status`. So on a fresh clone the engine could not tell its own
    // tick from a person's, and on a row carrying one of its own markers it recomputed from the
    // item - re-checking a box a human had deliberately CLEARED. The fix is symmetry: a
    // `Repo Review` column mirrors what we wrote, so no local file is needed to tell them apart.
    const risk = (over: Partial<RawEvidence> = {}): RawEvidence => ({
      extractor: 'risk-heuristics', sourceType: 'Risk heuristic', path: 'src/auth/session.js',
      line: 5, excerpt: 'FIXME in a security-sensitive file: sessions never expire', ...over,
    });
    await run(normalize([risk()]), T1);
    const row = target.rows[0];
    expect(row.cells['Human Review']).toBe(true);   // the item itself asks for review
    expect(row.cells['Repo Review']).toBe(true);    // and the sheet records that WE asked

    row.cells['Human Review'] = false;              // a person looks at it and clears the flag
    state = { version: 1, sheetId: 'sheet-1', items: {} }; // fresh clone: no local baseline

    await run(normalize([risk({ commit: 'abc1234' })]), T2); // an unrelated repo change lands
    expect(row.cells['Sync Status']).toBe('Updated');
    expect(row.cells['Human Review']).toBe(false);  // their decision survives with no state file
    // The baseline must NOT follow: it still records the `true` WE last wrote, which is what
    // keeps the sheet value marked as theirs on every later run.
    expect(row.cells['Repo Review']).toBe(true);

    const p = await run(normalize([risk({ commit: 'abc1234' })]), T3);
    expect(p.counts.unchanged).toBe(1);             // settles instead of re-checking every run
    expect(row.cells['Human Review']).toBe(false);
  });

  it('lets a human resolve a conflict on an item that is gone for good (R5-03)', async () => {
    // The missing loop skipped both missing labels unconditionally, so a permanently deleted
    // item kept its conflict marker forever even after a person made the sheet agree.
    const other = ev('src/other.js', 'keep me');
    await run(normalize([check(' '), other]), T1);
    const id = normalize([check(' ')])[0].itemId;
    const row = target.rows.find((r) => r.cells['Item ID'] === id)!;
    row.cells['Status'] = 'Blocked';
    await run(normalize([check('x'), other]), T2);
    expect(row.cells['Sync Status']).toBe('Conflict');

    await run(normalize([other]), T3);                 // deleted from the repo for good
    expect(row.cells['Sync Status']).toBe('Conflict (missing in repo)');

    row.cells['Status'] = 'Done';                      // human agrees with the last repo value
    await run(normalize([other]), T4);
    expect(row.cells['Sync Status']).toBe('Missing in Repo'); // conflict resolved, still missing
    expect(row.cells['Human Review']).toBe(false);

    const p = await run(normalize([other]), T5);       // and it settles, not oscillates
    expect(p.counts.missing).toBe(0);
    expect(row.cells['Sync Status']).toBe('Missing in Repo');
  });

  it('never silently overwrites a Status a person cleared (R5-04)', async () => {
    // A Smartsheet dropdown can be emptied. Blank was read as "no human value", so the repo
    // value was written straight back with no trace that anything had been done.
    await run(items(ev('src/a.js', 'one')), T1);
    target.rows[0].cells['Status'] = '';               // a person clears the cell

    const p = await run(items(ev('src/a.js', 'one')), T2); // nothing else changed
    expect(p.counts.unchanged).toBe(0);                // it must not be dismissed as unchanged
    expect(target.rows[0].cells['Status']).toBe('Not Started'); // restored, since blank breaks reports
    expect(target.rows[0].cells['Human Review']).toBe(true);    // ...but flagged, never silent
    const reason = p.changes[0].reasons.join(' ');
    expect(reason).toMatch(/cleared/);
  });
});

describe('an older sheet without Repo Review must still behave (round-6 self-review)', () => {
  it('falls back safely when the row has no Repo Review cell at all', async () => {
    // A sheet created before the Repo Review column existed has no mirror value, and
    // SmartsheetTarget drops writes to columns the sheet does not have. With no sheet baseline
    // AND no state file the engine cannot tell its own tick from a person's, so it must keep
    // the tick: a stale flag costs one glance, a cleared one loses a decision silently.
    await run(items(ev('src/a.js', 'one')), T1);
    delete target.rows[0].cells['Repo Review'];      // as an older sheet would have it
    target.rows[0].cells['Human Review'] = true;     // a person ticks it
    state = { version: 1, sheetId: 'sheet-1', items: {} }; // and there is no local cache either

    await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(target.rows[0].cells['Sync Status']).toBe('Updated');
    expect(target.rows[0].cells['Human Review']).toBe(true);
  });
});

describe('round-6 review regressions', () => {
  const T4 = '2026-08-24T13:00:00Z', T5 = '2026-08-24T14:00:00Z';
  const check = (state: 'x' | ' ') => ({
    extractor: 'readme-checklist',
    sourceType: state === 'x' ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
    path: 'README.md', line: 5, section: 'Roadmap', excerpt: 'ship it',
  } as RawEvidence);

  it('does not relabel a human tick as its own when flagging a row missing (R6-02)', async () => {
    // The missing pass wrote Human Review AND Repo Review true unconditionally. If the box was
    // already a person's, that rewrote its authorship to ours - and the next ordinary update
    // then cleared their decision.
    const a = ev('src/a.js', 'one'), other = ev('src/other.js', 'keep me');
    await run(items(a, other), T1);
    const aId = items(a)[0].itemId;
    const row = target.rows.find((r) => r.cells['Item ID'] === aId)!;
    row.cells['Human Review'] = true;                 // a person ticks it; Repo Review stays false
    expect(row.cells['Repo Review']).toBe(false);

    await run(items(other), T2);                      // the item vanishes
    expect(row.cells['Sync Status']).toBe('Missing in Repo');
    expect(row.cells['Human Review']).toBe(true);
    expect(row.cells['Repo Review']).toBe(false);     // still theirs, not ours

    await run(items(a, other), T3);                   // it comes back
    expect(row.cells['Human Review']).toBe(true);     // and their tick survives
  });

  it('reports a cleared Status even when the row was missing or conflicted (R6-03)', async () => {
    // The cleared-Status handler sat AFTER the missing and resolved-conflict branches, so on
    // those paths a blank cell was silently overwritten - exactly what the fix was meant to stop.
    const other = ev('src/other.js', 'keep me');
    const a = ev('src/a.js', 'one');
    await run(items(a, other), T1);
    const aId = items(a)[0].itemId;
    const row = target.rows.find((r) => r.cells['Item ID'] === aId)!;

    await run(items(other), T2);                      // vanishes
    expect(row.cells['Sync Status']).toBe('Missing in Repo');

    row.cells['Status'] = '';                         // a person empties the cell
    const p = await run(items(a, other), T3);         // and it returns unchanged
    expect(row.cells['Status']).toBe('Not Started');  // restored...
    const change = p.changes.find((c) => c.item.itemId === aId)!;
    expect(change.reasons.join(' ')).toMatch(/cleared/); // ...and said so
    expect(row.cells['Human Review']).toBe(true);     // and flagged
  });

  it('leaves rows alone when two of them claim one Item ID, instead of flip-flopping (R6-04)', async () => {
    // The row map keeps only the last row for an id, so two colliding items took turns
    // overwriting one row's evidence - a different item every run, forever.
    const a = ev('src/a.js', 'one');
    await run(items(a), T1);
    const original = { ...target.rows[0].cells };
    target.rows.push({ rowId: 9999, cells: { ...original } } as typeof target.rows[number]);

    const p = await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(p.counts.update).toBe(0);
    expect(p.counts.create).toBe(0);                  // never a third row either
    expect(target.rows).toHaveLength(2);
    expect(target.rows[0].cells['Source Commit']).toBe(original['Source Commit']); // untouched
    expect(p.changes[0].reasons.join(' ')).toMatch(/sheet rows claim Item ID/);
  });
});

describe('the review baseline must not go stale (round-6 R6-05)', () => {
  it('prefers the local cache over a stale Repo Review cell', async () => {
    // The sheet mirror was consulted first, so a technical cell that had gone stale (added by
    // hand to an old sheet, edited, or written by an older build) outranked a correct cache
    // and cleared a person's tick.
    await run(items(ev('src/a.js', 'one')), T1);
    target.rows[0].cells['Repo Review'] = true;    // stale: we actually last wrote false
    target.rows[0].cells['Human Review'] = true;   // and a person ticked it

    await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(target.rows[0].cells['Human Review']).toBe(true); // their decision survives
  });

  it('records the review value the missing pass wrote, so the cache cannot go stale', async () => {
    // The missing write updates the sheet but cannot call remember() (a vanished item has no
    // fingerprint). It must still record the checkbox it set, or the cache disagrees with the
    // sheet and the next run reads the tool's own tick as a human edit.
    const a = ev('src/a.js', 'one'), other = ev('src/other.js', 'keep me');
    await run(items(a, other), T1);
    const aId = items(a)[0].itemId;
    await run(items(other), T2);
    expect(state.items[aId].lastWrittenHumanReview).toBe(true);
    const row = target.rows.find((r) => r.cells['Item ID'] === aId)!;
    expect(row.cells['Human Review']).toBe(true);

    await run(items(a, other), T3);
    expect(row.cells['Human Review']).toBe(false);  // ours, so ours to clear
  });
});

describe('the tool must never claim a tick that is already a person\u2019s (round-7 self-review)', () => {
  const T4 = '2026-08-24T13:00:00Z';
  const check = (c: boolean) => ({
    extractor: 'readme-checklist',
    sourceType: c ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
    path: 'README.md', line: 3, section: 'S', excerpt: 'ship it',
  } as RawEvidence);

  it('keeps a human tick through a whole conflict lifecycle', async () => {
    // `sharedCells` mirrored Repo Review on EVERY write, so any path that forced review on -
    // a conflict, a restored Status - relabelled a person's existing tick as tool-authored.
    // Resolving the conflict then cleared it, silently losing their decision. Returning {}
    // from the guard could not undo it, because sharedCells had already written the cell.
    await run(normalize([check(false)]), T1);
    const c = target.rows[0].cells;
    expect(c['Repo Review']).toBe(false);
    c['Human Review'] = true;                    // a PERSON ticks it; the tick is theirs

    await run(normalize([check(true)]), T2);     // repo says Done
    c['Status'] = 'Blocked';                     // human disagrees
    await run(normalize([check(false)]), T3);    // repo reverts -> both moved -> conflict
    expect(c['Sync Status']).toBe('Conflict');
    expect(c['Human Review']).toBe(true);
    expect(c['Repo Review']).toBe(false);        // still theirs, never claimed

    c['Status'] = String(c['Repo Status']);      // human resolves the disagreement
    await run(normalize([check(false)]), T4);
    expect(c['Sync Status']).toBe('Synced');
    expect(c['Human Review']).toBe(true);        // and their tick is still there
  });
});

describe('round-7 review regressions', () => {
  const T4 = '2026-08-24T13:00:00Z', T5 = '2026-08-24T14:00:00Z';
  const risk = (over: Partial<RawEvidence> = {}): RawEvidence => ({
    extractor: 'risk-heuristics', sourceType: 'Risk heuristic', path: 'src/auth/session.js',
    line: 5, excerpt: 'FIXME in a security-sensitive file: sessions never expire', ...over,
  });
  const check = (c: boolean) => ({
    extractor: 'readme-checklist',
    sourceType: c ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
    path: 'README.md', line: 3, section: 'S', excerpt: 'ship it',
  } as RawEvidence);

  it('never re-ticks a box a person deliberately cleared (R7-01)', async () => {
    // The guard protected a human TICK but not a human CLEAR: the clear was written back as
    // our own baseline, and the next ordinary repo update saw sheet === baseline and re-ticked
    // it from the item. Once a person moves this checkbox it is theirs, in either direction.
    await run(normalize([risk()]), T1);
    expect(target.rows[0].cells['Human Review']).toBe(true);   // the item asks for review
    target.rows[0].cells['Human Review'] = false;              // a person looks and clears it

    await run(normalize([risk({ commit: 'abc1234' })]), T2);   // an unrelated repo change
    expect(target.rows[0].cells['Human Review']).toBe(false);
    await run(normalize([risk({ commit: 'def5678' })]), T3);   // and another, one run later
    expect(target.rows[0].cells['Human Review']).toBe(false);  // still cleared, not re-ticked
  });

  it('does not launder a human tick when resolving a conflict on an absent item (R7-02)', async () => {
    // That branch wrote BOTH cells to one value instead of using the shared rule, so a tick
    // that was a person's became tool-authored and a later run cleared it. The tick has to
    // predate our own flagging for the difference to show: once WE tick a row (conflict,
    // missing) our baseline matches the sheet and the box is legitimately ours to clear.
    const other = ev('src/other.js', 'keep me');
    await run(normalize([check(false), other]), T1);
    const id = normalize([check(false)])[0].itemId;
    const row = target.rows.find((r) => r.cells['Item ID'] === id)!;
    expect(row.cells['Repo Review']).toBe(false);
    row.cells['Human Review'] = true;                          // a PERSON ticks it first

    row.cells['Status'] = 'Blocked';
    await run(normalize([check(true), other]), T2);            // conflict
    expect(row.cells['Repo Review']).toBe(false);              // never claimed as ours
    await run(normalize([other]), T3);                         // and the item vanishes
    expect(row.cells['Sync Status']).toBe('Conflict (missing in repo)');
    expect(row.cells['Repo Review']).toBe(false);

    row.cells['Status'] = String(row.cells['Repo Status']);    // human resolves the conflict
    await run(normalize([other]), T4);                         // resolve-while-absent
    expect(row.cells['Sync Status']).toBe('Missing in Repo');
    expect(row.cells['Human Review']).toBe(true);              // their tick is still theirs

    await run(normalize([check(true), other]), T5);            // the item comes back
    expect(row.cells['Human Review']).toBe(true);              // and it is still there
  });

  it('flags every duplicate row when the item vanishes, not just the last (R7-03)', async () => {
    // The planner kept one row per Item ID, so earlier copies of a vanished item stayed
    // falsely live on the sheet forever.
    const a = ev('src/a.js', 'one'), other = ev('src/other.js', 'keep me');
    await run(items(a, other), T1);
    const aId = items(a)[0].itemId;
    const original = target.rows.find((r) => r.cells['Item ID'] === aId)!;
    target.rows.push({ rowId: 4242, cells: { ...original.cells } } as typeof target.rows[number]);

    await run(items(other), T2);                               // a vanishes; two rows claim it
    const claimed = target.rows.filter((r) => r.cells['Item ID'] === aId);
    expect(claimed).toHaveLength(2);
    for (const r of claimed) expect(r.cells['Sync Status']).toBe('Missing in Repo');
  });

  it('tells a person what to do when two rows share an Item ID (R7-03)', async () => {
    const a = ev('src/a.js', 'one');
    await run(items(a), T1);
    target.rows.push({ rowId: 4243, cells: { ...target.rows[0].cells } } as typeof target.rows[number]);
    const p = await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    const reason = p.changes[0].reasons.join(' ');
    expect(reason).toMatch(/2 sheet rows claim Item ID/);
    expect(reason).toMatch(/collision/); // and does not promise that deleting one always fixes it
  });
});

describe('neither baseline may be trusted alone (round-7 R7-04)', () => {
  const risk = (over: Partial<RawEvidence> = {}): RawEvidence => ({
    extractor: 'risk-heuristics', sourceType: 'Risk heuristic', path: 'src/auth/session.js',
    line: 5, excerpt: 'FIXME in a security-sensitive file: sessions never expire', ...over,
  });

  it('keeps a human tick when the local cache is stale but the sheet mirror is right', async () => {
    // Making the cache authoritative fixed a stale sheet mirror and created the mirror image
    // of the same bug: a rolled-back or copied state.json then cleared a real decision.
    // Use an item that does NOT intrinsically require review, so recomputing would visibly
    // clear the tick rather than coincidentally reproduce it.
    await run(items(ev('src/a.js', 'one')), T1);
    const row = target.rows[0];
    expect(row.cells['Repo Review']).toBe(false);     // the sheet correctly says we wrote false
    row.cells['Human Review'] = true;                 // and a person ticks it
    state.items[items(ev('src/a.js', 'one'))[0].itemId].lastWrittenHumanReview = true; // stale cache

    await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(row.cells['Human Review']).toBe(true);     // the disagreeing baseline wins
  });

  it('keeps a human tick when the sheet mirror is stale but the local cache is right', async () => {
    await run(normalize([risk()]), T1);
    const row = target.rows[0];
    const id = normalize([risk()])[0].itemId;
    state.items[id].lastWrittenHumanReview = false;   // the cache says we last wrote false
    row.cells['Repo Review'] = true;                  // stale mirror
    row.cells['Human Review'] = true;                 // a person has it ticked

    await run(normalize([risk({ commit: 'abc1234' })]), T2);
    expect(row.cells['Human Review']).toBe(true);
  });

  it('still recomputes when every baseline agrees with the sheet', async () => {
    await run(items(ev('src/a.js', 'one')), T1);
    expect(target.rows[0].cells['Human Review']).toBe(false);
    expect(target.rows[0].cells['Repo Review']).toBe(false);
    await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(target.rows[0].cells['Sync Status']).toBe('Updated');
    expect(target.rows[0].cells['Human Review']).toBe(false);
  });
});

describe('round-8 review regressions', () => {
  const T4 = '2026-08-24T13:00:00Z';
  const risk = (over: Partial<RawEvidence> = {}): RawEvidence => ({
    extractor: 'risk-heuristics', sourceType: 'Risk heuristic', path: 'src/auth/session.js',
    line: 5, excerpt: 'FIXME in a security-sensitive file: sessions never expire', ...over,
  });

  it('uses one baseline rule on the absent paths too (R8-01)', async () => {
    // The two absent-item paths selected a single baseline with `??`, so a stale cache hid a
    // disagreeing mirror and the missing write overwrote a human clear.
    const other = ev('src/other.js', 'keep me');
    await run(normalize([risk(), other]), T1);
    const id = normalize([risk()])[0].itemId;
    const row = target.rows.find((r) => r.cells['Item ID'] === id)!;
    row.cells['Human Review'] = false;                 // a person clears our flag
    row.cells['Repo Review'] = true;                   // the mirror still says the tick was ours
    state.items[id].lastWrittenHumanReview = false;    // but the cache disagrees with the mirror

    await run(normalize([other]), T2);                 // the item vanishes
    expect(row.cells['Sync Status']).toBe('Missing in Repo');
    expect(row.cells['Human Review']).toBe(false);     // their clear is not overwritten
  });

  it('never writes the checkbox when there is no baseline at all (R8-02)', async () => {
    // With no baseline the code claimed to preserve the current value but wrote it anyway and
    // recorded it as tool-authored, so a later repo change reversed a real decision.
    await run(items(ev('src/a.js', 'one')), T1);
    const row = target.rows[0];
    row.cells['Human Review'] = true;                  // a person ticks it
    delete row.cells['Repo Review'];                   // no mirror
    state = { version: 1, sheetId: 'sheet-1', items: {} };  // and no cache

    await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(row.cells['Human Review']).toBe(true);      // untouched
    expect(row.cells['Repo Review']).toBeUndefined();  // and NOT adopted as ours
    await run(items(ev('src/a.js', 'one', { commit: 'def5678' })), T3);
    expect(row.cells['Human Review']).toBe(true);      // adopting it would only have delayed
    expect(row.cells['Repo Review']).toBeUndefined();  // the loss by exactly one run
  });

  it('recovers from technical drift instead of suppressing a required flag forever (R8-03)', async () => {
    // Two baselines that disagree with EACH OTHER cannot both be right, and that is not a
    // human edit. Previously any disagreement meant "human owns it", so an accidentally stale
    // mirror could stop the tool ever flagging a row its own model says needs review.
    await run(normalize([risk()]), T1);
    const row = target.rows[0];
    const id = normalize([risk()])[0].itemId;
    row.cells['Human Review'] = false;                 // nobody edited this; it is just off
    state.items[id].lastWrittenHumanReview = false;    // the cache agrees
    row.cells['Repo Review'] = true;                   // the mirror has drifted

    await run(normalize([risk({ commit: 'abc1234' })]), T2);  // run 1: re-point the baselines
    expect(row.cells['Human Review']).toBe(false);     // the visible value is preserved
    expect(row.cells['Repo Review']).toBe(false);      // drift resolved

    await run(normalize([risk({ commit: 'def5678' })]), T3);  // run 2: normal rules resume
    expect(row.cells['Human Review']).toBe(true);      // and the required flag is applied again
  });
});

describe('round-9 review regressions', () => {
  const T4 = '2026-08-24T13:00:00Z';
  const risk = (over: Partial<RawEvidence> = {}): RawEvidence => ({
    extractor: 'risk-heuristics', sourceType: 'Risk heuristic', path: 'src/auth/session.js',
    line: 5, excerpt: 'FIXME in a security-sensitive file: sessions never expire', ...over,
  });
  const check = (c: boolean) => ({
    extractor: 'readme-checklist',
    sourceType: c ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
    path: 'README.md', line: 3, section: 'S', excerpt: 'ship it',
  } as RawEvidence);

  it('finishes converging the checkbox after drift instead of stalling (R9-03)', async () => {
    // Drift repair writes only the mirror, so the visible value stayed wrong until some
    // unrelated repository change happened along. Nothing else ever revisits a quiet row.
    await run(normalize([risk()]), T1);
    const row = target.rows[0];
    const id = normalize([risk()])[0].itemId;
    row.cells['Human Review'] = false;                     // nobody edited this
    state.items[id].lastWrittenHumanReview = false;
    row.cells['Repo Review'] = true;                       // the mirror has drifted

    await run(normalize([risk()]), T2);                    // run 1: repair drift, nothing else
    expect(row.cells['Repo Review']).toBe(false);
    await run(normalize([risk()]), T3);                    // run 2: no repo change at all...
    expect(row.cells['Human Review']).toBe(true);          // ...and it still converges
    const p = await run(normalize([risk()]), T4);          // and then settles
    expect(p.counts.unchanged).toBe(1);
  });

});

describe('round-10 review regressions', () => {
  const T4 = '2026-08-24T13:00:00Z';
  const risk = (over: Partial<RawEvidence> = {}): RawEvidence => ({
    extractor: 'risk-heuristics', sourceType: 'Risk heuristic', path: 'src/auth/session.js',
    line: 5, excerpt: 'FIXME in a security-sensitive file: sessions never expire', ...over,
  });

  it('adopts the cache of the row in front of it, not one from a deleted row (R10-01)', async () => {
    // After the old split behaviour a sheet can hold BOTH caches. Preferring the new-ID one -
    // which describes a row a person has since deleted - made the two records disagree, which
    // reads as drift, and two runs later the tool cleared a real human tick.
    const e = ev('src/a.js', 'one');
    const [item] = items(e);
    await run(items(e), T1);
    const row = target.rows[0];
    row.cells['Item ID'] = oldStyleId(item.itemId);
    row.cells['Repo Review'] = false;
    row.cells['Human Review'] = true;                       // a person ticks the legacy row
    state.items[oldStyleId(item.itemId)] = { ...state.items[item.itemId], lastWrittenHumanReview: false };
    state.items[item.itemId] = { ...state.items[item.itemId], lastWrittenHumanReview: true }; // stale, deleted row

    await run(items(e), T2);
    expect(row.cells['Human Review']).toBe(true);
    await run(items(e), T3);
    expect(row.cells['Human Review']).toBe(true);           // and still theirs a run later
  });

  it('repairs the review flag without rewriting the merge baselines (R10-02)', async () => {
    // The convergence write spread repoCells, which rewrites Repo Status and Repo Fingerprint.
    // A checkbox repair has no business touching the merge baselines - that is how the
    // legacy-adoption branch destroyed a conflict one round earlier.
    await run(normalize([risk()]), T1);
    const row = target.rows[0];
    const id = normalize([risk()])[0].itemId;
    const baselineBefore = row.cells['Repo Status'];
    const fingerprintBefore = row.cells['Repo Fingerprint'];
    row.cells['Human Review'] = false;
    state.items[id].lastWrittenHumanReview = false;
    row.cells['Repo Review'] = true;                        // drift, to force the repair path

    const p = await run(normalize([risk()]), T2);
    expect(p.changes[0].reasons.join(' ')).toMatch(/review flag/);
    expect(Object.keys(p.changes[0].cells).sort()).toEqual(['Last Synced', 'Repo Review']);
    expect(row.cells['Repo Status']).toBe(baselineBefore);  // baselines untouched
    expect(row.cells['Repo Fingerprint']).toBe(fingerprintBefore);
  });

  it('repairs a stale Repo Status instead of inventing a conflict (R10-02b)', async () => {
    // A current fingerprint PROVES the repository has not moved, because Status is part of the
    // fingerprint. So a `Repo Status` that disagrees is a stale mirror - hand-edited, imported,
    // or written by an older build - and not evidence that both sides moved.
    //
    // An earlier version declared a conflict here. That trusted the stale mirror over a cache
    // holding the true last value and turned ordinary rows into conflicts that then stuck. With
    // the repository provably still, a human on a different Status is simply ahead of it.
    // Use an item that does NOT ask for review, so the flag can only come from this repair.
    await run(items(ev('src/a.js', 'one')), T1);
    const row = target.rows[0];
    expect(row.cells['Human Review']).toBe(false);
    row.cells['Repo Status'] = 'Done';                      // stale mirror
    row.cells['Status'] = 'In Progress';                    // a person is ahead of the repo
    row.cells['Sync Status'] = 'Synced';

    const p = await run(items(ev('src/a.js', 'one')), T2);
    expect(p.counts.conflict).toBe(0);                      // no invented conflict
    expect(row.cells['Repo Status']).toBe('Not Started');   // the mirror is repaired
    expect(row.cells['Status']).toBe('In Progress');        // their value is untouched
    expect(p.changes[0].reasons.join(' ')).toMatch(/Repaired the stale value and flagged the row/);
    expect(row.cells['Human Review']).toBe(true);           // a person is told, never silently chosen for

    // ...and the warning is not cleared by our own next run - only a person can dismiss it.
    await run(items(ev('src/a.js', 'one')), '2026-08-24T13:00:00Z');
    expect(row.cells['Human Review']).toBe(true);

    const p2 = await run(items(ev('src/a.js', 'one')), T3);
    expect(p2.counts.unchanged).toBe(1);                    // and it settles, never sticks
  });

});

describe('round-11 review regressions', () => {
  const risk = (over: Partial<RawEvidence> = {}): RawEvidence => ({
    extractor: 'risk-heuristics', sourceType: 'Risk heuristic', path: 'src/auth/session.js',
    line: 5, excerpt: 'FIXME in a security-sensitive file: sessions never expire', ...over,
  });

  it('ignores a cache entry that describes a different physical row (R10-01)', async () => {
    // Every cache entry records the rowId it describes, and the planner never checked it. An
    // entry left behind by a row a person has since deleted then read as drift, and the tool
    // cleared a real human tick.
    await run(items(ev('src/a.js', 'one')), T1);
    const row = target.rows[0];
    const [item] = items(ev('src/a.js', 'one'));
    row.cells['Human Review'] = true;                     // a person ticks it
    // ...and a leftover entry for some OTHER row claims we last wrote true.
    state.items[item.itemId] = { ...state.items[item.itemId], rowId: 999999, lastWrittenHumanReview: true };

    await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(row.cells['Human Review']).toBe(true);
    await run(items(ev('src/a.js', 'one', { commit: 'def5678' })), T3);
    expect(row.cells['Human Review']).toBe(true);          // still theirs two runs later
  });

  it('repairs a drifted cache even when the mirror already shows the visible value (R9-03)', async () => {
    // Drift where the mirror already equals the sheet writes no cell, so nothing made
    // remember() run and the local cache stayed wrong - every run, forever.
    await run(normalize([risk()]), T1);
    const row = target.rows[0];
    const id = normalize([risk()])[0].itemId;
    expect(row.cells['Human Review']).toBe(true);
    state.items[id].lastWrittenHumanReview = false;         // cache drifted away from the mirror

    await run(normalize([risk()]), T2);
    expect(state.items[id].lastWrittenHumanReview).toBe(true);  // cache repaired
    const p = await run(normalize([risk()]), T3);
    expect(p.counts.unchanged).toBe(1);                        // and then it settles
  });
});

describe('round-12 review regressions', () => {

  it('will not hand one item the row of another that merely displays the same text (R12)', async () => {
    // Displayed Item text can be shortened, so two different items CAN show the same string.
    // Text equality alone was enough to carry one person's Owner and Notes to the wrong item.
    const long = (tail: string) => 'TODO: ' + 'y'.repeat(4000) + tail;
    const a: RawEvidence = { extractor: 'todo-comments', sourceType: 'TODO comment', path: 'src/a.ts', line: 1, excerpt: long('AAA') };
    const b: RawEvidence = { extractor: 'todo-comments', sourceType: 'TODO comment', path: 'src/b.ts', line: 1, excerpt: long('BBB') };
    const [ia] = normalize([a]);
    await run(normalize([b]), T1);                          // the sheet holds B
    const row = target.rows[0];
    row.cells['Item ID'] = oldStyleId(ia.itemId);            // wearing A's older ID
    row.cells['Owner'] = 'owner-of-b@example.com';

    const p = await run(normalize([a]), T2);
    expect(p.counts.create).toBe(1);                        // A gets its own row
    expect(row.cells['Owner']).toBe('owner-of-b@example.com');
  });
});


describe('a raised warning must survive every baseline history (round-14 R14-04)', () => {
  it('stays ticked from any starting cache/mirror combination', async () => {
    // Leaving the baselines merely untouched was not enough: in several reachable states they
    // already said true, so the ticked box looked like ours and the next run cleared it. The
    // raise now pins both baselines to false, which every ownership rule reads as the person's.
    for (const cache of [undefined, false, true]) {
      for (const mirror of [undefined, false, true]) {
        target = new MemoryTarget(COLUMN_TITLES, 'sheet-1');
        state = { version: 1, sheetId: 'sheet-1', items: {} };
        await run(items(ev('src/a.js', 'one')), T1);
        const row = target.rows[0];
        const id = items(ev('src/a.js', 'one'))[0].itemId;

        row.cells['Repo Status'] = 'Done';                 // stale mirror
        row.cells['Status'] = 'In Progress';               // and somebody disagrees
        if (mirror === undefined) delete row.cells['Repo Review']; else row.cells['Repo Review'] = mirror;
        if (cache === undefined) delete state.items[id]; else state.items[id].lastWrittenHumanReview = cache;

        await run(items(ev('src/a.js', 'one')), T2);
        expect(row.cells['Human Review'], `raised with cache=${cache} mirror=${mirror}`).toBe(true);
        await run(items(ev('src/a.js', 'one')), T3);
        expect(row.cells['Human Review'], `still raised with cache=${cache} mirror=${mirror}`).toBe(true);
        await run(items(ev('src/a.js', 'one')), '2026-08-24T13:00:00Z');
        expect(row.cells['Human Review'], `run 4 with cache=${cache} mirror=${mirror}`).toBe(true);
      }
    }
  });
});


describe('the tool never guesses which old row belongs to which item (round-15)', () => {
  it('gives an item a fresh row rather than claiming one that predates its Item ID', async () => {
    // Adoption of rows carrying an older Item ID was tried four times and defeated four times:
    // displayed text is clipped, several items share a file, an old digest can collide, and
    // redaction makes two items identical by design. Guessing wrong moves a person's Owner and
    // Management Notes onto the wrong work and cannot be undone. So the tool no longer guesses.
    const e = ev('src/a.js', 'one');
    const [item] = items(e);
    await run(items(e), T1);
    const row = target.rows[0];
    row.cells['Item ID'] = oldStyleId(item.itemId);         // as an older build left it
    row.cells['Owner'] = 'human@example.com';
    row.cells['Management Notes'] = 'mine';
    state = { version: 1, sheetId: 'sheet-1', items: {} };

    const p = await run(items(e), T2);
    expect(p.counts.create).toBe(1);                       // a fresh row for the item...
    expect(p.counts.missing).toBe(1);                      // ...and the old one is flagged
    expect(row.cells['Owner']).toBe('human@example.com');  // with everything they put on it
    expect(row.cells['Management Notes']).toBe('mine');
    expect(row.cells['Sync Status']).toBe('Missing in Repo');
  });

  it('refuses to write to a row whose Item ID points at a different file', async () => {
    // Identity always includes the path, so a row bearing this Item ID but describing another
    // file cannot be this item - the ID was hand-edited, or two identities collided. Writing
    // over it would destroy whatever it actually describes.
    await run(items(ev('src/elsewhere.js', 'other')), T1);
    const row = target.rows[0];
    const [mine] = items(ev('src/a.js', 'one'));
    row.cells['Item ID'] = mine.itemId;
    const before = { ...row.cells };

    const p = await run(items(ev('src/a.js', 'one')), T2);
    expect(p.counts.create).toBe(0);
    expect(p.counts.update).toBe(0);
    expect(row.cells['Item']).toBe(before['Item']);        // untouched
    expect(p.changes[0].reasons.join(' ')).toMatch(/is for a different file/);
  });
});

describe('a raise is dismissible, and stays dismissed (round-15 R15-03)', () => {
  const risk = (over: Partial<RawEvidence> = {}): RawEvidence => ({
    extractor: 'risk-heuristics', sourceType: 'Risk heuristic', path: 'src/auth/session.js',
    line: 5, excerpt: 'FIXME in a security-sensitive file: sessions never expire', ...over,
  });

  it('does not re-tick a box the person cleared, even when the item itself wants review', async () => {
    // Pinning the baselines made the raise durable but destroyed the ownership record, so on
    // any item the model wants reviewed the box came back after every clear. One boolean cannot
    // say both "the box is ticked" and "who ticked it" - the raise is recorded separately now.
    await run(normalize([risk()]), T1);
    const row = target.rows[0];
    row.cells['Repo Status'] = 'Done';                     // stale mirror
    row.cells['Status'] = 'In Progress';                   // and somebody disagrees
    await run(normalize([risk()]), T2);
    expect(row.cells['Human Review']).toBe(true);          // raised

    row.cells['Human Review'] = false;                     // the person dismisses it
    await run(normalize([risk({ commit: 'abc1234' })]), T3);
    expect(row.cells['Human Review']).toBe(false);
    await run(normalize([risk({ commit: 'def5678' })]), '2026-08-24T13:00:00Z');
    expect(row.cells['Human Review']).toBe(false);         // and it stays dismissed
  });
});

describe('round-16 review regressions', () => {
  const risk = (over: Partial<RawEvidence> = {}): RawEvidence => ({
    extractor: 'risk-heuristics', sourceType: 'Risk heuristic', path: 'src/auth/session.js',
    line: 5, excerpt: 'FIXME in a security-sensitive file: sessions never expire', ...over,
  });

  it('refuses a different-file row even when it carries no fingerprint (R16-01)', async () => {
    // The guard was gated on a populated Repo Fingerprint, so an imported or hand-made row -
    // exactly the kind that has none - could still be overwritten with another item's content
    // while its Owner and Management Notes stayed attached to it.
    await run(items(ev('src/elsewhere.js', 'other')), T1);
    const row = target.rows[0];
    const [mine] = items(ev('src/a.js', 'one'));
    row.cells['Item ID'] = mine.itemId;
    delete row.cells['Repo Fingerprint'];                  // as an imported row would be
    row.cells['Owner'] = 'someone@example.com';
    const before = { ...row.cells };

    const p = await run(items(ev('src/a.js', 'one')), T2);
    expect(p.counts.update).toBe(0);
    expect(row.cells['Item']).toBe(before['Item']);        // untouched
    expect(row.cells['Owner']).toBe('someone@example.com');
  });

  it('leaves a blank-Source row to the normal path (R16-01)', async () => {
    // A row with no Source says nothing about which item it is, so the guard must not fire.
    await run(items(ev('src/a.js', 'one')), T1);
    const row = target.rows[0];
    delete row.cells['Source'];
    const p = await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(p.counts.update).toBe(1);
    expect(row.cells['Source']).toBeDefined();             // and it gets repaired
  });

  it('treats a dismissal as final from every baseline history (R16-02)', async () => {
    // Ending the raise when the person unticked the box was not a dismissal: with the baselines
    // sitting at false the ownership rule saw them agreeing with the now-empty box, called it
    // ours, and re-ticked it on any item the model wants reviewed. Ten of the thirty-six
    // histories did that, so the fixture has to walk them rather than pick a lucky one.
    for (const cache of [undefined, false, true]) {
      for (const mirror of [undefined, false, true]) {
        target = new MemoryTarget(COLUMN_TITLES, 'sheet-1');
        state = { version: 1, sheetId: 'sheet-1', items: {} };
        await run(normalize([risk()]), T1);
        const row = target.rows[0];
        const id = normalize([risk()])[0].itemId;

        row.cells['Repo Status'] = 'Done';                 // stale mirror
        row.cells['Status'] = 'In Progress';               // and somebody disagrees
        if (mirror === undefined) delete row.cells['Repo Review']; else row.cells['Repo Review'] = mirror;
        if (state.items[id]) state.items[id].lastWrittenHumanReview = cache;

        await run(normalize([risk()]), T2);
        expect(row.cells['Human Review'], `raised with cache=${cache} mirror=${mirror}`).toBe(true);

        row.cells['Human Review'] = false;                 // the person dismisses it
        for (const commit of ['abc1234', 'def5678', 'aaa9999']) {
          await run(normalize([risk({ commit })]), T3);
          expect(row.cells['Human Review'], `after ${commit}, cache=${cache} mirror=${mirror}`).toBe(false);
        }
      }
    }
  });

});

describe('round-17 review regressions', () => {
  const risk = (over: Partial<RawEvidence> = {}): RawEvidence => ({
    extractor: 'risk-heuristics', sourceType: 'Risk heuristic', path: 'src/auth/session.js',
    line: 5, excerpt: 'FIXME in a security-sensitive file: sessions never expire', ...over,
  });

  it('does not treat two different secret-bearing paths as the same file (R17-01)', async () => {
    // Source comparison used to normalise `[REDACTED-abc12345]` down to `[REDACTED]`, which was
    // only ever needed by legacy-row adoption. It turned two different secret-bearing paths into
    // the same string - the exact thing the discriminator exists to prevent - so one item's row
    // could be written over another's while its Owner and Notes stayed attached.
    const at = (secret: string): RawEvidence => ({
      extractor: 'todo-comments', sourceType: 'TODO comment', path: `src/api_key=${secret}/a.ts`,
      line: 1, excerpt: 'TODO: add retry',
    });
    const [mine] = normalize([at('aaaaaaaaaaaa')]);
    await run(normalize([at('bbbbbbbbbbbb')]), T1);        // the sheet holds the OTHER path
    const row = target.rows[0];
    row.cells['Item ID'] = mine.itemId;                    // but wearing this item's ID
    row.cells['Owner'] = 'owner-of-b@example.com';
    row.cells['Management Notes'] = 'belongs to B';
    const before = { ...row.cells };

    const p = await run(normalize([at('aaaaaaaaaaaa')]), T2);
    expect(p.counts.update).toBe(0);                       // refused
    expect(row.cells['Source']).toBe(before['Source']);
    expect(row.cells['Owner']).toBe('owner-of-b@example.com');
    expect(row.cells['Management Notes']).toBe('belongs to B');
  });

  it('does not re-tick a dismissed raise when the item then disappears (R17-02)', async () => {
    // The absent path never consulted the raise flag, so a person could dismiss a raised row,
    // the item could vanish, and the tool would tick the box straight back.
    const other = ev('src/other.js', 'keep me');
    await run(normalize([risk(), other]), T1);
    const row = target.rows[0];
    row.cells['Repo Status'] = 'Done';                     // stale mirror
    row.cells['Status'] = 'In Progress';                   // and somebody disagrees
    await run(normalize([risk(), other]), T2);
    expect(row.cells['Human Review']).toBe(true);          // raised

    row.cells['Human Review'] = false;                     // dismissed
    await run(normalize([other]), T3);                     // and now the item vanishes
    expect(row.cells['Sync Status']).toBe('Missing in Repo');
    expect(row.cells['Human Review']).toBe(false);         // their dismissal survives
  });

  it('keeps a dismissal even if the local state file is lost (R17-02)', async () => {
    // The permanent bit lives only in state.json, so losing that file must not resurrect the
    // tick. Moving the mirror with the raise is what makes a later dismissal read as theirs.
    await run(normalize([risk()]), T1);
    const row = target.rows[0];
    row.cells['Repo Status'] = 'Done';
    row.cells['Status'] = 'In Progress';
    // A historical row whose mirror says false - reachable on imported or hand-repaired sheets.
    // This is the case where the mirror move is the only thing standing between a dismissal and
    // a re-tick, because the item itself is one the model wants reviewed.
    row.cells['Repo Review'] = false;
    await run(normalize([risk()]), T2);
    expect(row.cells['Human Review']).toBe(true);
    expect(row.cells['Repo Review']).toBe(true);           // the mirror moved with it

    row.cells['Human Review'] = false;                     // dismissed
    state = { version: 1, sheetId: 'sheet-1', items: {} }; // and the cache is gone
    await run(normalize([risk({ commit: 'abc1234' })]), T3);
    expect(row.cells['Human Review']).toBe(false);
  });
});

describe('round-18 review regressions', () => {
  it('is not fooled by a filename that begins like another one (R18-01)', async () => {
    // The guard parsed the human-readable Source, which is `path[:line] - evidence type`. A
    // filename can contain those separators, so `src/a.ts - evil.ts` produces a Source that
    // begins exactly like `src/a.ts` and was accepted as the same file. No parsing can tell
    // them apart, which is why the path now has its own machine-readable column.
    for (const impostor of ['src/a.ts - evil.ts', 'src/a.ts:evil.ts']) {
      target = new MemoryTarget(COLUMN_TITLES, 'sheet-1');
      state = { version: 1, sheetId: 'sheet-1', items: {} };
      await run(items(ev(impostor, 'other')), T1);
      const row = target.rows[0];
      const [mine] = items(ev('src/a.ts', 'one'));
      row.cells['Item ID'] = mine.itemId;                  // the collision this guard contains
      row.cells['Owner'] = 'owner-of-impostor@example.com';
      const before = { ...row.cells };

      const p = await run(items(ev('src/a.ts', 'one')), T2);
      expect(p.counts.update, impostor).toBe(0);
      expect(row.cells['Item'], impostor).toBe(before['Item']);
      expect(row.cells['Owner'], impostor).toBe('owner-of-impostor@example.com');
    }
  });

  it('does not strand a row written before the Repo Path column existed (R18-02)', async () => {
    // An older row has no Repo Path at all. Refusing those would leave them permanently
    // unwritable AND unflagged, because the item's ID is already accounted for.
    await run(items(ev('src/a.js', 'one')), T1);
    const row = target.rows[0];
    delete row.cells['Repo Path'];                         // as an older build left it

    const p = await run(items(ev('src/a.js', 'one', { commit: 'abc1234' })), T2);
    expect(p.counts.update).toBe(1);
    expect(row.cells['Repo Path']).toBe('src/a.js');       // and it is filled in
    expect(row.cells['Owner']).toBeUndefined();
  });
});

describe('round-19 review regressions', () => {
  it('refuses a same-ID row that has neither a recorded path nor our fingerprint (R19-01)', async () => {
    // Treating a blank Repo Path as trustworthy left the guard switched off on exactly the
    // sheets the column was added to protect. A blank value only means "written by an older
    // build" if this tool wrote the row at all, and the fingerprint is what says so.
    await run(items(ev('src/elsewhere.js', 'other')), T1);
    const row = target.rows[0];
    const [mine] = items(ev('src/a.js', 'one'));
    row.cells['Item ID'] = mine.itemId;
    delete row.cells['Repo Path'];
    delete row.cells['Repo Fingerprint'];                  // nobody's row
    row.cells['Owner'] = 'owner-of-other@example.com';
    const before = { ...row.cells };

    const p = await run(items(ev('src/a.js', 'one')), T2);
    expect(p.counts.update).toBe(0);
    expect(row.cells['Item']).toBe(before['Item']);
    expect(row.cells['Owner']).toBe('owner-of-other@example.com');
  });

  it('backfills a path and repairs a drifted Source without touching the baselines (R19-02)', async () => {
    // Source is excluded from the fingerprint, so it can drift with nothing noticing. Repair it
    // narrowly: a full update here would rewrite Repo Status and Repo Fingerprint, which is how
    // a genuine conflict was destroyed several rounds ago.
    await run(items(ev('src/a.js', 'one')), T1);
    const row = target.rows[0];
    const baseline = row.cells['Repo Status'];
    const fingerprint = row.cells['Repo Fingerprint'];
    delete row.cells['Repo Path'];
    row.cells['Source'] = 'stale text';

    const p = await run(items(ev('src/a.js', 'one')), T2);
    expect(Object.keys(p.changes[0].cells).sort()).toEqual(['Last Synced', 'Repo Path', 'Source']);
    expect(row.cells['Repo Path']).toBe('src/a.js');
    expect(row.cells['Source']).toMatch(/^src\/a\.js:/);
    expect(row.cells['Repo Status']).toBe(baseline);       // baselines untouched
    expect(row.cells['Repo Fingerprint']).toBe(fingerprint);

    const p2 = await run(items(ev('src/a.js', 'one')), T3);
    expect(p2.counts.unchanged).toBe(1);                   // and it settles
  });

  it('refuses a sheet that has no Repo Path column at all (R19-01)', async () => {
    // The engine trusts a blank value as "older build". That is only safe because a sheet
    // missing the column entirely is refused before any of it runs.
    const titles = COLUMN_TITLES.filter((t) => t !== 'Repo Path');
    const sheet = { id: 1, name: 's', rows: [], columns: titles.map((title, i) => ({ id: 100 + i, title, type: 'TEXT' })) };
    const { SmartsheetClient } = await import('../src/adapters/smartsheet/client.js');
    const { SmartsheetTarget } = await import('../src/adapters/smartsheet/target.js');
    const fetchImpl = (async () => new Response(JSON.stringify(sheet), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const t = new SmartsheetTarget(new SmartsheetClient({ token: 't', fetchImpl, sleep: async () => {} }), '1');
    await expect(t.readRows()).rejects.toMatchObject({ message: /Repo Path/ });
  });
});
