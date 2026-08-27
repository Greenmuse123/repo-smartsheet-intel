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

/** Digest lengths this tool has ever published, newest first. Used to adopt older rows. */
const LEGACY_ID_HEX = [8];

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

/** Is this item's identity the path alone, rather than path + text? */
export function isPathKeyed(itemId: string): boolean {
  const code = itemId.split('-')[1] ?? '';
  return [...PATH_KEYED].some((e) => CODE[e] === code);
}

export function legacyItemIdsFor(ev: RawEvidence): string[] {
  const code = CODE[ev.extractor] ?? 'XX';
  const full = createHash('sha1').update(identityKey(ev)).digest('hex');
  const out = new Set(LEGACY_ID_HEX.map((n) => `RSI-${code}-${full.slice(0, n)}`));
  out.delete(`RSI-${code}-${full.slice(0, ID_HEX)}`);
  return [...out];
}

/*
 * A note on what is deliberately NOT here.
 *
 * Identity used to be computed from the REDACTED evidence, so an item whose text or path
 * contains a secret has a different published ID on a sheet synced by an older build. Offering
 * that older ID as an alias would let such rows be adopted - but redaction is exactly the
 * operation that makes two different items identical, so those aliases cannot tell them apart,
 * and neither can anything else on the sheet: two items that redact alike share the alias, the
 * published Source AND the fingerprint.
 *
 * Adopting on that basis would silently move one person's Owner and Management Notes onto the
 * wrong work. Refusing costs a fresh row and a "Missing in Repo" flag on the old one, with
 * every human value still sitting on it, which a person can merge. That trade is not close.
 */

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
