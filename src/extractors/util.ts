/**
 * Shared helpers for extractors.
 */
import type { RawEvidence, ScannedFile } from '../model/types.js';

export const MAX_EXCERPT = 400;

export function clip(s: string, n = MAX_EXCERPT): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function evidence(f: ScannedFile, partial: Omit<RawEvidence, 'path' | 'commit' | 'lastRepoUpdate'>): RawEvidence {
  return { ...partial, path: f.path, commit: f.commit, lastRepoUpdate: f.lastRepoUpdate, excerpt: clip(partial.excerpt) };
}

/** Issue / ticket references literally present in text: #123, GH-12, PROJ-42, JIRA-7 */
export function findRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(\[])(#\d+|[A-Z][A-Z0-9]{1,9}-\d+)\b/g)) out.add(m[1]);
  return [...out];
}

/** Split markdown into sections keyed by heading text. */
export function markdownSections(md: string): Array<{ heading: string; level: number; startLine: number; lines: string[] }> {
  const out: Array<{ heading: string; level: number; startLine: number; lines: string[] }> = [];
  let cur = { heading: '(top)', level: 0, startLine: 1, lines: [] as string[] };
  md.split('\n').forEach((line, i) => {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) { out.push(cur); cur = { heading: m[2].trim(), level: m[1].length, startLine: i + 1, lines: [] }; }
    else cur.lines.push(line);
  });
  out.push(cur);
  return out;
}
