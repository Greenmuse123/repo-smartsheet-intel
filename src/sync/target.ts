/**
 * SheetTarget - the narrow interface the sync engine needs from "a sheet".
 *
 * What: read the sheet as rows keyed by column title; add rows; update rows.
 * Implementations: SmartsheetTarget (real), MemoryTarget (tests + dry-run safety proof).
 */
export type CellValues = Record<string, string | number | boolean | null>;

export interface TargetRow { rowId: number; cells: CellValues }

export interface SheetTarget {
  readonly sheetId: string;
  readonly columnTitles: string[];
  /** id -> row (cells keyed by column title) */
  readRows(): Promise<TargetRow[]>;
  addRows(rows: CellValues[]): Promise<number[]>;
  updateRows(rows: Array<{ rowId: number; cells: CellValues }>): Promise<number>;
}

/** In-memory implementation used by tests and as the dry-run sink. */
export class MemoryTarget implements SheetTarget {
  readonly sheetId: string;
  readonly columnTitles: string[];
  rows: TargetRow[] = [];
  private nextId = 1000;
  writes = 0;
  constructor(columnTitles: string[], sheetId = 'memory') { this.columnTitles = columnTitles; this.sheetId = sheetId; }
  async readRows(): Promise<TargetRow[]> { return this.rows.map((r) => ({ rowId: r.rowId, cells: { ...r.cells } })); }
  async addRows(rows: CellValues[]): Promise<number[]> {
    this.writes++;
    return rows.map((cells) => { const rowId = this.nextId++; this.rows.push({ rowId, cells: { ...cells } }); return rowId; });
  }
  async updateRows(rows: Array<{ rowId: number; cells: CellValues }>): Promise<number> {
    this.writes++;
    for (const u of rows) { const r = this.rows.find((x) => x.rowId === u.rowId); if (r) Object.assign(r.cells, u.cells); }
    return rows.length;
  }
}
