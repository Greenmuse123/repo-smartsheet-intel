#!/usr/bin/env node
// Thin launcher: runs the compiled CLI if built, otherwise the TypeScript source via tsx.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist', 'cli', 'index.js');
if (existsSync(dist)) { await import(dist); }
else { const { spawnSync } = await import('node:child_process'); const r = spawnSync('npx', ['tsx', join(here, '..', 'src', 'cli', 'index.ts'), ...process.argv.slice(2)], { stdio: 'inherit', shell: true }); process.exit(r.status ?? 1); }
