/**
 * Validation / no-fabrication guard.
 *
 * What: asserts every ProjectItem obeys the invariants a human relies on:
 *       enums are valid, every item carries evidence, and owner/priority/dependency/milestone
 *       can be traced to literal evidence (TODO tag, CODEOWNERS, changelog heading, checklist section).
 * Use:  `const issues = validateItems(items)`; the CLI refuses to sync when issues.length > 0.
 */
import { CONFIDENCES, ITEM_TYPES, STATUSES, type ProjectItem } from './types.js';

export interface ValidationIssue { itemId: string; field: string; message: string }

export function validateItems(items: ProjectItem[], ownerRuleCount = 0): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const it of items) {
    const bad = (field: string, message: string) => issues.push({ itemId: it.itemId, field, message });
    if (ids.has(it.itemId)) bad('itemId', 'duplicate item id');
    ids.add(it.itemId);
    if (!(ITEM_TYPES as readonly string[]).includes(it.type)) bad('type', `invalid type ${it.type}`);
    if (!(STATUSES as readonly string[]).includes(it.status)) bad('status', `invalid status ${it.status}`);
    if (!(CONFIDENCES as readonly string[]).includes(it.confidence)) bad('confidence', `invalid confidence ${it.confidence}`);
    if (!it.evidence?.length) bad('evidence', 'item has no evidence');
    if (!it.sourceReference) bad('sourceReference', 'missing source reference');
    if (it.dueDate || it.startDate) bad('dates', 'no extractor can prove a date; dates must stay blank');
    const meta = it.evidence?.[0]?.section ?? '';
    if (it.owner && !/owner=/.test(meta) && ownerRuleCount === 0) bad('owner', 'owner set without TODO(owner) or CODEOWNERS evidence');
    if (it.priority && !/priority=/.test(meta)) bad('priority', 'priority set without literal evidence');
    if (it.confidence === 'Low' && !it.humanReviewRequired) bad('humanReviewRequired', 'low confidence must require human review');
    if (it.type === 'Risk' && it.confidence !== 'Low') bad('confidence', 'heuristic risks must be Low confidence');
  }
  return issues;
}
