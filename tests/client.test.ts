import { describe, it, expect } from 'vitest';
import { SmartsheetClient, SmartsheetError, chunk } from '../src/adapters/smartsheet/client.js';
import { sheetCreateBody, COLUMNS } from '../src/adapters/smartsheet/schema.js';

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
