/**
 * Repository scanner (filesystem side).
 *
 * What: walks the repo read-only and gathers raw {path, content} entries, then hands them to
 *       the pure `buildScan` (inventory.ts) which applies the sensitivity gate, ignore rules,
 *       size cap and binary check and builds the inventory. The browser demo calls `buildScan`
 *       directly with the bundled sample repo, so both run identical logic.
 * Use:  `const { files, inventory } = scanRepository(root, cfg.scan)`.
 * Depends on: ignore.ts (dir pruning), secrets.ts, git.ts, inventory.ts. Never writes; never
 *             reads the contents of a file it will withhold as sensitive.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compileIgnore } from './ignore.js';
import { looksSensitive } from './secrets.js';
import { readGitMetadata } from './git.js';
import { buildScan, type RawEntry } from './inventory.js';
import type { RepoInventory, ScannedFile } from '../model/types.js';
import { log } from '../log/logger.js';

/**
 * `include` is a positive glob filter applied to FILES only, after the ignore list. It is not
 * used to prune directories during the walk: a pattern like `src/**\/*.ts` does not match the
 * directory `src`, so pruning on it would skip the very tree it selects.
 */
export interface ScanOptions { include?: string[]; ignore: string[]; maxFileSizeKb: number }

export function scanRepository(root: string, opts: ScanOptions): { files: ScannedFile[]; inventory: RepoInventory } {
  const isIgnored = compileIgnore(opts.ignore);
  const git = readGitMetadata(root);
  const entries: RawEntry[] = [];

  const walk = (dir: string): void => {
    let dirents;
    try { dirents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of dirents) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (e.isDirectory()) {
        if (!isIgnored(rel)) walk(abs); // prune ignored directories for speed; buildScan re-checks files
        continue;
      }
      if (!e.isFile()) continue;
      const g = git?.byPath.get(rel);
      // Never read a file we will withhold as sensitive, or an ignored/oversize one.
      if (looksSensitive(rel) || isIgnored(rel)) { entries.push({ path: rel, content: '', commit: g?.commit, lastRepoUpdate: g?.date }); continue; }
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.size > opts.maxFileSizeKb * 1024) { entries.push({ path: rel, content: '', sizeBytes: st.size }); continue; }
      let content: string;
      try { content = readFileSync(abs, 'utf8'); } catch { continue; }
      entries.push({ path: rel, content, sizeBytes: st.size, commit: g?.commit, lastRepoUpdate: g?.date });
    }
  };
  walk(root);

  const { files, inventory } = buildScan(entries, { include: opts.include, ignore: opts.ignore, maxFileSizeKb: opts.maxFileSizeKb, root, hasGit: !!git, headCommit: git?.head });
  log.info(`Analyzed ${files.length} repository files (${inventory.filesIgnored} ignored by rules, ${inventory.filesSkippedSensitive.length} skipped as sensitive).`);
  if (!git) log.info('No git history found; Source Commit and Last Repo Update will stay blank.');
  return { files, inventory };
}
