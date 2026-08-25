import { describe, it, expect } from 'vitest';
import { todoComments, parseTodoLine } from '../src/extractors/todo-comments.js';
import { readmeChecklist } from '../src/extractors/readme-checklist.js';
import { changelog } from '../src/extractors/changelog.js';
import { manifests } from '../src/extractors/manifests.js';
import { ci } from '../src/extractors/ci.js';
import { adr } from '../src/extractors/adr.js';
import { tests as testsExtractor } from '../src/extractors/tests.js';
import { parseCodeowners, ownerFor } from '../src/extractors/codeowners.js';
import { riskHeuristics } from '../src/extractors/risk-heuristics.js';
import { file, ctx } from './helpers.js';

describe('todo-comments', () => {
  it('parses marker, owner, priority and refs exactly as written', () => {
    expect(parseTodoLine('  // TODO(alice): add retry')).toEqual({ marker: 'TODO', tag: 'alice', text: 'add retry', owner: 'alice' });
    expect(parseTodoLine('# FIXME(P1) crashes on empty list')).toMatchObject({ marker: 'FIXME', priority: 'P1', text: 'crashes on empty list' });
    expect(parseTodoLine('const x = 1; // not a todo')).toBeUndefined();
    expect(parseTodoLine('/* HACK: temp */')).toMatchObject({ marker: 'HACK', text: 'temp' });
  });
  it('folds continuation lines and captures issue references', () => {
    const src = 'function a() {\n  // TODO: wire the email\n  // depends on #42 and PROJ-7\n  return 1;\n}\n';
    const ev = todoComments.run(ctx([file('src/a.ts', src)]));
    expect(ev).toHaveLength(1);
    expect(ev[0].line).toBe(2);
    expect(ev[0].excerpt).toBe('TODO: wire the email depends on #42 and PROJ-7');
    expect(ev[0].refs).toEqual(['#42', 'PROJ-7']);
  });
  it('skips test files', () => {
    expect(todoComments.run(ctx([file('tests/a.test.ts', '// TODO: x')]))).toHaveLength(0);
  });
});

describe('readme-checklist', () => {
  it('yields summary + checked/unchecked items with their heading', () => {
    const md = '# App\n\nDoes things.\n\n## Roadmap\n- [x] done thing\n- [ ] open thing\n';
    const ev = readmeChecklist.run(ctx([file('README.md', md)]));
    expect(ev.map((e) => e.sourceType)).toEqual(['README summary', 'Markdown checklist (checked)', 'Markdown checklist (unchecked)']);
    expect(ev[2]).toMatchObject({ section: 'Roadmap', excerpt: 'open thing', line: 7 });
  });
});

describe('changelog', () => {
  it('yields Unreleased and dated releases', () => {
    const md = '# Changelog\n\n## [Unreleased]\n- wip\n\n## [1.2.0] - 2026-07-18\n- a\n- b\n\n## 1.1.0 (2026-06-02)\n- c\n';
    const ev = changelog.run(ctx([file('CHANGELOG.md', md)]));
    expect(ev.map((e) => e.section)).toEqual(['[Unreleased]', '1.2.0 2026-07-18', '1.1.0 2026-06-02']);
    expect(ev[1].excerpt).toBe('a | b');
  });
});

describe('manifests', () => {
  it('summarizes package.json and reports unparseable manifests instead of guessing', () => {
    const ok = manifests.run(ctx([file('package.json', '{"name":"x","version":"1.0.0","dependencies":{"a":"1","b":"2"},"devDependencies":{"c":"3"}}')]));
    expect(ok[0].excerpt).toBe('x@1.0.0: 2 runtime dependencies, 1 dev dependencies');
    const bad = manifests.run(ctx([file('package.json', '{not json')]));
    expect(bad[0].sourceType).toContain('unparseable');
  });
  it('emits per-dependency evidence only when configured', () => {
    const c = ctx([file('requirements.txt', 'flask>=2\npytest\n# comment\n')]);
    expect(manifests.run(c)).toHaveLength(1);
    expect(manifests.run({ ...c, perPackageDependencies: true })).toHaveLength(3);
  });
});

describe('ci', () => {
  it('infers "runs tests" only from literal commands', () => {
    const yml = 'name: CI\non: push\njobs:\n  test:\n    steps:\n      - run: npm test\n';
    const ev = ci.run(ctx([file('.github/workflows/ci.yml', yml)]));
    expect(ev[0].sourceType).toBe('CI pipeline (runs tests)');
    expect(ev[0].excerpt).toBe('Pipeline "CI" with jobs: test');
    const vague = ci.run(ctx([file('.github/workflows/x.yml', 'name: Lint\njobs:\n  lint:\n    steps:\n      - run: echo hi\n')]));
    expect(vague[0].sourceType).toBe('CI pipeline (purpose not stated)');
  });
});

describe('adr + tests + codeowners', () => {
  it('reads ADR title and literal status', () => {
    const ev = adr.run(ctx([file('docs/adr/0001-x.md', '# ADR-1: Use X\n\nStatus: Accepted\n\n## Decision\n\nWe use X.\n')]));
    expect(ev[0]).toMatchObject({ section: 'status=Accepted', excerpt: 'ADR-1: Use X - We use X.' });
  });
  it('groups test files by root', () => {
    const ev = testsExtractor.run(ctx([file('tests/a.test.js', ''), file('tests/b.test.js', ''), file('src/x.js', '')]));
    expect(ev).toHaveLength(1);
    expect(ev[0].excerpt).toContain('2 test files under tests/');
  });
  it('last matching CODEOWNERS rule wins', () => {
    const rules = parseCodeowners(file('CODEOWNERS', '* @a\nsrc/pay @b\n# c\n'));
    expect(ownerFor(rules, 'src/pay/x.js')).toBe('@b');
    expect(ownerFor(rules, 'README.md')).toBe('@a');
  });
});

describe('risk-heuristics', () => {
  it('flags missing CI/tests, FIXME in auth paths, and missing lockfile - but nothing else', () => {
    const c = ctx([file('src/auth/login.js', '// FIXME: token check'), file('package.json', '{}')]);
    const kinds = riskHeuristics.run(c).map((e) => e.sourceType).sort();
    expect(kinds).toEqual(['Risk heuristic R1', 'Risk heuristic R2', 'Risk heuristic R3', 'Risk heuristic R4']);
    const quiet = ctx([file('src/a.js', '// TODO: x'), file('package.json', '{}')], { sources: { 'CI/CD config': ['ci.yml'], Tests: ['t.js'] }, allPaths: ['package.json', 'package-lock.json'] });
    expect(riskHeuristics.run(quiet)).toHaveLength(0);
  });
});
