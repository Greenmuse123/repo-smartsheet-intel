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
    expect(row.cells['Sync Status']).toBe('Missing in Repo');

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
