/**
 * Project configuration (`project-config.yaml`).
 *
 * What: loads + validates the per-project config so the same code runs on any repository.
 * Use:  `loadConfig(path)` → `ProjectConfig`; `defaultConfig()` for the wizard.
 * Depends on: yaml. No secrets live here - tokens come from environment variables only.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import YAML from 'yaml';
import { ALL_EXTRACTORS, DEFAULT_IGNORE } from './defaults.js';

export { ALL_EXTRACTORS, DEFAULT_IGNORE };

export interface ProjectConfig {
  project: { name: string; repository: string };
  scan: {
    /** Positive glob filter applied after the ignore list. `['**\/*']` keeps everything. */
    include: string[];
    ignore: string[];
    maxFileSizeKb: number;
    perPackageDependencies: boolean;
  };
  track: string[]; // extractor ids or 'everything'
  smartsheet: {
    sheetName: string;
    sheetIdEnv: string;
    tokenEnv: string;
    batchSize: number;
  };
  /**
   * Which columns are human-controlled versus shared is NOT configurable: those roles are
   * part of the sheet schema and the merge rules are written against them. Only the state
   * directory is a choice.
   */
  sync: { stateDir: string };
  ai: { enabled: boolean; model: string; maxExcerptChars: number };
  output: { dir: string };
}

export function defaultConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  const base: ProjectConfig = {
    project: { name: 'My Project', repository: '.' },
    scan: { include: ['**/*'], ignore: [...DEFAULT_IGNORE], maxFileSizeKb: 512, perPackageDependencies: false },
    track: ['everything'],
    smartsheet: { sheetName: 'My Project - Repo Intelligence', sheetIdEnv: 'SMARTSHEET_SHEET_ID', tokenEnv: 'SMARTSHEET_ACCESS_TOKEN', batchSize: 400 },
    sync: { stateDir: '.repo-smartsheet' },
    ai: { enabled: false, model: 'claude-opus-5', maxExcerptChars: 400 },
    output: { dir: 'output' },
  };
  return deepMerge(base, overrides) as ProjectConfig;
}

export class ConfigError extends Error {
  constructor(message: string, public readonly resolution: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(configPath: string): ProjectConfig & { configDir: string } {
  const abs = resolve(configPath);
  if (!existsSync(abs)) {
    throw new ConfigError(
      `Config file not found: ${abs}`,
      'Run `rsi init` to create a project-config.yaml, or pass --config <path>.',
    );
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new ConfigError(`Config file is not valid YAML: ${(e as Error).message}`, 'Fix the YAML syntax and try again.');
  }
  const cfg = defaultConfig(parsed as Partial<ProjectConfig>);
  validate(cfg);
  return { ...cfg, configDir: dirname(abs) };
}

function validate(cfg: ProjectConfig): void {
  if (!cfg.project?.name?.trim()) throw new ConfigError('project.name is required', 'Set project.name in project-config.yaml');
  if (!cfg.project?.repository?.trim()) throw new ConfigError('project.repository is required', 'Set project.repository to the repo path');
  for (const t of cfg.track) {
    if (t !== 'everything' && !(ALL_EXTRACTORS as readonly string[]).includes(t)) {
      throw new ConfigError(`Unknown track entry "${t}"`, `Use one of: everything, ${ALL_EXTRACTORS.join(', ')}`);
    }
  }
  if (cfg.smartsheet.batchSize < 1 || cfg.smartsheet.batchSize > 500) {
    throw new ConfigError('smartsheet.batchSize must be 1..500', 'Smartsheet accepts at most a few hundred rows per request; 400 is a safe default');
  }
}

export function activeExtractors(cfg: ProjectConfig): string[] {
  return cfg.track.includes('everything') ? [...ALL_EXTRACTORS] : cfg.track;
}

function deepMerge(a: any, b: any): any {
  if (Array.isArray(a) || Array.isArray(b)) return b ?? a;
  if (typeof a === 'object' && a && typeof b === 'object' && b) {
    const out: any = { ...a };
    for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
    return out;
  }
  return b === undefined ? a : b;
}

export function toYaml(cfg: ProjectConfig): string {
  return YAML.stringify(cfg);
}
