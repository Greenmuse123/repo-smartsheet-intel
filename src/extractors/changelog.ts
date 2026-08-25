/**
 * Extractor: CHANGELOG (Keep-a-Changelog style headings).
 *
 * Yields: one Release evidence per `## [x.y.z] - YYYY-MM-DD` / `## x.y.z (date)` heading and
 *         one for `## [Unreleased]`. Excerpt = the first few bullet lines under it.
 * Confidence: High. Dated version = Released; Unreleased = In Progress (literal heading).
 */
import type { Extractor, RawEvidence } from '../model/types.js';
import { classify } from '../scanner/classify.js';
import { evidence, markdownSections } from './util.js';

const VERSION = /^\[?(v?\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?)\]?(?:\s*[-–—]\s*|\s*\(|\s+)?(\d{4}-\d{2}-\d{2})?/i;

export const changelog: Extractor = {
  id: 'changelog',
  run(ctx) {
    const out: RawEvidence[] = [];
    for (const f of ctx.files) {
      if (!classify(f.path).isChangelog) continue;
      for (const s of markdownSections(f.content)) {
        if (s.level === 0) continue;
        const bullets = s.lines.filter((l) => /^\s*[-*+]\s+/.test(l)).slice(0, 4).map((l) => l.replace(/^\s*[-*+]\s+/, '').trim());
        const body = bullets.join(' | ') || s.lines.map((l) => l.trim()).filter(Boolean)[0] || '(no entries)';
        if (/^\[?unreleased\]?/i.test(s.heading)) {
          out.push(evidence(f, { extractor: 'changelog', sourceType: 'Changelog (Unreleased)', line: s.startLine, section: s.heading, excerpt: body }));
          continue;
        }
        const m = VERSION.exec(s.heading);
        if (!m) continue;
        out.push(evidence(f, { extractor: 'changelog', sourceType: m[2] ? 'Changelog release (dated)' : 'Changelog release', line: s.startLine, section: m[2] ? `${m[1]} ${m[2]}` : m[1], excerpt: body }));
      }
    }
    return out;
  },
};
