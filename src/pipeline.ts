/**
 * The analysis pipeline: scan → extract → normalize → validate → (optional AI).
 *
 * Use: `const result = await analyze(cfg)`; every CLI command starts here.
 */
import { resolve } from 'node:path';
import { scanRepository } from './scanner/walk.js';
import { runExtractors } from './extractors/index.js';
import { normalize } from './model/normalize.js';
import { validateItems, type ValidationIssue } from './model/validate.js';
import { parseCodeowners, type OwnerRule } from './extractors/codeowners.js';
import { classify } from './scanner/classify.js';
import { interpretItems } from './ai/interpreter.js';
import { activeExtractors, type ProjectConfig } from './config/index.js';
import type { ProjectItem, RepoInventory } from './model/types.js';
import { log } from './log/logger.js';

export interface AnalysisResult { inventory: RepoInventory; items: ProjectItem[]; issues: ValidationIssue[]; ownerRules: OwnerRule[] }

export async function analyze(cfg: ProjectConfig & { configDir: string }, env: NodeJS.ProcessEnv = process.env): Promise<AnalysisResult> {
  const root = resolve(cfg.configDir, cfg.project.repository);
  const { files, inventory } = scanRepository(root, { include: cfg.scan.include, ignore: cfg.scan.ignore, maxFileSizeKb: cfg.scan.maxFileSizeKb });
  const evidence = runExtractors({ files, inventory, perPackageDependencies: cfg.scan.perPackageDependencies }, activeExtractors(cfg));
  const ownerRules = files.filter((f) => classify(f.path).isCodeowners).flatMap(parseCodeowners);
  let items = normalize(evidence, { ownerRules });
  items = await interpretItems(items, { ...cfg.ai, apiKey: env.ANTHROPIC_API_KEY });
  const issues = validateItems(items, ownerRules.length);
  log.info(`Found ${items.length} trackable project item${items.length === 1 ? '' : 's'} from ${evidence.length} piece${evidence.length === 1 ? '' : 's'} of evidence.`);
  const review = items.filter((i) => i.humanReviewRequired).length;
  if (review) log.info(`${review} item${review === 1 ? '' : 's'} require${review === 1 ? 's' : ''} human review.`);
  if (issues.length) log.warn(`${issues.length} validation issue(s) found; sync will refuse to run until they are fixed.`);
  return { inventory, items, issues, ownerRules };
}
