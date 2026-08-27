import { describe, it, expect } from 'vitest';
import { normalize } from '../src/model/normalize.js';
import { validateItems } from '../src/model/validate.js';
import { itemIdFor } from '../src/model/ids.js';
import { runExtractors } from '../src/extractors/index.js';
import { ALL_EXTRACTORS } from '../src/config/index.js';
import { parseCodeowners } from '../src/extractors/codeowners.js';
import { file, ctx } from './helpers.js';
import type { RawEvidence } from '../src/model/types.js';

const todo = (over: Partial<RawEvidence> = {}): RawEvidence => ({ extractor: 'todo-comments', sourceType: 'TODO comment', path: 'src/a.ts', line: 10, excerpt: 'TODO: add retry', ...over });

describe('redaction covers every field that can reach a sheet, a log or the AI payload', () => {
  it('redacts a secret in TODO metadata, not just in the excerpt (regression: leaked Owner)', () => {
    // Regression for a real defect: redaction was applied to `excerpt` only, so
    // TODO(alice@example.com) kept the address in `section` -> `owner` -> the sheet cell,
    // the CSV and stdout, while the excerpt showed [email] and looked safe.
    const [it] = normalize([todo({ section: 'owner=alice@example.com', excerpt: 'TODO(alice@example.com): rotate the key' })]);
    expect(it.owner).not.toContain('alice@example.com');
    expect(it.owner).toBe('[email]');
    expect(JSON.stringify(it)).not.toContain('alice@example.com');
  });
  it('redacts a credential embedded in a repository path', () => {
    const [it] = normalize([todo({ path: 'src/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123/a.ts' })]);
    expect(JSON.stringify(it)).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
  });
  it('redacts issue refs', () => {
    const [it] = normalize([todo({ refs: ['alice@example.com'] })]);
    expect(JSON.stringify(it)).not.toContain('alice@example.com');
  });
});

describe('no fabrication', () => {
  it('leaves owner, priority, dates and dependency undefined when the repo gives no evidence', () => {
    const [it] = normalize([todo()]);
    expect(it.owner).toBeUndefined();
    expect(it.priority).toBeUndefined();
    expect(it.dueDate).toBeUndefined();
    expect(it.startDate).toBeUndefined();
    expect(it.dependency).toBeUndefined();
    expect(it.milestone).toBeUndefined();
    expect(validateItems([it])).toEqual([]);
  });
  it('seeds owner/priority only from literal TODO tags or CODEOWNERS', () => {
    const [a] = normalize([todo({ section: 'owner=alice priority=P1', excerpt: 'TODO(alice): x' })]);
    expect(a.owner).toBe('alice');
    expect(a.priority).toBe('High');
    const rules = parseCodeowners(file('CODEOWNERS', 'src/ @team-b'));
    const [b] = normalize([todo()], { ownerRules: rules });
    expect(b.owner).toBe('@team-b');
    expect(validateItems([a, b], rules.length)).toEqual([]);
  });
  it('status Unknown when nothing in the repo states it; heuristic risks are Low + review + suggestion only', () => {
    const [t] = normalize([{ extractor: 'tests', sourceType: 'Test suite', path: 'tests', section: 'tests', excerpt: '2 test files under tests/' }]);
    expect(t.status).toBe('Unknown');
    const [r] = normalize([{ extractor: 'risk-heuristics', sourceType: 'Risk heuristic R1', path: '(repository)', excerpt: 'No CI found.' }]);
    expect(r).toMatchObject({ type: 'Risk', confidence: 'Low', humanReviewRequired: true, status: 'Unknown' });
    expect(r.aiSuggestion).toContain('No CI found');
    expect(r.description).toMatch(/not a fact/);
  });
  it('validator rejects invented fields', () => {
    const [it] = normalize([todo()]);
    const issues = validateItems([{ ...it, dueDate: '2026-01-01', priority: 'High' }]);
    expect(issues.map((i) => i.field).sort()).toEqual(['dates', 'priority']);
  });
});

describe('identity', () => {
  it('keeps the same Item ID when a TODO moves lines but changes when the text changes', () => {
    const a = itemIdFor(todo({ line: 10 }));
    const b = itemIdFor(todo({ line: 57 }));
    const c = itemIdFor(todo({ excerpt: 'TODO: add retry with backoff' }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^RSI-TD-[0-9a-f]{12}$/);
  });
  it('fingerprint changes only when repo-controlled fields change', () => {
    const [a] = normalize([todo()]);
    const [b] = normalize([todo({ line: 99 })]);
    const [c] = normalize([todo({ commit: 'abc1234' })]);
    expect(a.fingerprint).toBe(b.fingerprint); // line number is not a fact humans track
    expect(a.fingerprint).not.toBe(c.fingerprint); // Source Commit is a repo-controlled column
  });
});

describe('secret redaction at the excerpt boundary', () => {
  it('scrubs token-shaped strings before they become items', () => {
    const [it] = normalize([todo({ excerpt: 'TODO: rotate key sk_live_ABCDEFGHIJKLMNOP and email bob@example.com' })]);
    expect(it.item).not.toContain('sk_live_');
    expect(it.item).not.toContain('bob@example.com');
    expect(it.evidence[0].excerpt).toContain('[REDACTED KEY]');
  });
});

describe('end to end on a fixture repo', () => {
  it('produces valid, traceable items for every evidence type', () => {
    const files = [
      file('README.md', '# X\n\nA thing.\n\n## Roadmap\n- [ ] ship it\n'),
      file('CHANGELOG.md', '## [1.0.0] - 2026-01-01\n- first\n'),
      file('package.json', '{"name":"x","version":"1.0.0"}'),
      file('.github/workflows/ci.yml', 'name: CI\njobs:\n  t:\n    steps:\n      - run: npm test\n'),
      file('CODEOWNERS', '* @owner'),
      file('docs/adr/0001.md', '# ADR 1\nStatus: Proposed\n'),
      file('src/auth/a.js', '// FIXME: leak'),
      file('tests/a.test.js', ''),
    ];
    const c = ctx(files, { sources: { 'CI/CD config': ['.github/workflows/ci.yml'], Tests: ['tests/a.test.js'] } });
    const ev = runExtractors(c, [...ALL_EXTRACTORS]);
    const rules = parseCodeowners(files[4]);
    const items = normalize(ev, { ownerRules: rules });
    expect(validateItems(items, rules.length)).toEqual([]);
    for (const it of items) { expect(it.evidence.length).toBeGreaterThan(0); expect(it.sourceReference).toContain(it.repositoryPath); }
    const types = new Set(items.map((i) => i.type));
    expect([...types].sort()).toEqual(['Bug', 'Decision', 'Dependency', 'Documentation', 'Release', 'Risk', 'Task', 'Test']);
    expect(items.find((i) => i.type === 'Decision')?.status).toBe('Unknown'); // Proposed is not Done
  });
});

describe('redaction must not destroy identity (round-2 review regression)', () => {
  it('keeps two files distinct when their paths differ only inside a secret (R2-02)', () => {
    // Regression: redacting the whole path collapsed `src/token=abcdefgh/a.ts` and
    // `src/token=ijklmnop/b.ts` to the same string, so the second observation was
    // silently discarded by the `seen` de-duplication.
    const a = todo({ path: 'src/token=abcdefgh/a.ts' });
    const b = todo({ path: 'src/token=ijklmnop/b.ts' });
    const out = normalize([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0].itemId).not.toBe(out[1].itemId);
    // ...while still never publishing the secret
    expect(JSON.stringify(out)).not.toContain('abcdefgh');
    expect(JSON.stringify(out)).not.toContain('ijklmnop');
    // ...and preserving the structure a human needs to find the file. The redacted marker
    // carries the row's own Item ID suffix so two rows can never look identical (R3-03).
    expect(out[0].repositoryPath).toMatch(/^src\/token=\[REDACTED-[0-9a-f]{8}\]\/a\.ts$/);
    expect(out[1].repositoryPath).toMatch(/^src\/token=\[REDACTED-[0-9a-f]{8}\]\/b\.ts$/);
  });

  it('keeps two rows distinguishable when redaction maps both paths to one string (R3-03)', () => {
    // Regression: with the SAME filename, segment redaction produced one published path for
    // two different files. Item ID differed, but repositoryPath, Source and the fingerprint
    // were all identical, so a reviewer could not tell which row was which file.
    const a = todo({ path: 'src/token=abcdefgh/a.ts' });
    const b = todo({ path: 'src/token=ijklmnop/a.ts' });
    const out = normalize([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0].repositoryPath).not.toBe(out[1].repositoryPath);
    expect(out[0].sourceReference).not.toBe(out[1].sourceReference);
    expect(out[0].fingerprint).not.toBe(out[1].fingerprint);
    // The discriminator is the row's own Item ID suffix - already published, so it leaks
    // nothing that the Item ID column does not already show.
    expect(out[0].repositoryPath).toContain(out[0].itemId.slice(-8));
    expect(JSON.stringify(out)).not.toContain('abcdefgh');
    expect(JSON.stringify(out)).not.toContain('ijklmnop');
  });

  it('leaves an unredacted path completely untouched', () => {
    // The discriminator must appear ONLY where redaction actually removed something.
    const out = normalize([todo({ path: 'src/checkout/cart.ts' })]);
    expect(out[0].repositoryPath).toBe('src/checkout/cart.ts');
    expect(out[0].repositoryPath).not.toContain('REDACTED');
  });
});


describe('de-duplication must never discard evidence (round-5 review R5-05)', () => {
  it('keys on the full identity, not on the truncated Item ID', () => {
    // The bug: `seen` de-duplicated on the 8-hex id, so two genuinely different files that
    // collided in 32 bits silently lost one - the one failure mode this tool must not have. A
    // real colliding pair was found by brute force in a few million tries.
    // Two fixes now stand between that and lost evidence: de-duplication keys on the full
    // identity string, and the digest is 48 bits rather than 32. Assert the property directly,
    // since a 48-bit collision is no longer practical to construct.
    const a = todo({ path: 'src/generated/p42207.ts' });
    const b = todo({ path: 'src/generated/p46459.ts' });
    expect(itemIdFor(a)).not.toBe(itemIdFor(b));   // these two DID collide at 8 hex
    const out = normalize([a, b]);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.repositoryPath).sort()).toEqual(['src/generated/p42207.ts', 'src/generated/p46459.ts']);
  });

  it('is long enough that ordinary generated paths do not collide', () => {
    // A 32-bit digest collided inside 50k synthetic paths in practice. 48 bits must not.
    const ids = new Set<string>();
    for (let i = 0; i < 50000; i++) ids.add(itemIdFor(todo({ path: `src/generated/p${i}.ts` })));
    expect(ids.size).toBe(50000);
  });

  it('still collapses genuinely identical evidence seen twice', () => {
    const a = todo({ path: 'src/a.ts' });
    expect(normalize([a, { ...a }])).toHaveLength(1);
  });
});


describe('redaction must not collapse two identities (round-12 review)', () => {
  it('keeps two TODOs whose secrets redact to the same text', () => {
    // Identity was computed from the REDACTED copy, so two different TODOs in one file whose
    // secret values redact identically shared one identity and one was silently dropped as a
    // duplicate. Losing real repository evidence is the one failure this tool must not have.
    const a = todo({ path: 'src/a.ts', line: 1, excerpt: 'TODO: rotate token=aaaaaaaaaaaa now' });
    const b = todo({ path: 'src/a.ts', line: 9, excerpt: 'TODO: rotate token=bbbbbbbbbbbb now' });
    const out = normalize([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0].itemId).not.toBe(out[1].itemId);
    // ...and neither secret is published
    expect(JSON.stringify(out)).not.toContain('aaaaaaaaaaaa');
    expect(JSON.stringify(out)).not.toContain('bbbbbbbbbbbb');
  });

  it('still collapses two TODOs that really are the same text', () => {
    const a = todo({ path: 'src/a.ts', line: 1, excerpt: 'TODO: rotate the token now' });
    const b = todo({ path: 'src/a.ts', line: 9, excerpt: 'TODO: rotate the token now' });
    expect(normalize([a, b])).toHaveLength(1);
  });
});
