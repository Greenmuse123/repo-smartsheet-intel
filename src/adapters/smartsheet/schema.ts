/**
 * Smartsheet column schema (single source of truth for column titles, types, options,
 * and who may write each one). DESIGN.md §4 is generated from this list.
 */
import { CONFIDENCES, ITEM_TYPES, STATUSES, SYNC_STATUSES, PRIORITIES } from '../../model/types.js';

export type WrittenBy = 'repo' | 'human' | 'shared';

export interface ColumnDef {
  title: string;
  type: 'TEXT_NUMBER' | 'PICKLIST' | 'CONTACT_LIST' | 'DATE' | 'CHECKBOX';
  primary?: boolean;
  options?: string[];
  writtenBy: WrittenBy;
  technical?: boolean; // hide by default in the main view
  purpose: string;
}

export const COLUMNS: ColumnDef[] = [
  { title: 'Item ID', type: 'TEXT_NUMBER', primary: true, writtenBy: 'repo', purpose: 'Stable key linking the row to its repository evidence. Never edit.' },
  { title: 'Item', type: 'TEXT_NUMBER', writtenBy: 'repo', purpose: 'Short title, in the words found in the repository.' },
  { title: 'Type', type: 'PICKLIST', options: [...ITEM_TYPES], writtenBy: 'repo', purpose: 'Feature, Bug, Task, Technical Debt, Documentation, Test, Dependency, Risk, Decision, Milestone, Release, or Unknown.' },
  { title: 'Status', type: 'PICKLIST', options: [...STATUSES], writtenBy: 'shared', purpose: 'Current state. Repo updates it unless a human changed it; disagreements become Conflict.' },
  { title: 'Priority', type: 'PICKLIST', options: [...PRIORITIES], writtenBy: 'human', purpose: 'Business priority. Seeded only when literally written in the repo (e.g. TODO(P1)); otherwise a human decides.' },
  { title: 'Owner', type: 'CONTACT_LIST', writtenBy: 'human', purpose: 'Who owns it. Seeded from CODEOWNERS or TODO(name) on creation; never overwritten afterwards.' },
  { title: 'Component', type: 'TEXT_NUMBER', writtenBy: 'repo', purpose: 'Top-level folder or package the item belongs to.' },
  { title: 'Description', type: 'TEXT_NUMBER', writtenBy: 'repo', purpose: 'What the repository says, in context. AI summaries are labeled.' },
  { title: 'Source', type: 'TEXT_NUMBER', writtenBy: 'repo', purpose: 'file:line and evidence type, so anyone can verify.' },
  { title: 'Dependency', type: 'TEXT_NUMBER', writtenBy: 'human', purpose: 'What this depends on. Seeded only when literally stated.' },
  { title: 'Milestone', type: 'TEXT_NUMBER', writtenBy: 'human', purpose: 'Release/version or roadmap heading when literally present.' },
  { title: 'Due Date', type: 'DATE', writtenBy: 'human', purpose: 'Never set by the repo. Humans only.' },
  { title: 'Last Repo Update', type: 'DATE', writtenBy: 'repo', purpose: 'Date of the last commit that touched the source file.' },
  { title: 'Confidence', type: 'PICKLIST', options: [...CONFIDENCES], writtenBy: 'repo', purpose: 'High = literal; Medium = inferred from several signals; Low = suggestion.' },
  { title: 'Human Review', type: 'CHECKBOX', writtenBy: 'shared', purpose: 'Checked when a person should look. Clear it when done.' },
  { title: 'Sync Status', type: 'PICKLIST', options: [...SYNC_STATUSES], writtenBy: 'repo', purpose: 'New / Synced / Updated / Conflict / Missing in Repo / Conflict (missing in repo) / Error.' },
  { title: 'AI Suggestion', type: 'TEXT_NUMBER', writtenBy: 'repo', technical: true, purpose: 'Interpretation, never fact. Heuristics and optional LLM notes.' },
  { title: 'Repo Status', type: 'PICKLIST', options: [...STATUSES], writtenBy: 'repo', technical: true, purpose: 'What the repository currently says the status is (basis for conflict detection).' },
  { title: 'Source Commit', type: 'TEXT_NUMBER', writtenBy: 'repo', technical: true, purpose: 'Short commit SHA of the evidence.' },
  { title: 'Management Notes', type: 'TEXT_NUMBER', writtenBy: 'human', purpose: 'Free text for PMs. Never touched by sync.' },
  { title: 'Last Synced', type: 'TEXT_NUMBER', writtenBy: 'repo', technical: true, purpose: 'Timestamp of the last sync that wrote this row.' },
  { title: 'Repo Fingerprint', type: 'TEXT_NUMBER', writtenBy: 'repo', technical: true, purpose: 'Hash of repo-controlled fields; lets the sync rebuild its memory from the sheet alone.' },
];

export const COLUMN_TITLES = COLUMNS.map((c) => c.title);
export const PRIMARY_COLUMN = 'Item ID';

/** Body for POST /sheets. */
export function sheetCreateBody(name: string): { name: string; columns: Array<Record<string, unknown>> } {
  return {
    name,
    columns: COLUMNS.map((c) => ({
      title: c.title,
      type: c.type,
      ...(c.primary ? { primary: true } : {}),
      ...(c.options ? { options: c.options } : {}),
    })),
  };
}
