/**
 * Repository Intelligence Report (markdown).
 *
 * What: renders what was discovered, where it came from, what is reliable, and what is not.
 * Use:  `renderReport(inventory, items, projectName)` → markdown string.
 */
import type { ProjectItem, RepoInventory } from '../model/types.js';

export function renderReport(inv: RepoInventory, items: ProjectItem[], projectName: string, generatedAt: string): string {
  const byType = count(items, (i) => i.type);
  const byConf = count(items, (i) => i.confidence);
  const bySource = count(items, (i) => i.evidence[0]?.sourceType ?? 'unknown');
  const langs = Object.entries(inv.languages).sort((a, b) => b[1] - a[1]);
  const review = items.filter((i) => i.humanReviewRequired);
  const unknownOwner = items.filter((i) => !i.owner).length;
  const readme = items.find((i) => i.evidence[0]?.sourceType === 'README summary');

  const lines: string[] = [];
  lines.push(`# Repository Intelligence Report — ${projectName}`, '', `Generated ${generatedAt} from \`${inv.root}\`${inv.headCommit ? ` at commit \`${inv.headCommit}\`` : ' (no git history)'}.`, '');
  lines.push('## What this application appears to do', '');
  lines.push(readme ? `From the README (${readme.sourceReference}): "${readme.description}"` : 'No README summary was found. The purpose of the application cannot be stated from repository evidence.');
  lines.push('', `Languages (by source-file count): ${langs.length ? langs.map(([l, n]) => `${l} (${n})`).join(', ') : 'none detected'}.`);
  lines.push(`Frameworks detected from manifests: ${inv.frameworks.length ? inv.frameworks.join(', ') : 'none detected'}.`, '');
  lines.push('## Important components', '', inv.topLevelDirs.length ? inv.topLevelDirs.map((d) => `- \`${d}/\` — ${items.filter((i) => i.component === d).length} tracked item(s)`).join('\n') : '- (flat repository, no top-level directories)', '');
  lines.push('## Sources that contain project-management information', '', '| Source type | Files | Why it is useful |', '|---|---|---|');
  const why: Record<string, string> = {
    'README': 'states purpose; roadmap checklists become tasks',
    'Changelog': 'releases with versions and dates',
    'Package manifest': 'dependencies and project version',
    'CI/CD config': 'which pipelines exist and what they run',
    'CODEOWNERS': 'literal ownership by path',
    'Decision record (ADR)': 'architecture decisions and their status',
    'Tests': 'where tests live and how many there are',
  };
  for (const [k, v] of Object.entries(inv.sources)) lines.push(`| ${k} | ${v.length} | ${why[k] ?? ''} |`);
  const todoCount = items.filter((i) => i.evidence[0]?.extractor === 'todo-comments').length;
  lines.push(`| TODO/FIXME/HACK comments | ${todoCount} | developer-stated open work, in the developers' own words |`, '');
  lines.push('## Scan safety', '', `- ${inv.filesScanned} files read, ${inv.filesIgnored} ignored by rules, ${inv.filesSkippedSensitive.length} skipped as sensitive${inv.filesSkippedSensitive.length ? ` (${inv.filesSkippedSensitive.join(', ')})` : ''}.`, '- Excerpts are capped at 400 characters and pass through secret redaction before leaving this machine.', '');
  lines.push('## Information we can reliably extract', '', `${items.length} trackable items. By confidence: ${fmt(byConf)}.`, '', `By type: ${fmt(byType)}.`, '', `By evidence source: ${fmt(bySource)}.`, '');
  lines.push('**Facts (High confidence):** literal TODO/FIXME text, checklist state, changelog versions and dates, manifest counts, ADR titles, test-file counts, CODEOWNERS ownership.', '');
  lines.push('**Inferences (Medium/Low):** CI pipeline purpose from job names (Medium); risk heuristics (Low, always routed to AI Suggestion + Human Review).', '');
  lines.push('## Information we cannot reliably determine', '');
  lines.push(`- Owners: ${unknownOwner} of ${items.length} items have no literal owner evidence and are left blank.`);
  lines.push('- Due dates, start dates, completion percentages, business priority: never present in repository evidence; left blank for humans.');
  lines.push('- Whether tests or pipelines currently pass: this tool does not execute anything.');
  lines.push(`- ${review.length} item(s) are flagged Human Review = Yes.`, '');
  lines.push('## Items (evidence table)', '', '| Item ID | Type | Status | Conf. | Item | Source |', '|---|---|---|---|---|---|');
  for (const i of items) lines.push(`| ${i.itemId} | ${i.type} | ${i.status} | ${i.confidence} | ${esc(i.item)} | ${esc(i.sourceReference)} |`);
  lines.push('');
  return lines.join('\n');
}

function count<T>(arr: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of arr) out[key(a)] = (out[key(a)] ?? 0) + 1;
  return out;
}
const fmt = (r: Record<string, number>) => Object.entries(r).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
const esc = (s: string) => s.replace(/\|/g, '\\|');
