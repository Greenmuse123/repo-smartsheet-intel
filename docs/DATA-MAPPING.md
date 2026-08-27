# Data Mapping - Smartsheet columns

Source of truth: `src/adapters/smartsheet/schema.ts` (the sheet is created from it; the CSV uses the same order). "AI may populate" means the automated sync writes it; "Humans may edit" means an edit survives every future sync.

| # | Column | Smartsheet type | Purpose | Source in repository | AI/sync may populate | Humans may edit |
|---|---|---|---|---|---|---|
| 1 | Item ID | Text (primary) | Join key; stable across line moves | `sha1(path \| normalized text)` | Yes (create) | **No** |
| 2 | Item | Text | Short title | comment text / checklist text / version / ADR title | Yes (create + update) | Overwritten on repo change |
| 3 | Type | Dropdown | Feature, Bug, Task, Technical Debt, Documentation, Test, Dependency, Risk, Decision, Milestone, Release, Unknown | marker word, file class, CI job names | Yes | Overwritten on repo change |
| 4 | Status | Dropdown | Not Started, In Progress, Blocked, Done, Released, Unknown | comment present / checkbox / changelog section / ADR status | Yes, **merged** | **Yes** (kept; conflicts flagged) |
| 5 | Priority | Dropdown | High, Medium, Low | only `TODO(P1)`-style tags | Seed on create only | **Yes** |
| 6 | Owner | Contact | who owns it | `TODO(name)` or CODEOWNERS | Seed on create only | **Yes** |
| 7 | Component | Text | top-level folder / test root / manifest | path | Yes | Overwritten |
| 8 | Description | Text (≤3900) | context; AI text labeled `[AI summary]` | evidence excerpt | Yes | Overwritten |
| 9 | Source | Text | `file:line - evidence type (refs …)` | scanner | Yes | Overwritten |
| 10 | Dependency | Text | what it depends on | literal "depends on #12" in a comment | Seed on create only | **Yes** |
| 11 | Milestone | Text | version or roadmap heading | changelog version / checklist heading | Seed on create only | **Yes** |
| 12 | Due Date | Date | deadline | **none** - never populated | No | **Yes** |
| 13 | Last Repo Update | Date | last commit touching the file | git | Yes | Overwritten |
| 14 | Confidence | Dropdown | High / Medium / Low | rule per extractor | Yes | Overwritten |
| 15 | Human Review | Checkbox | needs a person | rules (Low, Risk, Unknown, Bug w/o owner, conflict, missing) | Yes (sets true) | **Yes** (clear it) - merged |
| 16 | Sync Status | Dropdown | New / Synced / Updated / Conflict / Missing in Repo / Error | sync engine | Yes | Overwritten |
| 17 | AI Suggestion | Text | interpretation, never fact | heuristics + optional LLM | Yes | Overwritten |
| 18 | Repo Status | Dropdown | what the repo says right now (basis for Status conflict detection) | sync engine | Yes | Overwritten |
| 18a | Repo Review | Checkbox | the Human Review value this tool last wrote (lets your tick be told from ours without a local state file) | sync engine | Yes | Overwritten |
| 19 | Source Commit | Text | short SHA | git | Yes | Overwritten |
| 20 | Management Notes | Text | PM free text | - | **Never** | **Yes** |
| 21 | Last Synced | Text | ISO timestamp | sync engine | Yes | Overwritten |
| 22 | Repo Fingerprint | Text | hash of repo-controlled fields | sync engine | Yes | **No** |

Recommended main view: columns 1-16. Hide 17-22 (technical) for non-technical users.

## Internal model → column

| ProjectItem field | Column |
|---|---|
| itemId | Item ID |
| item | Item |
| type | Type |
| status | Status (merged) + Repo Status |
| priority | Priority (seed) |
| owner | Owner (seed) |
| component | Component |
| description | Description |
| sourceReference | Source |
| dependency | Dependency (seed) |
| milestone | Milestone (seed) |
| startDate / dueDate | never set by extractors (Due Date is human-only) |
| lastRepositoryUpdate | Last Repo Update |
| risk | (folded into Description for Risk items) |
| aiSuggestion | AI Suggestion |
| confidence | Confidence |
| humanReviewRequired | Human Review |
| fingerprint | Repo Fingerprint |
| evidence[] | kept in `items.json`; Source column points at it |

## Confidence model

| Level | Meaning | Examples |
|---|---|---|
| High | Directly stated in the repository | `TODO: add password reset`, `- [x] done`, `## [1.2.0] - 2026-07-18`, CODEOWNERS rule |
| Medium | Inferred from several literal signals | CI pipeline "runs tests" because a step says `npm test`; manifest that failed to parse |
| Low | Interpretation requiring confirmation | risk heuristics, CI whose purpose is not stated. Always → AI Suggestion + Human Review |
