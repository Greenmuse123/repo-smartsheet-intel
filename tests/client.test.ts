import { describe, it, expect } from 'vitest';
import { SmartsheetClient, SmartsheetError, chunk } from '../src/adapters/smartsheet/client.js';
import { sheetCreateBody, COLUMNS } from '../src/adapters/smartsheet/schema.js';
import { SmartsheetTarget } from '../src/adapters/smartsheet/target.js';

type Resp = { status: number; body?: unknown; headers?: Record<string, string> };
function fakeFetch(script: Resp[]) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const r = script.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const noSleep = async () => {};

describe('credentials', () => {
  it('fails clearly and safely with no token', () => {
    expect(() => new SmartsheetClient({ token: '' })).toThrow(SmartsheetError);
    try { new SmartsheetClient({ token: '   ' }); } catch (e) { expect((e as SmartsheetError).resolution).toMatch(/SMARTSHEET_ACCESS_TOKEN/); }
  });
  it('turns a 401 into a plain-language error without retrying', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 401, body: { errorCode: 1002, message: 'Your Access Token is invalid.' } }]);
    const c = new SmartsheetClient({ token: 'bad', fetchImpl, sleep: noSleep });
    await expect(c.getSheet(1)).rejects.toMatchObject({ name: 'SmartsheetError', status: 401, message: /rejected the access token/ });
    expect(calls).toHaveLength(1);
  });
});

describe('rate limits and transient failures', () => {
  it('backs off on 429 (errorCode 4003) and succeeds on retry', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 429, body: { errorCode: 4003, message: 'Rate limit exceeded.' } }, { status: 500 }, { status: 200, body: { id: 1, name: 's', columns: [], rows: [] } }]);
    const waits: number[] = [];
    const c = new SmartsheetClient({ token: 't', fetchImpl, backoffMs: 10, sleep: async (ms) => { waits.push(ms); }, maxRetries: 5 });
    const s = await c.getSheet(1);
    expect(s.id).toBe(1);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([10, 20]); // exponential
  });
  it('honours Retry-After when present', async () => {
    const { fetchImpl } = fakeFetch([{ status: 429, body: { errorCode: 4003 }, headers: { 'retry-after': '3' } }, { status: 200, body: { id: 1, columns: [], rows: [] } }]);
    const waits: number[] = [];
    const c = new SmartsheetClient({ token: 't', fetchImpl, backoffMs: 10, sleep: async (ms) => { waits.push(ms); } });
    await c.getSheet(1);
    expect(waits).toEqual([3000]);
  });
  it('gives up after maxRetries with an understandable message', async () => {
    const { fetchImpl, calls } = fakeFetch(Array.from({ length: 10 }, () => ({ status: 429, body: { errorCode: 4003 } })));
    const c = new SmartsheetClient({ token: 't', fetchImpl, backoffMs: 1, sleep: noSleep, maxRetries: 2 });
    await expect(c.getSheet(1)).rejects.toMatchObject({ message: /rate limit exceeded and retries were exhausted/ });
    expect(calls).toHaveLength(3);
  });
});

describe('batching', () => {
  it('splits large row sets into batches and preserves order of returned ids', async () => {
    const script: Resp[] = [
      { status: 200, body: { result: Array.from({ length: 400 }, (_, i) => ({ id: i + 1 })) } },
      { status: 200, body: { result: Array.from({ length: 50 }, (_, i) => ({ id: 401 + i })) } },
    ];
    const { fetchImpl, calls } = fakeFetch(script);
    const c = new SmartsheetClient({ token: 't', fetchImpl, sleep: noSleep });
    const rows = Array.from({ length: 450 }, (_, i) => ({ toBottom: true as const, cells: [{ columnId: 1, value: `r${i}` }] }));
    const ids = await c.addRows(7, rows, 400);
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toHaveLength(400);
    expect(calls[1].body).toHaveLength(50);
    expect(ids).toHaveLength(450);
    expect(ids[449]).toBe(450);
    expect(calls[0].url).toContain('/sheets/7/rows');
  });
  it('chunk helper', () => { expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]); });
});

describe('schema', () => {
  it('creates exactly one primary column and picklists carry options', () => {
    const body = sheetCreateBody('X');
    expect(body.columns.filter((c) => c.primary)).toHaveLength(1);
    expect(body.columns.find((c) => c.title === 'Status')).toMatchObject({ type: 'PICKLIST', options: expect.arrayContaining(['Done', 'Unknown']) });
    expect(COLUMNS.filter((c) => c.writtenBy === 'human').map((c) => c.title)).toEqual(['Priority', 'Owner', 'Dependency', 'Milestone', 'Due Date', 'Management Notes']);
  });
});

describe('hardening found by adversarial review', () => {
  it('chunk() refuses a non-positive size instead of looping forever', () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => chunk([1, 2, 3], -1)).toThrow(RangeError);
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it('maps a 403 plan restriction (1013) to plan guidance, not a sheet-sharing message', async () => {
    const { fetchImpl } = fakeFetch([{ status: 403, body: { errorCode: 1013, message: 'not available for your plan' } }]);
    const c = new SmartsheetClient({ token: 't', fetchImpl, sleep: noSleep });
    let err: SmartsheetError | undefined;
    try { await c.createSheet(sheetCreateBody('X')); } catch (e) { err = e as SmartsheetError; }
    expect(err).toBeInstanceOf(SmartsheetError);
    expect(err!.status).toBe(403);
    expect(err!.message).toMatch(/plan does not allow/);
    expect(err!.resolution).toMatch(/Business plan/);
    // and it must NOT tell the user to share a sheet that does not exist yet
    expect(err!.message).not.toMatch(/edit this sheet/);
  });

  it('does not report an unrecognised update response as a fully successful batch', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: { result: { unexpected: true } } }]);
    const c = new SmartsheetClient({ token: 't', fetchImpl, sleep: noSleep });
    await expect(c.updateRows(1, [{ id: 1, cells: [] }])).rejects.toMatchObject({ name: 'SmartsheetError', message: /unrecognised response/ });
  });
});

describe('the real Smartsheet target, not just the in-memory one (round-3 review regressions)', () => {
  const sheetOf = (titles: string[]) => ({
    id: 1, name: 's', rows: [],
    columns: titles.map((title, i) => ({ id: 100 + i, title, type: 'TEXT' })),
  });
  const clientReturning = (sheet: unknown) => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: sheet }]);
    return new SmartsheetClient({ token: 't', fetchImpl, sleep: noSleep });
  };
  const ALL = COLUMNS.map((c) => c.title);

  it('accepts a sheet that has the full schema', async () => {
    const t = new SmartsheetTarget(clientReturning(sheetOf(ALL)), '1');
    await expect(t.readRows()).resolves.toEqual([]);
  });

  it('refuses to sync a sheet missing Repo Review, the Human Review baseline (R6-01)', async () => {
    // Without it the engine cannot tell its own tick from a person's, so several merge paths
    // quietly lose a human decision. A sheet that cannot implement the documented behaviour
    // must fail loudly, exactly as one missing the Status baseline does.
    const t = new SmartsheetTarget(clientReturning(sheetOf(ALL.filter((x) => x !== 'Repo Review'))), '1');
    await expect(t.readRows()).rejects.toMatchObject({ name: 'SmartsheetError', message: /Repo Review/ });
  });

  it('refuses to sync a sheet missing Repo Status, the three-way merge baseline (R2-04)', async () => {
    // Repo Status is the sheet-side record of what WE last wrote. Without it the planner
    // cannot distinguish a human edit from a repository change on a fresh clone, so it must
    // fail loudly rather than mislabel one as the other.
    const t = new SmartsheetTarget(clientReturning(sheetOf(ALL.filter((x) => x !== 'Repo Status'))), '1');
    await expect(t.readRows()).rejects.toMatchObject({ name: 'SmartsheetError', message: /Repo Status/ });
  });

  it('refuses to sync a sheet missing Item ID, which would re-create every row (R2-04)', async () => {
    const t = new SmartsheetTarget(clientReturning(sheetOf(ALL.filter((x) => x !== 'Item ID'))), '1');
    await expect(t.readRows()).rejects.toMatchObject({ name: 'SmartsheetError', message: /Item ID/ });
  });
});

describe('error messages point at the real cause (round-3 review regressions)', () => {
  it('reports errorCode 1004 as an authorization problem, not a bad token (M-06)', async () => {
    // 1004 is "not authorized to perform this action". Calling it a rejected token sends
    // people off to regenerate a token that was working fine.
    const { fetchImpl } = fakeFetch([{ status: 403, body: { errorCode: 1004, message: 'Not authorized.' } }]);
    const c = new SmartsheetClient({ token: 't', fetchImpl, sleep: noSleep });
    await expect(c.getSheet(1)).rejects.toMatchObject({ errorCode: 1004, message: /not authorized for this action/ });
  });

  it('trims a token pasted with surrounding whitespace instead of sending it malformed (R2-06)', async () => {
    // The constructor validated token.trim() but sent the raw value, so a token with a
    // trailing newline passed local validation and then came back 401.
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { id: 1, name: 's', columns: [], rows: [] } }]);
    const c = new SmartsheetClient({ token: '  abc123\n', fetchImpl, sleep: noSleep });
    await c.getSheet(1);
    expect(calls).toHaveLength(1);
  });
});


describe('schema drift must not fail a whole batch (round-5 self-review)', () => {
  it('sends dropdown values with strict:false so an older sheet still accepts them', async () => {
    // Smartsheet parses PICKLIST cells strictly by default and this client sends
    // allowPartialSuccess=false, so one unrecognised option fails the ENTIRE batch. A sheet
    // created before a new Sync Status value existed would break completely on the next sync.
    const columns = COLUMNS.map((c, i) => ({ id: 100 + i, title: c.title, type: c.type }));
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: { id: 1, name: 's', columns, rows: [] } },
      { status: 200, body: { result: [{ id: 5001 }] } },
    ]);
    const client = new SmartsheetClient({ token: 't', fetchImpl, sleep: noSleep });
    const target = new SmartsheetTarget(client, '1');
    await target.readRows();
    await target.addRows([{ 'Item ID': 'RSI-X-1', 'Sync Status': 'Conflict (missing in repo)', 'Owner': '@team-b' }]);

    const sent = calls[1].body[0].cells as Array<{ columnId: number; value: string; strict?: boolean }>;
    const byId = new Map(columns.map((c) => [c.id, c.title]));
    const syncCell = sent.find((c) => byId.get(c.columnId) === 'Sync Status')!;
    const ownerCell = sent.find((c) => byId.get(c.columnId) === 'Owner')!;
    const idCell = sent.find((c) => byId.get(c.columnId) === 'Item ID')!;
    expect(syncCell).toMatchObject({ value: 'Conflict (missing in repo)', strict: false });
    expect(ownerCell).toMatchObject({ value: '@team-b', strict: false });
    expect(idCell.strict).toBeUndefined(); // plain text columns keep the default
  });
});

describe('the tool locks its own bookkeeping columns (round-24)', () => {
  it('asks Smartsheet to lock every column the tool writes', () => {
    // A locked column stops Editors changing it, which is the difference between asking people
    // not to touch the tool's notes and them not being able to by accident. Owners and Admins
    // can still unlock, so it is a guard rail rather than a boundary - and the README says so.
    // Assert the RULE, not a hand-picked list: seven of the tool's own columns were left
    // unlocked when the list was written by hand, while the docs claimed all of them were.
    const body = sheetCreateBody('T');
    const locked = new Set(body.columns.filter((c) => c.locked === true).map((c) => c.title));
    const repoOwned = COLUMNS.filter((c) => c.writtenBy === 'repo').map((c) => c.title);
    expect(repoOwned.length).toBeGreaterThan(10);
    for (const title of repoOwned) expect(locked.has(title), title).toBe(true);
    expect(locked.size).toBe(repoOwned.length);            // and nothing else is locked
  });

  it('leaves the columns people are meant to fill in unlocked', () => {
    const body = sheetCreateBody('T');
    const locked = new Set(body.columns.filter((c) => c.locked === true).map((c) => c.title));
    for (const c of COLUMNS.filter((x) => x.writtenBy !== 'repo')) {
      expect(locked.has(c.title), c.title).toBe(false);
    }
  });
});
