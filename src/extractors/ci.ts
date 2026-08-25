/**
 * Extractor: CI/CD configuration.
 *
 * Yields: one evidence per pipeline file with its declared name and job names.
 *         The sourceType hints the item type: "runs tests" / "deploys" / neither - only
 *         when job or step names literally say so.
 * Confidence: Medium for the type hint (inferred from names), High for existence.
 */
import type { Extractor, RawEvidence } from '../model/types.js';
import { classify } from '../scanner/classify.js';
import { evidence } from './util.js';

export const ci: Extractor = {
  id: 'ci',
  run(ctx) {
    const out: RawEvidence[] = [];
    for (const f of ctx.files) {
      if (!classify(f.path).isCi) continue;
      const name = /^name:\s*["']?(.+?)["']?\s*$/m.exec(f.content)?.[1] ?? f.path.split('/').pop()!;
      const jobs: string[] = [];
      const jobsBlock = /^jobs:\s*\n([\s\S]*)/m.exec(f.content)?.[1];
      if (jobsBlock) for (const m of jobsBlock.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)) jobs.push(m[1]);
      const text = f.content.toLowerCase();
      const runsTests = /\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\bpytest\b|\bgo test\b|\bcargo test\b|\bvitest\b|\bjest\b/.test(text);
      const deploys = /\bdeploy|\brelease\b|vercel|netlify|aws s3 sync|kubectl|helm upgrade|docker push/.test(text);
      const kind = runsTests && !deploys ? 'runs tests' : deploys && !runsTests ? 'deploys' : runsTests && deploys ? 'tests and deploys' : 'purpose not stated';
      out.push(evidence(f, {
        extractor: 'ci',
        sourceType: `CI pipeline (${kind})`,
        line: 1,
        section: name,
        excerpt: `Pipeline "${name}"${jobs.length ? ` with jobs: ${jobs.join(', ')}` : ''}`,
      }));
    }
    return out;
  },
};
