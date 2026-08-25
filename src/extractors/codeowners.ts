/**
 * Extractor: CODEOWNERS.
 *
 * Yields: one evidence per ownership rule (pattern → owners). The normalizer uses these rules
 *         to *seed* Owner on items whose path matches; it never invents an owner otherwise.
 * Confidence: High (literal file).
 */
import type { Extractor, RawEvidence, ScannedFile } from '../model/types.js';
import { classify } from '../scanner/classify.js';
import { evidence } from './util.js';
import { compileIgnore } from '../scanner/ignore.js';

export interface OwnerRule { pattern: string; owners: string[]; matches: (p: string) => boolean }

export function parseCodeowners(f: ScannedFile): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of f.content.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!owners.length) continue;
    rules.push({ pattern, owners, matches: compileIgnore([pattern]) });
  }
  return rules;
}

/** Last matching rule wins, as in GitHub. */
export function ownerFor(rules: OwnerRule[], path: string): string | undefined {
  let hit: OwnerRule | undefined;
  for (const r of rules) if (r.matches(path)) hit = r;
  return hit?.owners.join(', ');
}

export const codeowners: Extractor = {
  id: 'codeowners',
  run(ctx) {
    const out: RawEvidence[] = [];
    for (const f of ctx.files) {
      if (!classify(f.path).isCodeowners) continue;
      parseCodeowners(f).forEach((r, i) => {
        out.push(evidence(f, { extractor: 'codeowners', sourceType: 'CODEOWNERS rule', line: i + 1, section: r.pattern, excerpt: `${r.pattern} → ${r.owners.join(' ')}` }));
      });
    }
    return out;
  },
};
