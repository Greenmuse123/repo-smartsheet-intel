import { describe, it, expect, beforeEach } from 'vitest';
import { planSync, applyPlan } from '../src/sync/engine.js';
import { MemoryTarget } from '../src/sync/target.js';
import type { SyncState } from '../src/sync/state.js';
import { normalize } from '../src/model/normalize.js';
import { COLUMN_TITLES } from '../src/adapters/smartsheet/schema.js';
import type { ProjectItem, RawEvidence } from '../src/model/types.js';
import { log } from '../src/log/logger.js';

log.silent();

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
