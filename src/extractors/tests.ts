/**
 * Extractor: test suites.
 *
 * Yields: one Test evidence per test root directory (e.g. `tests/`, `src/__tests__/`) with the
 *         file count. We never run the target's tests, so pass/fail is Unknown by design.
 * Confidence: High for the count.
 */
import type { Extractor, RawEvidence } from '../model/types.js';
import { classify } from '../scanner/classify.js';
import { evidence } from './util.js';

export const tests: Extractor = {
  id: 'tests',
  run(ctx) {
    const groups = new Map<string, typeof ctx.files>();
    for (const f of ctx.files) {
      if (!classify(f.path).isTest || !classify(f.path).isSource) continue;
      const parts = f.path.split('/');
      const idx = parts.findIndex((p) => /^(tests?|__tests__|spec|specs|e2e)$/i.test(p));
      const root = idx >= 0 ? parts.slice(0, idx + 1).join('/') : parts.slice(0, -1).join('/') || '(root)';
      (groups.get(root) ?? groups.set(root, []).get(root)!).push(f);
    }
    const out: RawEvidence[] = [];
    for (const [root, files] of groups) {
      const newest = files.reduce((a, b) => ((b.lastRepoUpdate ?? '') > (a.lastRepoUpdate ?? '') ? b : a));
      out.push(evidence({ ...newest, path: root }, {
        extractor: 'tests',
        sourceType: 'Test suite',
        section: root,
        excerpt: `${files.length} test file${files.length === 1 ? '' : 's'} under ${root}/ (e.g. ${files.slice(0, 3).map((f) => f.path.split('/').pop()).join(', ')})`,
      }));
    }
    return out;
  },
};
