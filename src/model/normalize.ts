/**
 * Normalizer: RawEvidence → ProjectItem.
 *
 * What: applies the (documented) mapping rules per evidence source, assigns confidence and the
 *       Human Review flag, seeds Owner/Priority ONLY from literal evidence, and redacts excerpts.
 * Use:  `normalize(evidence, { ownerRules })`.
 * Rule: no field is ever guessed. If a rule cannot prove a value, the field stays undefined or
 *       'Unknown'. Interpretation goes to `aiSuggestion`, never to a fact field.
 */
import type { Confidence, ItemType, Priority, ProjectItem, RawEvidence, Status } from './types.js';
import { fingerprintOf, itemIdFor } from './ids.js';
import { redact } from '../scanner/secrets.js';
import type { OwnerRule } from '../extractors/codeowners.js';
import { ownerFor } from '../extractors/codeowners.js';

export interface NormalizeOptions { ownerRules?: OwnerRule[] }

const TITLE_MAX = 90;
const title = (s: string) => (s.length > TITLE_MAX ? s.slice(0, TITLE_MAX - 1) + '…' : s);

function priorityFrom(tag?: string): Priority | undefined {
  if (!tag) return undefined;
  const t = tag.toLowerCase();
  if (['p0', 'p1', 'high', 'critical', 'urgent'].includes(t)) return 'High';
  if (['p2', 'medium'].includes(t)) return 'Medium';
  if (['p3', 'low'].includes(t)) return 'Low';
  return undefined;
}

function metaOf(ev: RawEvidence): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of (ev.section ?? '').split(' ')) { const [k, v] = kv.split('='); if (k && v) out[k] = v; }
  return out;
}

function componentOf(path: string): string {
  if (path === '(repository)') return '(repository)';
  if (path.includes('/')) return path.split('/')[0];
  return path.includes('.') ? '(root)' : path; // a bare directory name (e.g. the "tests" suite root) is its own component
}

export function normalize(evidence: RawEvidence[], opts: NormalizeOptions = {}): ProjectItem[] {
  const items: ProjectItem[] = [];
  const seen = new Set<string>();
  for (const raw of evidence) {
    if (raw.extractor === 'codeowners') continue; // used for owner seeding only, not an item
    const ev: RawEvidence = { ...raw, excerpt: redact(raw.excerpt).text };
    const base = build(ev, opts);
    if (!base) continue;
    const itemId = itemIdFor(ev);
    if (seen.has(itemId)) continue; // identical evidence twice (e.g. duplicated TODO text in one file)
    seen.add(itemId);
    const sourceReference = `${ev.path}${ev.line ? `:${ev.line}` : ''} — ${ev.sourceType}${ev.refs?.length ? ` (refs ${ev.refs.join(', ')})` : ''}`;
    const partial: Omit<ProjectItem, 'fingerprint'> = {
      itemId,
      component: componentOf(ev.path),
      repositoryPath: ev.path,
      sourceReference,
      sourceCommit: ev.commit,
      lastRepositoryUpdate: ev.lastRepoUpdate,
      evidence: [ev],
      ...base,
      humanReviewRequired: base.humanReviewRequired ?? false,
    } as Omit<ProjectItem, 'fingerprint'>;
    partial.humanReviewRequired = partial.humanReviewRequired || needsReview(partial);
    items.push({ ...partial, fingerprint: fingerprintOf(partial) });
  }
  return items;
}

type Built = Pick<ProjectItem, 'item' | 'type' | 'description' | 'status' | 'confidence'> &
  Partial<Pick<ProjectItem, 'owner' | 'priority' | 'milestone' | 'dependency' | 'risk' | 'aiSuggestion' | 'humanReviewRequired'>>;

function build(ev: RawEvidence, opts: NormalizeOptions): Built | undefined {
  const meta = metaOf(ev);
  const codeowner = opts.ownerRules ? ownerFor(opts.ownerRules, ev.path) : undefined;
  switch (ev.extractor) {
    case 'todo-comments': {
      const marker = ev.sourceType.split(' ')[0];
      const type: ItemType = marker === 'FIXME' || marker === 'BUG' ? 'Bug' : marker === 'HACK' || marker === 'XXX' ? 'Technical Debt' : 'Task';
      const text = ev.excerpt.replace(/^[A-Z]+(\([^)]*\))?:\s*/, '');
      const dep = /\b(?:depends on|blocked by|after)\s+(#\d+|[A-Z][A-Z0-9]+-\d+)/i.exec(text)?.[1];
      return {
        item: title(text || `${marker} (no text)`),
        type,
        description: `${marker} comment in ${ev.path}: "${text}"`,
        // The comment still exists in the code, so the work it describes has not been done.
        status: 'Not Started' as Status,
        confidence: 'High' as Confidence,
        owner: meta.owner ?? codeowner,
        priority: priorityFrom(meta.priority),
        dependency: dep,
      };
    }
    case 'readme-checklist': {
      if (ev.sourceType === 'README summary') {
        return { item: `README: ${title(ev.excerpt)}`, type: 'Documentation', description: ev.excerpt, status: 'Unknown', confidence: 'High', owner: codeowner };
      }
      const done = ev.sourceType.includes('checked)') && !ev.sourceType.includes('unchecked');
      return {
        item: title(ev.excerpt),
        type: 'Task',
        description: `Checklist item under "${ev.section}" in ${ev.path}: ${done ? '[x]' : '[ ]'} ${ev.excerpt}`,
        status: done ? 'Done' : 'Not Started',
        confidence: 'High',
        milestone: ev.section && ev.section !== '(top)' ? ev.section : undefined,
        owner: codeowner,
      };
    }
    case 'changelog': {
      const unreleased = ev.sourceType.includes('Unreleased');
      const [version, date] = (ev.section ?? '').split(' ');
      return {
        item: unreleased ? 'Unreleased changes' : `Release ${version}`,
        type: 'Release',
        description: `${unreleased ? 'Unreleased section' : `Version ${version}${date ? ` released ${date}` : ''}`} in ${ev.path}: ${ev.excerpt}`,
        status: unreleased ? 'In Progress' : 'Released',
        confidence: 'High',
        milestone: unreleased ? 'Unreleased' : version,
      };
    }
    case 'manifests': {
      const unparseable = ev.sourceType.includes('unparseable');
      const perDep = ev.sourceType === 'Declared dependency';
      return {
        item: perDep ? `Dependency: ${ev.excerpt}` : `Dependencies: ${ev.section ?? ev.path}`,
        type: 'Dependency',
        description: `${ev.sourceType} ${ev.path}: ${ev.excerpt}`,
        status: 'Unknown',
        confidence: unparseable ? 'Medium' : 'High',
        humanReviewRequired: unparseable,
        owner: codeowner,
      };
    }
    case 'ci': {
      const kind = /\((.+)\)/.exec(ev.sourceType)?.[1] ?? '';
      const type: ItemType = kind === 'runs tests' ? 'Test' : kind === 'deploys' ? 'Release' : 'Unknown';
      return {
        item: `CI: ${ev.section ?? ev.path}`,
        type,
        description: `${ev.excerpt} (${ev.path}). Purpose inferred from job/step names: ${kind}.`,
        status: 'Unknown',
        confidence: type === 'Unknown' ? 'Low' : 'Medium',
        aiSuggestion: type === 'Unknown' ? 'Pipeline purpose could not be determined from job names; classify manually.' : undefined,
        owner: codeowner,
      };
    }
    case 'tests':
      return { item: `Tests: ${ev.section}`, type: 'Test', description: `${ev.excerpt}. Pass/fail is not checked by this tool.`, status: 'Unknown', confidence: 'High', owner: codeowner };
    case 'adr': {
      const st = meta.status?.toLowerCase();
      const status: Status = st === 'accepted' ? 'Done' : 'Unknown';
      return {
        item: title(ev.excerpt.split(' — ')[0]),
        type: 'Decision',
        description: `${ev.excerpt}${meta.status ? ` (ADR status: ${meta.status})` : ''}`,
        status,
        confidence: 'High',
        owner: codeowner,
      };
    }
    case 'risk-heuristics':
      return {
        item: `Possible risk: ${title(ev.excerpt)}`,
        type: 'Risk',
        description: 'Heuristic suggestion generated by a rule, not a fact stated in the repository. See AI Suggestion and Source.',
        status: 'Unknown',
        confidence: 'Low',
        aiSuggestion: `[${ev.sourceType}] ${ev.excerpt}`,
        humanReviewRequired: true,
      };
    default:
      return undefined;
  }
}

/** Human Review rules from DESIGN.md §3. */
export function needsReview(item: Omit<ProjectItem, 'fingerprint'>): boolean {
  if (item.confidence === 'Low') return true;
  if (item.type === 'Unknown') return true;
  if (item.type === 'Risk') return true;
  if ((item.type === 'Bug') && !item.owner) return true;
  return false;
}
