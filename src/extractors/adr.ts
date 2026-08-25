/**
 * Extractor: Architecture Decision Records.
 *
 * Yields: one Decision evidence per ADR file: title (first heading), literal `Status:` line
 *         if present, and the first sentence of the Decision/Context section.
 * Confidence: High.
 */
import type { Extractor, RawEvidence } from '../model/types.js';
import { classify } from '../scanner/classify.js';
import { evidence, markdownSections } from './util.js';

export const adr: Extractor = {
  id: 'adr',
  run(ctx) {
    const out: RawEvidence[] = [];
    for (const f of ctx.files) {
      if (!classify(f.path).isAdr) continue;
      const sections = markdownSections(f.content);
      const title = sections.find((s) => s.level > 0)?.heading ?? f.path.split('/').pop()!;
      const statusLine = /^\s*\**status\**\s*[:\-]?\s*\**\s*([A-Za-z][A-Za-z ]*)/im.exec(f.content)?.[1]?.trim();
      const statusSection = sections.find((s) => /^status$/i.test(s.heading))?.lines.map((l) => l.trim()).filter(Boolean)[0];
      const status = statusLine ?? statusSection;
      const decision = sections.find((s) => /^(decision|context)/i.test(s.heading))?.lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))[0];
      out.push(evidence(f, {
        extractor: 'adr',
        sourceType: 'Decision record (ADR)',
        line: 1,
        section: status ? `status=${status}` : undefined,
        excerpt: `${title}${decision ? ` — ${decision}` : ''}`,
      }));
    }
    return out;
  },
};
