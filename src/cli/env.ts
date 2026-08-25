/**
 * Minimal .env loader (no dependency). Reads KEY=VALUE lines from `.env` next to the config
 * and in the cwd; never overrides variables already in the environment; never logs values.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadDotEnv(dirs: string[]): string[] {
  const loaded: string[] = [];
  for (const dir of dirs) {
    const p = join(dir, '.env');
    if (!existsSync(p)) continue;
    for (const raw of readFileSync(p, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined && val !== '') { process.env[key] = val; loaded.push(key); }
    }
  }
  return loaded;
}
