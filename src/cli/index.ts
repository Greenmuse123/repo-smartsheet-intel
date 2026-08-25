#!/usr/bin/env node
/**
 * `rsi` — Repo → Smartsheet Intelligence CLI.
 *
 * Commands: init · report · extract · export-csv · setup-sheet · sync [--dry-run]
 * Every command reads project-config.yaml (--config) and never modifies the repository.
 */
import { Command } from 'commander';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, defaultConfig, toYaml, ConfigError, ALL_EXTRACTORS, type ProjectConfig } from '../config/index.js';
import { analyze } from '../pipeline.js';
import { renderReport } from '../report/report.js';
import { csvFor, columnDefinitionsJson } from '../adapters/csv.js';
import { SmartsheetClient, SmartsheetError } from '../adapters/smartsheet/client.js';
import { SmartsheetTarget } from '../adapters/smartsheet/target.js';
import { sheetCreateBody, COLUMNS } from '../adapters/smartsheet/schema.js';
import { planSync, applyPlan, describePlan } from '../sync/engine.js';
import { loadState, saveState } from '../sync/state.js';
import { loadDotEnv } from './env.js';
import { log } from '../log/logger.js';

const program = new Command();
program.name('rsi').description('Turn a software repository into accurate, traceable Smartsheet project data.').version('0.1.0');
program.option('-c, --config <path>', 'path to project-config.yaml', 'project-config.yaml');
program.option('-v, --verbose', 'show per-extractor detail');

const now = () => new Date().toISOString();

function cfgOrDie(): ProjectConfig & { configDir: string } {
  const o = program.opts();
  log.setVerbose(!!o.verbose);
  try {
    const cfg = loadConfig(o.config);
    loadDotEnv([cfg.configDir, process.cwd()]);
    return cfg;
  } catch (e) { die(e); }
}

function die(e: unknown): never {
  if (e instanceof ConfigError || e instanceof SmartsheetError) {
    log.error(e.message);
    if ((e as any).resolution) log.info(`What to do: ${(e as any).resolution}`);
  } else {
    log.error(`Unexpected error: ${(e as Error).message}`);
  }
  process.exit(1);
}

function outDir(cfg: ProjectConfig & { configDir: string }): string {
  const d = resolve(cfg.configDir, cfg.output.dir);
  mkdirSync(d, { recursive: true });
  return d;
}

function refuseIfInvalid(issues: { itemId: string; field: string; message: string }[]): void {
  if (!issues.length) return;
  for (const i of issues) log.error(`${i.itemId} ${i.field}: ${i.message}`);
  log.error('Refusing to continue: the extracted data violates the no-fabrication rules above.');
  process.exit(2);
}

program.command('report').description('Write the Repository Intelligence Report (markdown + items.json).').action(async () => {
  const cfg = cfgOrDie();
  const r = await analyze(cfg);
  const dir = outDir(cfg);
  const md = renderReport(r.inventory, r.items, cfg.project.name, now());
  writeFileSync(join(dir, 'Repository-Intelligence-Report.md'), md);
  writeFileSync(join(dir, 'items.json'), JSON.stringify(r.items, null, 2));
  log.info(`Wrote ${join(dir, 'Repository-Intelligence-Report.md')} and items.json.`);
  refuseIfInvalid(r.issues);
});

program.command('extract').description('Print the extracted items with their evidence.').option('--json', 'machine-readable output').action(async (o) => {
  const cfg = cfgOrDie();
  const r = await analyze(cfg);
  if (o.json) { stdout.write(JSON.stringify(r.items, null, 2) + '\n'); return; }
  for (const it of r.items) {
    stdout.write(`\n${it.itemId}  [${it.type} · ${it.status} · ${it.confidence}${it.humanReviewRequired ? ' · REVIEW' : ''}]\n  ${it.item}\n  Source: ${it.sourceReference}${it.sourceCommit ? ` @ ${it.sourceCommit}` : ''}\n  Evidence: "${it.evidence[0]?.excerpt}"\n${it.owner ? `  Owner (from repo): ${it.owner}\n` : ''}${it.aiSuggestion ? `  AI Suggestion: ${it.aiSuggestion}\n` : ''}`);
  }
  refuseIfInvalid(r.issues);
});

program.command('export-csv').description('Write smartsheet_import.csv + column-definitions.json (no API needed).').action(async () => {
  const cfg = cfgOrDie();
  const r = await analyze(cfg);
  refuseIfInvalid(r.issues);
  const dir = outDir(cfg);
  writeFileSync(join(dir, 'smartsheet_import.csv'), csvFor(r.items, now()));
  writeFileSync(join(dir, 'column-definitions.json'), columnDefinitionsJson());
  log.info(`Wrote ${r.items.length} rows to ${join(dir, 'smartsheet_import.csv')} and column-definitions.json. Import steps: docs/smartsheet-import.md`);
});

program.command('setup-sheet').description('Create a new Smartsheet with the full column schema (needs SMARTSHEET_ACCESS_TOKEN).').option('--name <name>', 'sheet name (defaults to config smartsheet.sheetName)').action(async (o) => {
  const cfg = cfgOrDie();
  try {
    const client = new SmartsheetClient({ token: process.env[cfg.smartsheet.tokenEnv] ?? '', onRetry: retryLog });
    const name = o.name ?? cfg.smartsheet.sheetName;
    log.info(`Creating sheet "${name}" with ${COLUMNS.length} columns…`);
    const sheet = await client.createSheet(sheetCreateBody(name));
    log.info(`Created sheet id ${sheet.id}${sheet.permalink ? ` → ${sheet.permalink}` : ''}.`);
    log.info(`Next: put SMARTSHEET_SHEET_ID=${sheet.id} in your .env, then run \`rsi sync --dry-run\`.`);
    log.info('Optional manual polish (UI only): hide the technical columns and add the "Needs my attention" filter — see docs/smartsheet-import.md.');
  } catch (e) { die(e); }
});

program.command('sync').description('Synchronize repository items into the Smartsheet. Idempotent; never deletes rows.').option('--dry-run', 'show what would change without writing anything').action(async (o) => {
  const cfg = cfgOrDie();
  const r = await analyze(cfg);
  refuseIfInvalid(r.issues);
  const token = process.env[cfg.smartsheet.tokenEnv] ?? '';
  const sheetId = process.env[cfg.smartsheet.sheetIdEnv] ?? '';
  try {
    if (!sheetId) throw new ConfigError('SMARTSHEET_SHEET_ID is not set.', 'Run `rsi setup-sheet` to create one, or set the id of an existing sheet. Without API access, use `rsi export-csv`.');
    const client = new SmartsheetClient({ token, onRetry: retryLog });
    const target = new SmartsheetTarget(client, sheetId, cfg.smartsheet.batchSize);
    const stateDir = resolve(cfg.configDir, cfg.sync.stateDir);
    const state = loadState(stateDir, sheetId);
    log.info(`Reading sheet ${sheetId}…`);
    const rows = await target.readRows();
    const ts = now();
    const plan = planSync(r.items, rows, state, ts);
    for (const line of describePlan(plan, rows.length)) log.info(line);
    const interesting = plan.changes.filter((c) => c.action !== 'unchanged');
    if (interesting.length) {
      log.info('');
      for (const c of interesting) log.info(`  ${c.action.toUpperCase().padEnd(9)} ${c.item.itemId}  ${c.item.item}  (${c.reasons.join('; ')})`);
    }
    if (o.dryRun) { log.info(''); log.info('Dry run: nothing was written to Smartsheet.'); return; }
    if (!interesting.length) { log.info('Sheet is already up to date.'); return; }
    const res = await applyPlan(plan, target, state, ts);
    saveState(stateDir, state);
    log.info(`Sync complete: ${res.created} created, ${res.updated} updated, ${plan.counts.conflict} conflict(s) flagged, ${plan.counts.missing} missing flagged. Requests made: ${client.requestCount}.`);
  } catch (e) { die(e); }
});

program.command('init').description('Setup wizard: creates project-config.yaml.')
  .option('--name <name>').option('--repo <path>').option('--track <list>', 'comma list or "everything"').option('--sheet-name <name>').option('--yes', 'no prompts; use flags/defaults')
  .action(async (o) => {
    const ask = async (q: string, d: string): Promise<string> => {
      if (o.yes || !stdin.isTTY) return d;
      const rl = createInterface({ input: stdin, output: stdout });
      const a = (await rl.question(`${q} [${d}]: `)).trim();
      rl.close();
      return a || d;
    };
    const name = await ask('What is this project called?', o.name ?? 'My Project');
    const repo = await ask('Where is the repository (path)?', o.repo ?? '.');
    const trackAns = await ask(`What do you want to track? (everything, or a comma list of: ${ALL_EXTRACTORS.join(', ')})`, o.track ?? 'everything');
    const sheetName = await ask('Smartsheet name (created by `rsi setup-sheet` if you have no sheet yet)', o.sheetName ?? `${name} — Repo Intelligence`);
    const track = trackAns === 'everything' ? ['everything'] : trackAns.split(',').map((s: string) => s.trim()).filter(Boolean);
    const cfg = defaultConfig({ project: { name, repository: repo }, track, smartsheet: { ...defaultConfig().smartsheet, sheetName } });
    const target = resolve(program.opts().config);
    if (existsSync(target) && !o.yes) { const ow = await ask(`${target} exists. Overwrite? (yes/no)`, 'no'); if (ow.toLowerCase() !== 'yes') { log.info('Left the existing config alone.'); return; } }
    writeFileSync(target, `# Generated by rsi init. Tokens NEVER go here — use .env (see .env.example).\n` + toYaml(cfg));
    log.info(`Wrote ${target}.`);
    log.info('Next: `rsi report` to see what the repository contains, then `rsi sync --dry-run`.');
  });

function retryLog(attempt: number, waitMs: number, reason: string): void {
  log.warn(`Smartsheet ${reason}; waiting ${Math.round(waitMs / 1000)}s before retry ${attempt}.`);
}

program.parseAsync(process.argv).catch(die);
