/**
 * Extractor: TODO / FIXME / HACK / XXX / BUG comments in source files.
 *
 * Yields: one evidence per marker line. Captures an optional owner `TODO(alice):` and an
 *         optional priority `TODO(P1)` / `FIXME(high)` exactly as written. Continuation
 *         comment lines directly beneath are folded into the excerpt (max 3).
 * Confidence: High — the text is literal.
 */
import type { Extractor, RawEvidence } from '../model/types.js';
import { classify } from '../scanner/classify.js';
import { evidence, findRefs } from './util.js';

const MARKER = /(?:\/\/|#|\/\*+|\*|<!--|--|;|"""|''')\s*(TODO|FIXME|HACK|XXX|BUG|OPTIMIZE)\b(?:\(([^)]{1,40})\))?\s*[:\-]?\s*(.*)$/i;
const CONTINUATION = /^\s*(?:\/\/|#|\*|--|;)\s*(?!(TODO|FIXME|HACK|XXX|BUG|OPTIMIZE)\b)(.+?)\s*(?:\*\/|-->)?\s*$/;

export interface TodoParse { marker: string; tag?: string; text: string; owner?: string; priority?: string }

export function parseTodoLine(line: string): TodoParse | undefined {
  const m = MARKER.exec(line);
  if (!m) return undefined;
  const tag = m[2]?.trim();
  const res: TodoParse = { marker: m[1].toUpperCase(), tag, text: m[3].replace(/\s*(\*\/|-->)\s*$/, '').trim() };
  if (tag) {
    const pr = /^(p[0-3]|high|medium|low|critical|urgent)$/i.exec(tag);
    if (pr) res.priority = tag; else res.owner = tag;
  }
  return res;
}

export const todoComments: Extractor = {
  id: 'todo-comments',
  run(ctx) {
    const out: RawEvidence[] = [];
    for (const f of ctx.files) {
      const c = classify(f.path);
      if (!c.isSource || c.isTest) continue; // tests get their own extractor; TODOs there are usually fixtures
      const lines = f.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const p = parseTodoLine(lines[i]);
        if (!p) continue;
        let text = p.text;
        for (let j = 1; j <= 3 && i + j < lines.length; j++) {
          const cm = CONTINUATION.exec(lines[i + j]);
          if (!cm || !cm[2] || MARKER.test(lines[i + j])) break;
          text += ' ' + cm[2];
        }
        const meta: string[] = [];
        if (p.owner) meta.push(`owner=${p.owner}`);
        if (p.priority) meta.push(`priority=${p.priority}`);
        out.push(evidence(f, {
          extractor: 'todo-comments',
          sourceType: `${p.marker} comment`,
          line: i + 1,
          section: meta.join(' ') || undefined,
          excerpt: `${p.marker}${p.tag ? `(${p.tag})` : ''}: ${text}`,
          refs: findRefs(text),
        }));
      }
    }
    return out;
  },
};
