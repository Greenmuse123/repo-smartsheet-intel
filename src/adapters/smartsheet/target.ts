/**
 * SmartsheetTarget - SheetTarget over the REST client. Translates column titles ↔ ids and
 * drops values for columns that do not exist in the sheet (logged once).
 */
import type { SheetTarget, TargetRow, CellValues } from '../../sync/target.js';
import { SmartsheetClient, SmartsheetError, type Sheet } from './client.js';
import { COLUMNS } from './schema.js';
import { log } from '../../log/logger.js';

/** Columns Smartsheet parses as contacts. Handles like `@team-b` are not valid emails. */
const CONTACT_COLUMNS = new Set(COLUMNS.filter((c) => c.type === 'CONTACT_LIST').map((c) => c.title));

/** Dropdown columns. See `toCells` for why these opt out of strict parsing. */
const PICKLIST_COLUMNS = new Set(COLUMNS.filter((c) => c.type === 'PICKLIST').map((c) => c.title));

/**
 * Without these the sheet has no stable identity and every run would re-create every row.
 * `Repo Status` is here too: it is the sheet-side record of the value WE last wrote, which is
 * the baseline of the three-way merge. Without it a fresh clone cannot tell a human edit from
 * a repository change, and would mislabel one as the other.
 */
const REQUIRED_COLUMNS = ['Item ID', 'Repo Fingerprint', 'Sync Status', 'Repo Status', 'Repo Review', 'Repo Path', 'Review Owner'];

export class SmartsheetTarget implements SheetTarget {
  readonly sheetId: string;
  columnTitles: string[] = [];
  private byTitle = new Map<string, number>();
  private byId = new Map<number, string>();
  private warnedMissing = new Set<string>();

  constructor(private readonly client: SmartsheetClient, sheetId: string, private readonly batchSize = 400) {
    this.sheetId = sheetId;
  }

  private index(sheet: Sheet): void {
    this.byTitle.clear(); this.byId.clear();
    for (const c of sheet.columns) { this.byTitle.set(c.title, c.id); this.byId.set(c.id, c.title); }
    this.columnTitles = sheet.columns.map((c) => c.title);

    // Identity columns are not optional. If `Item ID` is absent or renamed, creates would
    // omit the identity key and every subsequent run would add the same rows again - the
    // opposite of the idempotency this tool promises. Fail loudly instead.
    const missing = REQUIRED_COLUMNS.filter((t) => !this.byTitle.has(t));
    if (missing.length) {
      throw new SmartsheetError(
        `Sheet ${this.sheetId} is missing required column(s): ${missing.join(', ')}.`,
        400, undefined,
        'These columns carry row identity. Run `rsi setup-sheet` to create a sheet with the full schema, or add the columns with exactly these titles before syncing.',
      );
    }
  }

  async readRows(): Promise<TargetRow[]> {
    const sheet = await this.client.getSheet(this.sheetId);
    this.index(sheet);
    return sheet.rows.map((r) => {
      const cells: CellValues = {};
      for (const c of r.cells) { const t = this.byId.get(c.columnId); if (t && c.value !== undefined) cells[t] = c.value; }
      return { rowId: r.id, cells };
    });
  }

  private toCells(values: CellValues): Array<{ columnId: number; value: string | number | boolean; strict?: boolean }> {
    const out: Array<{ columnId: number; value: string | number | boolean; strict?: boolean }> = [];
    for (const [title, v] of Object.entries(values)) {
      const id = this.byTitle.get(title);
      if (id === undefined) {
        if (!this.warnedMissing.has(title)) { this.warnedMissing.add(title); log.warn(`Sheet has no "${title}" column; that value will not be written. Run \`rsi setup-sheet\` to create a sheet with the full schema.`); }
        continue;
      }
      if (v === null || v === undefined) continue; // Smartsheet clears cells with value "" - we never blank a cell implicitly
      // CONTACT_LIST cells are parsed strictly by default: anything that is not a valid
      // email is rejected, and with allowPartialSuccess=false one bad value fails the whole
      // batch. Owner is seeded from CODEOWNERS handles (@team-b) and TODO names (alice),
      // which are deliberately NOT email addresses, so those cells must opt out of strict
      // parsing and be stored as display values.
      if (CONTACT_COLUMNS.has(title)) { out.push({ columnId: id, value: v, strict: false }); continue; }
      // PICKLIST cells are also parsed strictly by default, and this client sends
      // allowPartialSuccess=false, so a single unrecognised option fails the ENTIRE batch.
      // A sheet created by an older version of this tool has an older set of options - adding
      // a Sync Status value would otherwise break every existing sheet until someone edited
      // the column by hand. The values written here always come from our own enums, so strict
      // parsing buys nothing; degrade to a stored display value instead of failing 500 rows.
      if (PICKLIST_COLUMNS.has(title)) { out.push({ columnId: id, value: v, strict: false }); continue; }
      out.push({ columnId: id, value: v });
    }
    return out;
  }

  /**
   * Reads the one cell's history and looks for a change that is not ours.
   *
   * This exists because a checkbox cannot record who ticked it. Comparing two snapshots one
   * sync apart cannot see a person clearing the box and ticking it again in between - the sheet
   * ends up holding exactly the value we left there. The history can see it.
   */
  async humanMovedReviewSince(rowId: number, sinceIso: string): Promise<boolean | 'unknown'> {
    const columnId = this.byTitle.get('Human Review');
    if (columnId === undefined) return 'unknown';
    const since = Date.parse(sinceIso);
    if (Number.isNaN(since)) return 'unknown';
    try {
      const [history, me] = await Promise.all([
        this.client.cellHistory(this.sheetId, rowId, columnId),
        this.client.currentUserEmail(),
      ]);
      return history.some((h) => {
        const at = h.modifiedAt ? Date.parse(h.modifiedAt) : NaN;
        if (!Number.isFinite(at) || at <= since) return false;
        // Our own writes appear in the history too. The boundary is the moment we last wrote
        // this cell, so anything after it should be somebody else - but clocks and retries make
        // that a thin guarantee, and the account that owns the token is a much better one.
        const who = h.modifiedBy?.email?.toLowerCase();
        return !(me && who && who === me);
      });
    } catch (e) {
      // Never let a bookkeeping question fail a sync - but never let it quietly cost somebody
      // their decision either. Saying "unknown" makes the caller keep what it found.
      log.warn(`Could not read the Human Review history for row ${rowId} (${(e as Error).message}); leaving that checkbox exactly as it is.`);
      return 'unknown';
    }
  }

  async addRows(rows: CellValues[]): Promise<number[]> {
    if (!rows.length) return [];
    return this.client.addRows(this.sheetId, rows.map((cells) => ({ toBottom: true as const, cells: this.toCells(cells) })), this.batchSize);
  }

  async updateRows(rows: Array<{ rowId: number; cells: CellValues }>): Promise<number> {
    if (!rows.length) return 0;
    return this.client.updateRows(this.sheetId, rows.map((r) => ({ id: r.rowId, cells: this.toCells(r.cells) })), this.batchSize);
  }
}
