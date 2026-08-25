/**
 * Extractor registry. Order matters only for readability of output.
 */
import type { Extractor, ExtractorContext, RawEvidence } from '../model/types.js';
import { todoComments } from './todo-comments.js';
import { readmeChecklist } from './readme-checklist.js';
import { changelog } from './changelog.js';
import { manifests } from './manifests.js';
import { ci } from './ci.js';
import { tests } from './tests.js';
import { codeowners } from './codeowners.js';
import { adr } from './adr.js';
import { riskHeuristics } from './risk-heuristics.js';
import { log } from '../log/logger.js';

export const EXTRACTORS: Extractor[] = [todoComments, readmeChecklist, changelog, manifests, ci, tests, codeowners, adr, riskHeuristics];

export function runExtractors(ctx: ExtractorContext, ids: string[]): RawEvidence[] {
  const all: RawEvidence[] = [];
  for (const ex of EXTRACTORS) {
    if (!ids.includes(ex.id)) continue;
    const found = ex.run(ctx);
    log.debug(`Extractor "${ex.id}" found ${found.length} piece(s) of evidence.`);
    all.push(...found);
  }
  return all;
}
