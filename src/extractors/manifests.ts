/**
 * Extractor: package manifests.
 *
 * Yields: one Dependency evidence per manifest (name, version, dependency counts). With
 *         `scan.perPackageDependencies: true`, also one evidence per declared dependency.
 * Confidence: High.
 */
import type { Extractor, RawEvidence, ScannedFile } from '../model/types.js';
import { classify } from '../scanner/classify.js';
import { evidence } from './util.js';

interface ManifestFacts { name?: string; version?: string; deps: Array<[string, string]>; devDeps: Array<[string, string]>; parseError?: string }

export function parseManifest(f: ScannedFile): ManifestFacts {
  const base = f.path.split('/').pop()!.toLowerCase();
  const facts: ManifestFacts = { deps: [], devDeps: [] };
  try {
    if (base === 'package.json' || base === 'composer.json') {
      const j = JSON.parse(f.content);
      facts.name = j.name; facts.version = j.version;
      facts.deps = Object.entries(j.dependencies ?? j.require ?? {}) as Array<[string, string]>;
      facts.devDeps = Object.entries(j.devDependencies ?? j['require-dev'] ?? {}) as Array<[string, string]>;
    } else if (base === 'requirements.txt') {
      for (const line of f.content.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || t.startsWith('-')) continue;
        const m = /^([A-Za-z0-9_.\-\[\]]+)\s*([<>=!~]+.*)?$/.exec(t);
        if (m) facts.deps.push([m[1], (m[2] ?? '').trim() || '*']);
      }
    } else if (base === 'pyproject.toml') {
      facts.name = /^\s*name\s*=\s*"([^"]+)"/m.exec(f.content)?.[1];
      facts.version = /^\s*version\s*=\s*"([^"]+)"/m.exec(f.content)?.[1];
      const block = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(f.content)?.[1] ?? '';
      for (const m of block.matchAll(/"([^"]+)"/g)) { const [n, ...rest] = m[1].split(/([<>=!~].*)/); facts.deps.push([n.trim(), rest.join('').trim() || '*']); }
    } else if (base === 'go.mod') {
      facts.name = /^module\s+(\S+)/m.exec(f.content)?.[1];
      for (const m of f.content.matchAll(/^\s*([\w./-]+\.[\w./-]+)\s+(v[\w.+-]+)/gm)) facts.deps.push([m[1], m[2]]);
    } else if (base === 'cargo.toml') {
      facts.name = /^\s*name\s*=\s*"([^"]+)"/m.exec(f.content)?.[1];
      facts.version = /^\s*version\s*=\s*"([^"]+)"/m.exec(f.content)?.[1];
      const block = /\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(f.content)?.[1] ?? '';
      for (const m of block.matchAll(/^\s*([\w-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) facts.deps.push([m[1], m[2] ?? m[3] ?? '*']);
    }
  } catch (e) {
    facts.parseError = (e as Error).message;
  }
  return facts;
}

export const manifests: Extractor = {
  id: 'manifests',
  run(ctx) {
    const out: RawEvidence[] = [];
    for (const f of ctx.files) {
      if (!classify(f.path).isManifest) continue;
      const m = parseManifest(f);
      const label = [m.name, m.version].filter(Boolean).join('@') || f.path;
      const excerpt = m.parseError
        ? `Manifest could not be parsed: ${m.parseError}`
        : `${label}: ${m.deps.length} runtime dependencies, ${m.devDeps.length} dev dependencies`;
      out.push(evidence(f, { extractor: 'manifests', sourceType: m.parseError ? 'Package manifest (unparseable)' : 'Package manifest', line: 1, section: label, excerpt }));
      if (ctx.perPackageDependencies && !m.parseError) {
        for (const [name, ver] of [...m.deps, ...m.devDeps]) {
          out.push(evidence(f, { extractor: 'manifests', sourceType: 'Declared dependency', line: 1, section: name, excerpt: `${name} ${ver}` }));
        }
      }
    }
    return out;
  },
};
