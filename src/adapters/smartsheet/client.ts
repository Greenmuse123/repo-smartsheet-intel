/**
 * Thin Smartsheet REST client.
 *
 * What: the four calls we need (get sheet, create sheet, add rows, update rows) over `fetch`,
 *       with retry + exponential backoff on 429 (errorCode 4003) and 5xx, batching, and a
 *       single in-flight write per sheet. Errors are turned into plain-language messages.
 * Use:  `new SmartsheetClient({ token, fetchImpl? })`.
 * Facts (developers.smartsheet.com, verified 2026-08-24): base https://api.smartsheet.com/2.0;
 *       300 requests/min per token; 429 => {errorCode:4003}; guidance = back off (SDKs use
 *       exponential); cells silently truncate at 4000 chars; POST /sheets needs one primary column.
 */
export interface SheetColumn { id: number; title: string; type: string; primary?: boolean; options?: string[] }
export interface SheetCell { columnId: number; value?: string | number | boolean; displayValue?: string }
export interface SheetRow { id: number; rowNumber?: number; cells: SheetCell[] }
/** One historical value of a cell. `modifiedAt` is ISO-8601. */
export interface CellHistoryEntry { value?: string | number | boolean; modifiedAt?: string; modifiedBy?: { email?: string; name?: string } }

export interface Sheet { id: number; name: string; columns: SheetColumn[]; rows: SheetRow[]; permalink?: string }

export interface RowToAdd { toBottom: true; cells: Array<{ columnId: number; value: string | number | boolean }> }
export interface RowToUpdate { id: number; cells: Array<{ columnId: number; value: string | number | boolean }> }

export class SmartsheetError extends Error {
  constructor(message: string, public readonly status: number, public readonly errorCode?: number, public readonly resolution?: string) {
    super(message);
    this.name = 'SmartsheetError';
  }
}

export interface ClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  /** base delay in ms for backoff; tests set this to 1 */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, waitMs: number, reason: string) => void;
}

export class SmartsheetClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry?: ClientOptions['onRetry'];
  private writeChain: Promise<unknown> = Promise.resolve();
  public requestCount = 0;

  private readonly token: string;

  constructor(private readonly opts: ClientOptions) {
    // Trim at the boundary. A token pasted with a trailing newline is a real and common
    // mistake; validating the trimmed value but sending the raw one produced a confusing
    // 401 for a token that was actually correct.
    this.token = (opts.token ?? '').trim();
    if (!this.token) {
      throw new SmartsheetError('No Smartsheet access token was provided.', 0, undefined,
        'Set SMARTSHEET_ACCESS_TOKEN in your environment (or .env). Never put it in project-config.yaml.');
    }
    this.base = (opts.baseUrl ?? 'https://api.smartsheet.com/2.0').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 5;
    this.backoffMs = opts.backoffMs ?? 2000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onRetry = opts.onRetry;
  }

  async getSheet(sheetId: string | number): Promise<Sheet> {
    return this.request<Sheet>('GET', `/sheets/${sheetId}`);
  }

  async createSheet(body: { name: string; columns: Array<Record<string, unknown>> }): Promise<{ id: number; name: string; permalink?: string; columns: SheetColumn[] }> {
    const res = await this.request<{ result: { id: number; name: string; permalink?: string; columns: SheetColumn[] } }>('POST', '/sheets', body);
    return res.result;
  }

  /** Adds rows in batches. Returns created row ids in input order. */
  /**
   * Every value a single cell has held, newest first.
   *
   * Smartsheet documents this as resource-intensive and rate-limits it far harder than
   * everything else (30 requests per minute per token), so it is only ever asked about a cell
   * we are about to CLEAR - never in bulk. See `applyPlan`.
   */
  async cellHistory(sheetId: string | number, rowId: number, columnId: number): Promise<CellHistoryEntry[]> {
    const res = await this.request<{ data?: CellHistoryEntry[] }>(
      'GET', `/sheets/${sheetId}/rows/${rowId}/columns/${columnId}/history?include=columnType&level=0`,
    );
    return res.data ?? [];
  }

  async addRows(sheetId: string | number, rows: RowToAdd[], batchSize = 400): Promise<number[]> {
    const ids: number[] = [];
    for (const batch of chunk(rows, batchSize)) {
      const res = await this.serialized(() => this.request<{ result: SheetRow[] }>('POST', `/sheets/${sheetId}/rows?allowPartialSuccess=false`, batch));
      ids.push(...res.result.map((r) => r.id));
    }
    return ids;
  }

  async updateRows(sheetId: string | number, rows: RowToUpdate[], batchSize = 400): Promise<number> {
    let n = 0;
    for (const batch of chunk(rows, batchSize)) {
      const res = await this.serialized(() => this.request<{ result: SheetRow[] | { ids?: number[] } }>('PUT', `/sheets/${sheetId}/rows?allowPartialSuccess=false`, batch));
      if (Array.isArray(res.result)) n += res.result.length;
      else if (Array.isArray(res.result?.ids)) n += res.result.ids.length;
      else throw new SmartsheetError('Smartsheet returned an unrecognised response to a row update.', 200, undefined, 'The rows may or may not have been written. Re-run `rsi sync --dry-run` to see the current state before syncing again.');
    }
    return n;
  }

  /** Writes to one sheet never overlap. */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      this.requestCount++;
      let res: Response;
      try {
        res = await this.fetchImpl(this.base + path, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        if (attempt >= this.maxRetries) throw new SmartsheetError(`Could not reach Smartsheet: ${(e as Error).message}`, 0, undefined, 'Check your network connection and try again.');
        await this.backoff(++attempt, 'network error');
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      const payload = await safeJson(res);
      const code = payload?.errorCode as number | undefined;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.backoff(++attempt, res.status === 429 ? 'rate limit (429 / errorCode 4003)' : `server error ${res.status}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
        continue;
      }
      throw toFriendly(res.status, code, payload?.message);
    }
  }

  private async backoff(attempt: number, reason: string, forcedMs?: number): Promise<void> {
    const wait = forcedMs ?? this.backoffMs * 2 ** (attempt - 1);
    this.onRetry?.(attempt, wait, reason);
    await this.sleep(wait);
  }
}

function toFriendly(status: number, code: number | undefined, message?: string): SmartsheetError {
  if (status === 401 || code === 1002 || code === 1003) {
    return new SmartsheetError('Smartsheet rejected the access token.', status, code, 'Check SMARTSHEET_ACCESS_TOKEN: it may be missing, expired, or pasted with extra spaces. Generate a new token under Account > Apps & Integrations > API Access.');
  }
  // 1004 is "not authorized to perform this action" - the token is valid, the operation is
  // not permitted. Reporting it as a bad token sends people to regenerate a working token.
  if (code === 1004) {
    return new SmartsheetError('The token is valid but is not authorized for this action.', status, code,
      'Check that the token owner has Editor (not Viewer) access to the sheet, and that your plan allows this operation.');
  }
  if (status === 403) {
    // 1013 is a plan/licence restriction, not a sheet-sharing problem, and it is what a
    // Free or trial account hits on POST /sheets - where no sheet exists to share yet.
    if (code === 1013) return new SmartsheetError('Your Smartsheet plan does not allow this operation.', status, code, 'The Smartsheet API requires a Business plan or higher; Free and 30-day trial accounts cannot use it. Use `rsi export-csv` and import the file instead.');
    return new SmartsheetError('The token is valid but is not allowed to perform this operation.', status, code, 'If you are syncing an existing sheet, share it with the token owner as Editor. If you are creating one, check that your plan and licence allow API sheet creation.');
  }
  if (status === 404 || code === 1006) return new SmartsheetError('The sheet was not found.', status, code, 'Check SMARTSHEET_SHEET_ID, or run `rsi setup-sheet` to create a fresh sheet.');
  if (status === 429) return new SmartsheetError('Smartsheet rate limit exceeded and retries were exhausted.', status, code, 'Wait a minute and run the sync again; nothing was partially applied within the failing batch.');
  return new SmartsheetError(`Smartsheet returned an error (${status}${code ? `, code ${code}` : ''}): ${message ?? 'no message'}`, status, code, 'Re-run with --verbose for details.');
}

async function safeJson(res: Response): Promise<any | undefined> {
  try { return await res.json(); } catch { return undefined; }
}

export function chunk<T>(arr: T[], size: number): T[][] {
  // A size of 0 or less would never advance `i` - an infinite loop rather than a bad batch.
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`chunk size must be a positive integer, received ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
