/**
 * Extractor: risk heuristics.
 *
 * Yields: Risk *suggestions* only. Every rule cites the evidence it is based on and is
 *         normalized to Confidence=Low, Human Review=Yes, text in AI Suggestion - never as a fact.
 * Rules (all deterministic):
 *   R1 no CI config found            R2 no test files found
 *   R3 FIXME/BUG/HACK in a security-sensitive path (auth|login|payment|billing|crypto|secret)
 *   R4 package manifest without a lockfile alongside it
 */
import type { Extractor, RawEvidence } from '../model/types.js';
import { classify } from '../scanner/classify.js';
import { parseTodoLine } from './todo-comments.js';
import { clip } from './util.js';

export const riskHeuristics: Extractor = {
  id: 'risk-heuristics',
  run(ctx) {
    const out: RawEvidence[] = [];
    const inv = ctx.inventory;
    const rootEvidence = (sourceType: string, excerpt: string, path = '(repository)') => ({ extractor: 'risk-heuristics', sourceType, path, excerpt: clip(excerpt), commit: inv.headCommit });

    if (!inv.sources['CI/CD config']?.length) out.push(rootEvidence('Risk heuristic R1', 'No CI/CD configuration was found in the repository, so builds and tests may not run automatically.'));
    if (!inv.sources['Tests']?.length) out.push(rootEvidence('Risk heuristic R2', 'No test files were found in the repository.'));

    for (const f of ctx.files) {
      const c = classify(f.path);
      if (!c.isSource || c.isTest) continue;
      if (!/(auth|login|session|payment|billing|checkout|crypto|secret|token|password)/i.test(f.path)) continue;
      f.content.split('\n').forEach((line, i) => {
        const p = parseTodoLine(line);
        if (p && ['FIXME', 'BUG', 'HACK', 'XXX'].includes(p.marker)) {
          out.push({ extractor: 'risk-heuristics', sourceType: 'Risk heuristic R3', path: f.path, line: i + 1, commit: f.commit, lastRepoUpdate: f.lastRepoUpdate, excerpt: clip(`${p.marker} in a security-sensitive file: ${p.text}`) });
        }
      });
    }

    const allPaths = new Set([...ctx.files.map((f) => f.path), ...inv.allPaths]);
    for (const f of ctx.files) {
      const base = f.path.split('/').pop()!.toLowerCase();
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
      const locks: Record<string, string[]> = { 'package.json': ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'], 'pyproject.toml': ['poetry.lock', 'uv.lock', 'pdm.lock'], 'cargo.toml': ['Cargo.lock'] };
      if (locks[base] && !locks[base].some((l) => allPaths.has(dir + l))) {
        out.push({ extractor: 'risk-heuristics', sourceType: 'Risk heuristic R4', path: f.path, line: 1, commit: f.commit, lastRepoUpdate: f.lastRepoUpdate, excerpt: `${f.path} has no lockfile next to it (${locks[base].join(' / ')}), so installs may not be reproducible.` });
      }
    }
    return out;
  },
};
