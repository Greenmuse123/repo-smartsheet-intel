import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csvFor } from '../src/adapters/csv.js';
import { COLUMN_TITLES } from '../src/adapters/smartsheet/schema.js';
import { normalize } from '../src/model/normalize.js';
import { loadConfig, ConfigError, defaultConfig, activeExtractors } from '../src/config/index.js';
import { trunc, CELL_MAX } from '../src/adapters/smartsheet/mapper.js';

describe('csv fallback', () => {
  it('writes the schema column order and quotes commas/quotes', () => {
    const items = normalize([{ extractor: 'todo-comments', sourceType: 'TODO comment', path: 'src/a.js', line: 1, excerpt: 'TODO: say "hi", then leave' }]);
    const csv = csvFor(items, '2026-08-24T00:00:00Z');
    const [header, row] = csv.split('\r\n');
    expect(header.split(',')).toEqual(COLUMN_TITLES);
    expect(row).toContain('"say ""hi"", then leave"');
    expect(row).toContain(',New,');
  });
  it('truncates below the 4000-char Smartsheet limit with a visible marker', () => {
    const t = trunc('x'.repeat(5000))!;
    expect(t.length).toBeLessThanOrEqual(CELL_MAX);
    expect(t.endsWith('… [truncated]')).toBe(true);
  });
});

describe('config', () => {
  it('rejects unknown track entries with a resolution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsi-cfg-'));
    const p = join(dir, 'project-config.yaml');
    writeFileSync(p, 'project:\n  name: X\n  repository: .\ntrack: [bogus]\n');
    expect(() => loadConfig(p)).toThrow(ConfigError);
    try { loadConfig(p); } catch (e) { expect((e as ConfigError).resolution).toContain('todo-comments'); }
  });
  it('missing config file explains how to create one', () => {
    try { loadConfig('/nope/none.yaml'); } catch (e) { expect((e as ConfigError).resolution).toMatch(/rsi init/); }
  });
  it('defaults keep AI off and expand "everything"', () => {
    const cfg = defaultConfig();
    expect(cfg.ai.enabled).toBe(false);
    expect(activeExtractors(cfg)).toHaveLength(9);
  });
});
