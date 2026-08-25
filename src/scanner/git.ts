/**
 * Git metadata (optional).
 *
 * What: last commit SHA + date per file, and the HEAD SHA, via one `git log` call
 *       (not one per file). Silently degrades when the repo has no git.
 * Use:  `const g = readGitMetadata(root); g?.byPath.get('src/x.ts')`.
 * Depends on: a `git` binary on PATH. Never writes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface FileGitInfo { commit: string; date: string }
export interface GitMetadata { head: string; byPath: Map<string, FileGitInfo> }

export function readGitMetadata(root: string): GitMetadata | undefined {
  if (!existsSync(join(root, '.git'))) return undefined;
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    // One pass over history: each commit header followed by the files it touched.
    const raw = execFileSync(
      'git', ['log', '--name-only', '--format=@@%h %cs', '--no-renames'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const byPath = new Map<string, FileGitInfo>();
    let cur: FileGitInfo | undefined;
    for (const line of raw.split('\n')) {
      if (line.startsWith('@@')) {
        const [commit, date] = line.slice(2).split(' ');
        cur = { commit, date };
      } else if (line.trim() && cur) {
        const p = line.trim().replace(/\\/g, '/');
        if (!byPath.has(p)) byPath.set(p, cur); // first seen = most recent
      }
    }
    return { head, byPath };
  } catch {
    return undefined;
  }
}
