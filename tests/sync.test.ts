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
