/**
 * SmartsheetTarget - SheetTarget over the REST client. Translates column titles ↔ ids and
 * drops values for columns that do not exist in the sheet (logged once).
 */
import type { SheetTarget, TargetRow, CellValues } from '../../sync/target.js';
import { SmartsheetClient, type Sheet } from './client.js';
import { log } from '../../log/logger.js';

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

  private toCells(values: CellValues): Array<{ columnId: number; value: string | number | boolean }> {
    const out: Array<{ columnId: number; value: string | number | boolean }> = [];
    for (const [title, v] of Object.entries(values)) {
      const id = this.byTitle.get(title);
      if (id === undefined) {
        if (!this.warnedMissing.has(title)) { this.warnedMissing.add(title); log.warn(`Sheet has no "${title}" column; that value will not be written. Run \`rsi setup-sheet\` to create a sheet with the full schema.`); }
        continue;
      }
      if (v === null || v === undefined) continue; // Smartsheet clears cells with value "" - we never blank a cell implicitly
      out.push({ columnId: id, value: v });
    }
    return out;
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
