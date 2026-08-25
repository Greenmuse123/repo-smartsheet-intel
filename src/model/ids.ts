/**
 * Stable item identity + fingerprints.
 *
 * What: `itemIdFor(evidence)` - deterministic ID from path + normalized text, so an item keeps
 *       its ID when its line number moves. `fingerprintOf(item)` - sha1 over repo-controlled
 *       fields, used to detect real changes.
 */
import { createHash } from 'node:crypto';
import type { ProjectItem, RawEvidence } from './types.js';

const CODE: Record<string, string> = {
  'todo-comments': 'TD', 'readme-checklist': 'CK', 'changelog': 'RL', 'manifests': 'DP',
  'ci': 'CI', 'tests': 'TS', 'codeowners': 'CO', 'adr': 'AD', 'risk-heuristics': 'RK',
};

export function normalizeKeyText(s: string): string {
  return s.toLowerCase().replace(/^(todo|fixme|hack|xxx|bug|optimize)(\([^)]*\))?\s*[:\-]?\s*/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function identityKey(ev: RawEvidence): string {
  switch (ev.extractor) {
    case 'changelog': return `${ev.path}|${(ev.section ?? ev.excerpt).split(' ')[0]}`;
    case 'manifests': return `${ev.path}|${ev.sourceType === 'Declared dependency' ? ev.section : ''}`;
    case 'ci': case 'tests': case 'adr': return ev.path;
    default: return `${ev.path}|${normalizeKeyText(ev.excerpt)}`;
  }
}

export function itemIdFor(ev: RawEvidence): string {
  const h = createHash('sha1').update(identityKey(ev)).digest('hex').slice(0, 8);
  return `RSI-${CODE[ev.extractor] ?? 'XX'}-${h}`;
}

/**
 * Fields whose change means "the repository moved". Deliberately excludes `sourceReference`
 * (it carries the line number) so that a file gaining a line at the top does not mark every
 * item beneath it as Updated. The fresh line number is still written whenever a row is updated.
 */
export const REPO_CONTROLLED_FIELDS: Array<keyof ProjectItem> = [
  'item', 'type', 'description', 'status', 'component', 'repositoryPath',
  'sourceCommit', 'lastRepositoryUpdate', 'risk', 'aiSuggestion', 'confidence', 'humanReviewRequired',
];

export function fingerprintOf(item: Omit<ProjectItem, 'fingerprint'>): string {
  const payload = REPO_CONTROLLED_FIELDS.map((k) => `${k}=${String((item as any)[k] ?? '')}`).join('\n');
  return createHash('sha1').update(payload).digest('hex').slice(0, 12);
}
