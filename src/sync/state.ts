/**
 * Local sync state (a cache, not the source of truth).
 *
 * What: remembers itemId → rowId + fingerprint + last-written status so later runs are fast.
 *       If the file is missing, the engine rebuilds everything it needs from the sheet's
 *       "Item ID", "Repo Fingerprint" and "Repo Status" columns - so a fresh clone still
 *       produces zero duplicates.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ItemState { rowId: number; fingerprint: string; lastWrittenStatus: string; lastSyncedAt: string }
export interface SyncState { version: 1; sheetId: string; items: Record<string, ItemState>; lastRunAt?: string }

export function loadState(dir: string, sheetId: string): SyncState {
  const p = join(dir, 'state.json');
  if (!existsSync(p)) return { version: 1, sheetId, items: {} };
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as SyncState;
    if (s.sheetId !== sheetId) return { version: 1, sheetId, items: {} }; // different sheet → start clean
    return s;
  } catch {
    return { version: 1, sheetId, items: {} };
  }
}

export function saveState(dir: string, state: SyncState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
}
