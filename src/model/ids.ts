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

/**
 * Identity digest length, in hex characters.
 *
 * 8 characters is 32 bits, and a brute-force search found a real collision between two
 * ordinary generated paths in a few million tries - at which point two genuinely different
 * items share one row identity, and no amount of duplicate-row handling can repair that: the
 * sheet cannot tell them apart either. 12 characters is 48 bits, which pushes a collision far
 * past any plausible repository while keeping the ID short enough to read out loud.
 *
 * Changing this changes every Item ID, so a sheet synced by an older build will create fresh
 * rows once and flag the old ones as Missing in Repo. That is a deliberate one-time migration.
 */
const ID_HEX = 12;

/*
 * There is deliberately no way to match a row written under an OLDER Item ID.
 *
 * It existed, and was defeated every time it was hardened: displayed text is clipped, several
 * items share a file, an old 32-bit digest can collide, and redaction makes two different items
 * identical on purpose. Nothing a sheet stores reliably says which item an old row belongs to,
 * and attaching one person's Owner and Management Notes to the wrong work cannot be undone.
 * Upgrading therefore creates fresh rows and flags the old ones "Missing in Repo", intact.
 */
export function itemIdFor(ev: RawEvidence): string {
  const h = createHash('sha1').update(identityKey(ev)).digest('hex').slice(0, ID_HEX);
  return `RSI-${CODE[ev.extractor] ?? 'XX'}-${h}`;
}

/**
 * The Item IDs older versions of this tool would have given the same evidence.
 *
 * Widening the digest changes every identity, and without this a sheet synced by an older
 * build would grow a second row for every item, mark all the originals `Missing in Repo`, and
 * strand the Owner, Priority and Management Notes a person had put on them. Instead the
 * planner adopts the old row and rewrites its `Item ID` in place - the human columns are never
 * touched, so they simply carry over.
 */
/**
 * Extractors whose identity is the PATH alone - so their displayed Item text can change (a
 * renamed CI job, a re-titled ADR) without the identity moving at all.
 */
const PATH_KEYED = new Set(['ci', 'tests', 'adr']);


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
