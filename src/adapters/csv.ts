/**
 * CSV fallback.
 *
 * What: writes `smartsheet_import.csv` with the exact column order of the Smartsheet schema,
 *       plus `column-definitions.json` so a human can build the sheet by hand.
 *       CSV output is UTF-8 with a BOM because Smartsheet mis-detects BOM-less files
 *       when they contain multibyte characters.
 * Use:  `csvFor(items, now)` → string; `columnDefinitionsJson()`.
 */
import type { ProjectItem } from '../model/types.js';
import { COLUMNS, COLUMN_TITLES } from './smartsheet/schema.js';
import { humanSeedCells, repoCells, reviewCells, sharedCells } from './smartsheet/mapper.js';

function q(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvFor(items: ProjectItem[], now: string): string {
  const lines = [COLUMN_TITLES.map(q).join(',')];
  for (const it of items) {
    const cells = { ...repoCells(it, 'New', now), ...humanSeedCells(it), ...sharedCells(it.status), ...reviewCells(it.humanReviewRequired) };
    lines.push(COLUMN_TITLES.map((t) => q(cells[t])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function columnDefinitionsJson(): string {
  return JSON.stringify(COLUMNS.map((c) => ({ title: c.title, type: c.type, primary: !!c.primary, options: c.options ?? null, writtenBy: c.writtenBy, technical: !!c.technical, purpose: c.purpose })), null, 2);
}
