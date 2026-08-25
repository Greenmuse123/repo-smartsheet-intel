/**
 * Extractor: README / docs checklists and the README summary.
 *
 * Yields: (a) one Documentation evidence per README with its first paragraph,
 *         (b) one Task evidence per `- [ ]` / `- [x]` line in any markdown file, with the
 *             heading it sits under. Checked = Done, unchecked = Not Started (literal).
 * Confidence: High.
 */
import type { Extractor, RawEvidence } from '../model/types.js';
import { classify } from '../scanner/classify.js';
import { evidence, findRefs, markdownSections } from './util.js';

export const readmeChecklist: Extractor = {
  id: 'readme-checklist',
  run(ctx) {
    const out: RawEvidence[] = [];
    for (const f of ctx.files) {
      const c = classify(f.path);
      if (!f.path.toLowerCase().endsWith('.md')) continue;
      const sections = markdownSections(f.content);
      if (c.isReadme) {
        const firstPara = sections.flatMap((s) => s.lines).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!') && !l.startsWith('['))[0];
        if (firstPara) {
          out.push(evidence(f, { extractor: 'readme-checklist', sourceType: 'README summary', line: 1, section: sections[0]?.heading, excerpt: firstPara }));
        }
      }
      if (c.isChangelog || c.isAdr) continue; // owned by their own extractors
      for (const s of sections) {
        s.lines.forEach((line, i) => {
          const m = /^\s*[-*+]\s+\[( |x|X)\]\s+(.+?)\s*$/.exec(line);
          if (!m) return;
          const done = m[1].toLowerCase() === 'x';
          out.push(evidence(f, {
            extractor: 'readme-checklist',
            sourceType: done ? 'Markdown checklist (checked)' : 'Markdown checklist (unchecked)',
            line: s.startLine + i + 1,
            section: s.heading,
            excerpt: m[2],
            refs: findRefs(m[2]),
          }));
        });
      }
    }
    return out;
  },
};
