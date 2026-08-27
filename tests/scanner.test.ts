import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileIgnore } from '../src/scanner/ignore.js';
import { looksSensitive, redact } from '../src/scanner/secrets.js';
import { classify } from '../src/scanner/classify.js';
import { scanRepository } from '../src/scanner/walk.js';
import { DEFAULT_IGNORE } from '../src/config/index.js';
import { log } from '../src/log/logger.js';

log.silent();

describe('ignore rules', () => {
  const m = compileIgnore(DEFAULT_IGNORE);
  it('blocks dependency dirs, build output, binaries, lockfiles and env files at any depth', () => {
    for (const p of ['node_modules/x/y.js', 'a/node_modules/b.js', 'dist/app.js', 'img/logo.png', 'package-lock.json', '.env', '.env.local', 'sub/.env', 'certs/server.pem', '.git/HEAD']) expect(m(p), p).toBe(true);
  });
  it('allows normal source and docs', () => {
    for (const p of ['src/a.ts', 'README.md', 'docs/adr/1.md', '.github/workflows/ci.yml', 'package.json']) expect(m(p), p).toBe(false);
  });
});

describe('secrets', () => {
  it('flags credential-shaped paths', () => {
    for (const p of ['.env', 'config/.env.production', 'id_rsa', 'keys/server.key', 'secrets.yaml', 'credentials.json', '.aws/credentials']) expect(looksSensitive(p), p).toBe(true);
    expect(looksSensitive('src/secrets-manager.ts')).toBe(true); // conservative by design
    expect(looksSensitive('src/app.ts')).toBe(false);
  });
  it('redacts token shapes and key=value secrets without logging them', () => {
    const r = redact('token=abcdefghijk AKIAABCDEFGHIJKLMNOP ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 -----BEGIN RSA PRIVATE KEY-----\nxx\n-----END RSA PRIVATE KEY-----');
    expect(r.text).not.toMatch(/AKIA|ghp_|abcdefghijk|BEGIN RSA/);
    expect(r.redactions).toBeGreaterThanOrEqual(4);
  });
});

describe('classify', () => {
  it('labels files deterministically', () => {
    expect(classify('src/a.test.ts')).toMatchObject({ language: 'TypeScript', isTest: true, isSource: true });
    expect(classify('.github/workflows/ci.yml').isCi).toBe(true);
    expect(classify('docs/adr/0001-x.md').isAdr).toBe(true);
    expect(classify('.github/CODEOWNERS').isCodeowners).toBe(true);
    expect(classify('CHANGELOG.md').isChangelog).toBe(true);
    expect(classify('pyproject.toml').isManifest).toBe(true);
  });
});

describe('scanRepository', () => {
  it('reads text files, withholds sensitive ones, and never writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'rsi-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.js'), '// TODO: a');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, 'node_modules', 'x', 'i.js'), '// TODO: vendor');
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
    const { files, inventory } = scanRepository(root, { ignore: DEFAULT_IGNORE, maxFileSizeKb: 64 });
    expect(files.map((f) => f.path)).toEqual(['src/a.js']);
    expect(inventory.filesSkippedSensitive).toEqual(['.env']);
    expect(inventory.hasGit).toBe(false);
    expect(inventory.languages).toEqual({ JavaScript: 1 });
  });
});

describe('CRLF handling', () => {
  it('normalizes CRLF so line/regex parsing is OS-independent', () => {
    const root = mkdtempSync(join(tmpdir(), 'rsi-crlf-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.js'), ['function x() {', '  // TODO(sam): fix this', '  return 1;', '}', ''].join('\r\n'));
    const { files } = scanRepository(root, { ignore: DEFAULT_IGNORE, maxFileSizeKb: 64 });
    expect(files[0].content.includes('\r')).toBe(false);
    expect(files[0].content).toContain('// TODO(sam): fix this');
  });
});

describe('scan.include is a real filter, not decoration (round-3 review m-13)', () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsi-include-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'vendor'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), '// TODO: keep me\n');
    writeFileSync(join(dir, 'vendor', 'b.ts'), '// TODO: drop me\n');
    writeFileSync(join(dir, 'README.md'), '# hi\n');
    return dir;
  };
  const paths = (r: { files: Array<{ path: string }> }) => r.files.map((f) => f.path).sort();

  it('narrows the scan to the matching files', () => {
    const dir = repo();
    expect(paths(scanRepository(dir, { include: ['src/**'], ignore: [], maxFileSizeKb: 512 }))).toEqual(['src/a.ts']);
  });

  it('treats an absent or empty include list as "no positive filter", never as "match nothing"', () => {
    const dir = repo();
    const all = paths(scanRepository(dir, { ignore: [], maxFileSizeKb: 512 }));
    expect(all).toContain('src/a.ts');
    expect(all).toContain('vendor/b.ts');
    expect(paths(scanRepository(dir, { include: [], ignore: [], maxFileSizeKb: 512 }))).toEqual(all);
  });

  it('still lets the ignore list win over an include match', () => {
    const dir = repo();
    expect(paths(scanRepository(dir, { include: ['**/*.ts'], ignore: ['vendor/'], maxFileSizeKb: 512 }))).toEqual(['src/a.ts']);
  });
});
