/**
 * `rsi demo` - the full sync storyline against an in-memory sheet, no token needed.
 *
 * Runs the real analyzer and the real sync engine; only the Smartsheet transport is replaced
 * by MemoryTarget. Temporarily edits two files in the sample repo and restores them at the end
 * (a copy of the repo is used if --repo points somewhere other than the bundled sample).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProjectConfig } from '../config/index.js';
import { analyze } from '../pipeline.js';
import { MemoryTarget } from '../sync/target.js';
import { COLUMN_TITLES } from '../adapters/smartsheet/schema.js';
import { planSync, applyPlan, describePlan } from '../sync/engine.js';
import type { SyncState } from '../sync/state.js';
import { log } from '../log/logger.js';

const say = (s = '') => process.stdout.write(s + '\n');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runDemo(cfg: ProjectConfig & { configDir: string }, opts: { fast?: boolean } = {}): Promise<void> {
  const root = resolve(cfg.configDir, cfg.project.repository);
  const readme = join(root, 'README.md');
  const session = join(root, 'src', 'auth', 'session.js');
  const files = [readme, session].map((p) => { try { return [p, readFileSync(p, 'utf8')] as const; } catch { return undefined; } }).filter(Boolean) as Array<readonly [string, string]>;
  const restore = () => { for (const [p, c] of files) writeFileSync(p, c); };
  const wait = async () => { if (!opts.fast) await pause(1200); };

  const target = new MemoryTarget(COLUMN_TITLES, 'demo');
  const state: SyncState = { version: 1, sheetId: 'demo', items: {} };
  let tick = 0;
  const step = async (title: string, note: string) => {
    say(); say(`==== ${title}`); say(note); say();
    log.silent(false);
    const r = await analyze(cfg);
    log.silent(true);
    const now = `2026-08-24T10:0${tick++}:00Z`;
    const plan = planSync(r.items, await target.readRows(), state, now);
    for (const l of describePlan(plan, target.rows.length)) say('  ' + l);
    for (const c of plan.changes) if (c.action !== 'unchanged' && c.action !== 'create') say(`  ${c.action.toUpperCase().padEnd(9)} ${c.item.itemId}  ${c.item.item}  (${c.reasons.join('; ')})`);
    await applyPlan(plan, target, state, now);
    await wait();
  };
  const show = (label: string, match: (item: string) => boolean) => {
    const row = target.rows.find((r) => match(String(r.cells['Item'] ?? '')));
    if (!row) return;
    const c = row.cells;
    say(`  Sheet row "${label}": Status=${c['Status']} | Repo Status=${c['Repo Status']} | Sync Status=${c['Sync Status']} | Human Review=${c['Human Review'] ? 'checked' : 'clear'}`);
  };

  try {
    say('rsi demo: real analyzer + real sync engine; only the Smartsheet transport is an in-memory sheet.');
    say('Nothing is sent anywhere. The sample repo is edited and restored automatically.');
    await step('1. First sync', 'Empty sheet. Every item found in the repository becomes a row.');
    await step('2. Run it again with no changes', 'Idempotent: no duplicates, no writes.');

    if (files.length === 2) {
      writeFileSync(readme, files[0][1].replace('- [ ] Email the customer', '- [x] Email the customer'));
      await step('3. A developer ticks a README checkbox', 'The same row is updated (matched by Item ID), Status Not Started -> Done.');
      show('Email the customer...', (s) => s.startsWith('Email the customer'));

      const row = target.rows.find((r) => String(r.cells['Item']).startsWith('Email the customer'));
      if (row) row.cells['Status'] = 'Blocked';
      writeFileSync(readme, files[0][1]);
      await step('4. A PM sets that row to Blocked in the sheet; the developer unticks the box', 'Both sides changed Status and disagree: the human value is kept, the repo value goes to Repo Status, the row is flagged Conflict.');
      show('Email the customer...', (s) => s.startsWith('Email the customer'));

      writeFileSync(session, files[1][1].replace(/\s*\/\/ FIXME:[^\n]*/, ''));
      await step('5. The FIXME comment is deleted from the code', 'The tool cannot know if it was fixed or just removed, so the row is kept and marked Missing in Repo for a human.');
      show('sessions never expire', (s) => s.startsWith('sessions never expire'));
    }
    say(); say(`Final sheet: ${target.rows.length} rows, ${target.rows.filter((r) => r.cells['Human Review'] === true).length} flagged for human review, 0 rows deleted, ${target.writes} write batches total.`);
  } finally {
    restore();
  }
}
