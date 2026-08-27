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
    expect(a).toMatch(/^RSI-TD-[0-9a-f]{8}$/);
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
