/**
 * Optional AI interpretation (OFF by default).
 *
 * What: asks Claude for a plain-language summary and an optional risk note per item, using ONLY
 *       already-redacted excerpts (≤ maxExcerptChars). Output lands in `aiSuggestion` and — only
 *       when the item has no description — a labeled "[AI summary]" description. It never changes
 *       Type, Status, Owner, Priority, Confidence or evidence.
 * Use:  `await interpretItems(items, { enabled, model, maxExcerptChars, apiKey })`.
 * Depends on: @anthropic-ai/sdk (optional dependency, imported lazily).
 */
import type { ProjectItem } from '../model/types.js';
import { redact } from '../scanner/secrets.js';
import { log } from '../log/logger.js';

export interface AiOptions { enabled: boolean; model: string; maxExcerptChars: number; apiKey?: string; batch?: number }

interface AiNote { itemId: string; summary?: string; riskNote?: string }

export async function interpretItems(items: ProjectItem[], opts: AiOptions): Promise<ProjectItem[]> {
  if (!opts.enabled) return items;
  if (!opts.apiKey) {
    log.warn('AI interpretation is enabled in config but ANTHROPIC_API_KEY is not set; skipping AI (the sync still works without it).');
    return items;
  }
  let Anthropic: any;
  try { Anthropic = (await import('@anthropic-ai/sdk')).default; }
  catch { log.warn('AI interpretation requested but @anthropic-ai/sdk is not installed; run `npm install @anthropic-ai/sdk`. Skipping AI.'); return items; }

  const client = new Anthropic({ apiKey: opts.apiKey });
  const notes = new Map<string, AiNote>();
  const batchSize = opts.batch ?? 25;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const payload = batch.map((it) => ({ itemId: it.itemId, type: it.type, path: it.repositoryPath, excerpt: redact(it.evidence[0]?.excerpt ?? '').text.slice(0, opts.maxExcerptChars) }));
    log.info(`Sending ${payload.length} redacted excerpts (types: ${[...new Set(batch.map((b) => b.type))].join(', ')}) to Claude for summarization. No file contents or secrets are sent.`);
    try {
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 4000,
        output_config: { effort: 'low' },
        system: 'You summarize software project notes for project managers. For each item return a one-sentence plain-English summary (no jargon) and, only if the excerpt itself describes a risk, a short riskNote. Never invent owners, dates, priorities or status. Respond with a JSON array of {"itemId","summary","riskNote"} and nothing else.',
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      });
      const text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      const arr = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as AiNote[];
      for (const n of arr) if (n?.itemId) notes.set(n.itemId, n);
    } catch (e) {
      log.warn(`AI interpretation failed for one batch (${(e as Error).message}); those items keep their repository-only description.`);
    }
  }
  return items.map((it) => {
    const n = notes.get(it.itemId);
    if (!n) return it;
    const ai = [it.aiSuggestion, n.summary ? `[AI summary] ${n.summary}` : undefined, n.riskNote ? `[AI risk note] ${n.riskNote}` : undefined].filter(Boolean).join(' | ');
    return { ...it, aiSuggestion: ai || it.aiSuggestion, description: it.description || (n.summary ? `[AI summary] ${n.summary}` : it.description) };
  });
}
