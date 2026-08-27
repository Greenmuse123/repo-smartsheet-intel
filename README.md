# Repo → Smartsheet Project Intelligence (`rsi`)

Turns an existing software repository into an accurate, traceable, human-reviewable project view in Smartsheet.

```
Repository → Scanner → Extractors → Normalized Project Model → Validation / Confidence → Sync Engine → Smartsheet
```

**Three promises:** it never invents a fact, every row says where it came from, and it never overwrites a decision a person made in the sheet.

---

## Try it in 30 seconds (no Smartsheet account, no API token, no config)

```bash
npm install
npm test              # 49 tests
npm run demo:report   # analyses the bundled sample repo "Orderly"
npm run demo:walkthrough   # the whole sync story against an in-memory sheet
```

`demo:walkthrough` runs the real analyzer and the real sync engine - only the Smartsheet transport
is swapped for an in-memory sheet. Nothing is sent anywhere. It prints the five-step story:

```
23 created  ->  re-run changes nothing  ->  a README checkbox is ticked, one row updates
            ->  a PM sets that row to Blocked and the repo disagrees: the human value wins,
                the repo value moves to Repo Status, the row is flagged Conflict
            ->  a FIXME is deleted: the row is KEPT and flagged "Missing in Repo", never deleted

Final sheet: 23 rows, 5 flagged for human review, 0 rows deleted.
```

It edits two files in the sample repo and restores them, leaving the working tree clean.

- Works with **or without** Smartsheet API access (CSV fallback).
- `sync --dry-run` shows every change before anything is written.
- 49 automated tests cover extraction, no-fabrication, deduplication, updates, protected human fields, invalid credentials, rate-limit retries, and dry-run safety.

---

# How This Works - Super Simple Version

Imagine your software project is a giant toy box.

Lots of important notes are hidden inside the box: sticky notes that say "fix this later", a list of what was finished, a diary of every version, a card that says who looks after which corner of the box.

Our program looks through the box and finds the useful notes.

It does not throw anything away. It does not move anything. It only reads.

It organizes **copies** of those notes and puts them into Smartsheet, one row per note.

Smartsheet becomes our easy-to-read checklist.

When something changes in the toy box, the program can check again and update the checklist. It updates the same row, so you never get two rows for one note.

If the computer isn't sure about something, it asks a human instead of guessing. It ticks a box called **Human Review** and writes its guess in a column called **AI Suggestion**, never in the "facts" columns.

### How do I run it?

1. Open a terminal in the `app` folder and run `npm install` (once).
2. Run `npx rsi init` and answer four questions (project name, where the code is, what to track, sheet name). This writes `project-config.yaml`.
3. Run `npx rsi report`. It writes a readable report of what it found (`output/Repository-Intelligence-Report.md`).
4. If you have a Smartsheet API token, put it in a file called `.env` (copy `.env.example`), run `npx rsi setup-sheet` once to create the sheet, then `npx rsi sync --dry-run` to preview and `npx rsi sync` to write.
5. If you do not have a token, run `npx rsi export-csv` and import the file into Smartsheet by hand (steps in `docs/smartsheet-import.md`).

Run step 4 (or 5) again whenever the code changes.

### What does each Smartsheet column mean?

| Column | Plain meaning |
|---|---|
| Item ID | The program's name tag for the note. Do not edit it. |
| Item | The note in a few words, using the developers' own wording. |
| Type | What kind of thing it is: Task, Bug, Release, Decision, Test, Risk… |
| Status | Where it stands. The program fills it from the code; you can change it. |
| Priority | How important it is. **Yours** to decide; the program only fills it if the code literally says so. |
| Owner | Who looks after it. Filled once from the code's ownership file if there is one; after that it is yours. |
| Component | Which part of the project it belongs to. |
| Description | The note with a little context. |
| Source | The exact file and line, so anyone can go and look. |
| Dependency / Milestone / Due Date | Yours. The program never invents these. |
| Last Repo Update | When that part of the code last changed. |
| Confidence | High = written plainly in the code. Medium = pieced together from clues. Low = a suggestion. |
| Human Review | Ticked when a person should look. Untick it when you have. |
| Sync Status | New, Synced, Updated, Conflict (you and the code disagree), Missing in Repo (the note vanished from the code). |
| AI Suggestion | The program's guesses and notes. Never treated as fact. |
| Management Notes | Your free-text space. The program never touches it. |

The columns to the right of Sync Status are technical (Repo Status, Source Commit, Last Synced, Repo Fingerprint). Hide them if you like; the program needs them to stay honest.

### What happens when something changes?

- A new note appears in the code → a new row.
- A note's wording, file, or status changes in the code → the same row is updated and marked **Updated**.
- You changed Status in the sheet and the code did not → your value stays.
- You changed Status **and** the code changed it too, and they disagree → your value stays, the code's value goes into **Repo Status**, the row is marked **Conflict** and **Human Review** is ticked.
- A note disappears from the code → the row stays, marked **Missing in Repo**, for you to close or merge.

Nothing is ever deleted from the sheet by the program.

### What does "Human Review" mean?

It means: "I found this, but I am not sure enough to call it a fact, or I found two things that disagree. Please look." It is ticked for suggestions (Low confidence), conflicts, vanished items, bugs with no owner, and anything the program could not classify.

### What happens if something goes wrong?

The program stops and tells you in plain words what happened and what to do, for example:

```
ERROR: Smartsheet rejected the access token.
What to do: Check SMARTSHEET_ACCESS_TOKEN: it may be missing, expired, or pasted with extra spaces.
```

If Smartsheet is busy, the program waits and retries by itself. If a run fails halfway, run it again: it will pick up where it left off without making duplicates. If you are ever unsure, run `sync --dry-run` first; it changes nothing.

---

# Technical Documentation

## Architecture

```
Repository (read-only)
    ↓ scanner/        walk tree · ignore rules · sensitive-file gate · git metadata (one `git log`) · classification
    ↓ extractors/     nine pure functions over the file list → RawEvidence[] (verbatim excerpts, ≤400 chars, redacted)
    ↓ model/          normalize → ProjectItem (stable Item ID, Type, Status, Confidence, Human Review, fingerprint)
    ↓ model/validate  no-fabrication guard: owner/priority/dates must cite evidence; enums; every item has evidence
    ↓ ai/             OPTIONAL Claude pass (off by default): summaries + risk notes → AI Suggestion only
    ↓ sync/           planSync (pure 3-way diff) → applyPlan (batched writes) · state cache
    ↓ adapters/       SmartsheetTarget over a thin fetch client (retry/backoff/429) · CsvAdapter
```

Deterministic work is deterministic code. The LLM is optional and touches only the `AI Suggestion` column (and `Description` only when an item had none, labeled `[AI summary]`).

## Project structure

```
app/
  bin/rsi.mjs                launcher (dist if built, else tsx)
  src/
    cli/index.ts             commands: init · report · extract · export-csv · setup-sheet · sync
    cli/env.ts               minimal .env loader (never logs values)
    pipeline.ts              scan → extract → normalize → validate → (ai)
    config/index.ts          project-config.yaml schema, defaults, DEFAULT_IGNORE
    scanner/                 walk · ignore · secrets · git · classify
    extractors/              todo-comments · readme-checklist · changelog · manifests · ci · tests · codeowners · adr · risk-heuristics
    model/                   types · ids (stable IDs, fingerprints) · normalize · validate
    ai/interpreter.ts        optional Anthropic pass
    sync/                    engine (planSync/applyPlan) · state · target interface (+ MemoryTarget)
    adapters/smartsheet/     client · schema (single source of column truth) · mapper · target
    adapters/csv.ts          CSV + column-definitions fallback
    report/report.ts         Repository Intelligence Report
    log/logger.ts            plain-language logging
  tests/                     vitest suites (49 tests)
  examples/sample-repo/      "Orderly" demo repository + sample-repo.project-config.yaml
  docs/                      DATA-MAPPING.md · smartsheet-import.md · DEMO.md
```

## Installation

```
cd app
npm install
npm test          # 49 tests
npm run typecheck
```

Node ≥ 20. Runtime dependencies: `commander`, `yaml`. Optional: `@anthropic-ai/sdk` (only if `ai.enabled: true`).

## Configuration (`project-config.yaml`)

Created by `rsi init`. Every key has a default; only `project.name` and `project.repository` are required.

```yaml
project:
  name: Orderly
  repository: ./sample-repo        # relative to this file
scan:
  ignore: [...]                    # DEFAULT_IGNORE (secrets, vendor dirs, build output, binaries, lockfiles)
  maxFileSizeKb: 512
  perPackageDependencies: false    # true = one row per declared dependency
track: [everything]                # or a list of extractor ids
smartsheet:
  sheetName: Orderly - Repo Intelligence
  sheetIdEnv: SMARTSHEET_SHEET_ID  # env var names, never values
  tokenEnv: SMARTSHEET_ACCESS_TOKEN
  batchSize: 400
sync:
  stateDir: .repo-smartsheet
  humanControlled: [Priority, Owner, Dependency, Milestone, Due Date, Management Notes]
  shared: [Status, Human Review]
ai:
  enabled: false
  model: claude-opus-5
  maxExcerptChars: 400
output:
  dir: output
```

## Authentication

Credentials come only from environment variables (or a local `.env`, which is git-ignored):

```
SMARTSHEET_ACCESS_TOKEN=   # Smartsheet personal access token
SMARTSHEET_SHEET_ID=       # target sheet (or run `rsi setup-sheet`)
ANTHROPIC_API_KEY=         # only if ai.enabled
```

`.env.example` lists names only. The client refuses to start with an empty token and turns 401/403/404/429 into plain-language errors with a resolution.

## Extraction rules

| Extractor | Evidence | → Type | → Status | Confidence |
|---|---|---|---|---|
| todo-comments | `TODO/FIXME/HACK/XXX/BUG/OPTIMIZE` in source (not tests); `TODO(owner)`, `TODO(P1)`; refs `#123`, `ABC-12`; continuation lines folded | TODO/OPTIMIZE→Task, FIXME/BUG→Bug, HACK/XXX→Technical Debt | Not Started (the comment still exists) | High |
| readme-checklist | README first paragraph; `- [ ]`/`- [x]` in any `.md` with its heading | Documentation / Task | Unknown / Not Started or Done | High |
| changelog | `## [x.y.z] - date`, `## [Unreleased]` | Release | Released / In Progress | High |
| manifests | package.json, pyproject, requirements, go.mod, Cargo.toml, composer.json | Dependency | Unknown | High (Medium if unparseable → review) |
| ci | workflow files; job names; literal `npm test`/`pytest`/`deploy` commands | Test / Release / Unknown | Unknown | Medium (Low if Unknown → review) |
| tests | test roots with file counts (never executed) | Test | Unknown | High |
| codeowners | rules; last match wins | - (seeds Owner) | - | High |
| adr | `docs/adr/*.md`, `ADR-*.md`; `Status:` line | Decision | Done if Accepted, else Unknown | High |
| risk-heuristics | R1 no CI · R2 no tests · R3 FIXME/HACK in auth/payment paths · R4 manifest without lockfile | Risk | Unknown | Low → AI Suggestion + Human Review |

## Data model

See `src/model/types.ts`. `RawEvidence` (immutable, verbatim) is kept inside `ProjectItem.evidence`; interpretation lives in `aiSuggestion`. Item ID = `RSI-<extractor code>-<sha1(path | normalized text)[0:8]>`, stable across line moves. Fingerprint = sha1 over repo-controlled fields **excluding the line number**, so a file gaining a line at the top does not mark everything beneath it as Updated. Full column mapping: `docs/DATA-MAPPING.md`.

## Sync strategy

1. Analyze → items. Validation issues abort with exit 2.
2. Read the whole sheet once (`GET /sheets/{id}`).
3. `planSync` (pure): join on `Item ID`; compare `Repo Fingerprint`; classify create / update / unchanged / conflict / missing.
4. `--dry-run` prints the plan and stops.
5. `applyPlan`: one `POST /rows` per ≤400 creates, one `PUT /rows` per ≤400 updates, serialized per sheet; then the local state cache is saved.

State (`.repo-smartsheet/state.json`) is a cache. Identity, fingerprint and last-written status are also stored in the sheet (`Item ID`, `Repo Fingerprint`, `Repo Status`), so a fresh clone with no state still produces zero duplicates (tested).

## Conflict handling

| Field class | Columns | Rule |
|---|---|---|
| Repo-controlled | Item, Type, Component, Description, Source, Source Commit, Last Repo Update, Confidence, Sync Status, AI Suggestion, Repo Status, Last Synced, Repo Fingerprint | overwritten when the fingerprint changes |
| Human-controlled | Priority, Owner, Dependency, Milestone, Due Date, Management Notes | written on row creation only (and only from literal evidence); never afterwards |
| Shared | Status, Human Review | 3-way merge: last-written (Repo Status) vs sheet vs repo. Human-only change → keep. Repo-only change → apply. Both changed and differ → keep human, write repo value to Repo Status, `Sync Status = Conflict`, `Human Review = true`. |

Rows are never deleted. Vanished items → `Missing in Repo` + Human Review, flagged once.

## API integration

`src/adapters/smartsheet/client.ts`: `fetch`-based, base `https://api.smartsheet.com/2.0`, Bearer auth. Retries 429 (errorCode 4003), 5xx and network errors with exponential backoff (2s·2ⁿ, honours `Retry-After`, max 5 tries). Writes to one sheet never overlap. Cell text is truncated at 3900 chars with a visible marker (Smartsheet silently truncates at 4000). `setup-sheet` creates the sheet via `POST /sheets` with one primary column and picklist options from `schema.ts`.

## Error handling

`ConfigError` and `SmartsheetError` carry a `resolution` string; the CLI prints `ERROR: <what>` then `What to do: <resolution>` and exits 1. Validation failures exit 2. Partial batch failures are surfaced as errors (we request `allowPartialSuccess=false`) and a re-run is idempotent.

## Testing

`npm test` - `tests/extractors`, `normalize` (no fabrication, stable IDs, redaction, e2e fixture), `scanner` (ignore, sensitive files, redaction, read-only walk), `sync` (idempotency, state loss, correct-row update, protected fields, conflict, missing, dry-run), `client` (empty/invalid token, 429 backoff, Retry-After, exhaustion, batching, schema), `csv-config`.

## Commands

| Command | Does | Writes to Smartsheet? |
|---|---|---|
| `rsi init [--yes --name --repo --track --sheet-name]` | setup wizard → `project-config.yaml` | no |
| `rsi report` | Repository Intelligence Report + `items.json` | no |
| `rsi extract [--json]` | items with evidence to stdout | no |
| `rsi export-csv` | `smartsheet_import.csv` + `column-definitions.json` | no |
| `rsi setup-sheet [--name]` | create a sheet with the full schema | yes (creates a sheet) |
| `rsi sync --dry-run` | plan only | **no** |
| `rsi sync` | apply plan | yes |

All commands accept `-c <config>` and `-v`.

## Limitations

- Item identity is by wording: rewording a TODO yields one `Missing in Repo` row and one `New` row (both flagged). Documented trade-off.
- No task's tests or pipelines are executed; Test/CI status is always Unknown.
- A catch-all `*` CODEOWNERS rule will seed the same owner on every item (that is what the file literally says).
- Live Smartsheet path was built against verified API docs and a fake `fetch`; it has **not yet been exercised with a real token** in this environment (see `docs/DEMO.md`).
- Event-driven sync (webhooks) is designed but not built; the fingerprint model makes a scheduled run cheap.

## Security considerations

- The repository is never written to. The scanner reads text files under `maxFileSizeKb` only.
- Sensitive paths (`.env*`, keys, certs, credentials, `.aws/`, `.ssh/`, service-account JSON) are withheld before any other rule and listed in the report.
- Every excerpt passes `redact()` (private keys, Stripe/AWS/GitHub/Slack/Google tokens, JWTs, `key=value` secrets, e-mail addresses) before it can reach a row, a log line, or the LLM.
- Excerpts are capped at 400 chars; the LLM receives only `{itemId, type, path, excerpt}` and the log states the types being sent, never the content.
- Tokens only from env; `.env` is git-ignored; `.env.example` has names only.

---

# Three-Level Explanation

## Level 1 - to a 5-year-old

The computer reads the sticky notes inside the toy box, copies them neatly onto a big chart, and asks a grown-up whenever it is not sure. It never throws a note away and never makes one up.

## Level 2 - to a project manager

- **Time saved:** no more hunting through READMEs, changelogs and code comments; one command produces the sheet and keeps it current.
- **Visibility:** every open TODO, bug, release, decision and test suite in one filterable view with Type, Status, Component and Owner (when the code states it).
- **Easier updates:** re-running updates the same rows; nothing duplicates, nothing is deleted.
- **Fewer mistakes:** blank beats guessed. Priority, due dates and owners are yours; the tool only seeds them when the code literally says so.
- **Traceability:** every row has a Source (`file:line`) and a Confidence, so you can verify in seconds.
- **Human review:** suggestions, conflicts and vanished items are flagged for a person, never silently decided.

## Level 3 - to an engineer

- **Architecture:** scanner → pure extractors → normalizer → validator → optional LLM → pure planner → batched adapter. Each unit is independently testable; extractors operate on an in-memory file list.
- **Parsing:** regex/line parsers for comments, markdown sections, Keep-a-Changelog headings, JSON/TOML/requirements manifests, YAML job names, CODEOWNERS (last match wins). No LLM in the parse path.
- **LLM usage:** optional Anthropic call with redacted ≤400-char excerpts, `effort: low`, batch of 25, JSON out; writes only `AI Suggestion` (and empty descriptions, labeled). Disabled → byte-identical output.
- **Data model:** `RawEvidence` kept verbatim inside `ProjectItem`; stable IDs from `sha1(path|normalized text)`; fingerprint over repo-controlled fields minus the line number.
- **Synchronization:** read sheet once → 3-way merge on shared fields (last-written value is persisted in the sheet as `Repo Status`) → create/update/conflict/missing → batched `POST`/`PUT` ≤400 rows, serialized per sheet.
- **API interaction:** thin `fetch` client; 429/5xx/network retried with exponential backoff and `Retry-After`; friendly errors for 401/403/404.
- **State management:** local `state.json` is a cache; `Item ID` + `Repo Fingerprint` + `Repo Status` in the sheet are sufficient to rebuild it (tested).
- **Security:** sensitive-path gate before ignore rules, regex redaction at the excerpt boundary, env-only credentials, no repo writes.
- **Conflict handling:** human-controlled columns written on create only; shared columns merged; conflicts keep the human value and flag.
- **Testing:** 49 vitest cases including fake-`fetch` client tests and an in-memory `SheetTarget` for engine tests.

---

# Run against a real Smartsheet (2026-08-26)

The tool was exercised end to end against a live Smartsheet account. Three things came out of that
which are worth stating plainly, because two of them are defects this project found in itself.

## 1. The REST API is paywalled, and the trial does not open it

Verified by clicking it, not by reading marketing:

| Plan | API access |
|---|---|
| Free | No |
| **30-day Business trial** | **No** - "Generate new access token" opens an *"Upgrade for Smartsheet API"* modal |
| Business and above | Yes (3-member minimum) |

So `setup-sheet` / `sync` remain real, tested code against the documented API, exercised only through
a fake `fetch` and an in-memory sheet target. That limitation is stated here rather than hidden.

## 2. Defect found: the CSV export was unreadable by Smartsheet

`csvFor()` emitted UTF-8 **with no byte-order mark**. Smartsheet sniffs the encoding and rejects a
BOM-less file with *"Failed to upload file"* the moment it contains any multibyte character - which
the bundled sample does, via the truncator's own `…`.

Isolated by single-variable testing: the byte-identical failing file **plus a BOM** imports fine.

Both intuitive suspects were wrong, and both are worth noting:

- **CRLF was not the cause.** RFC 4180 mandates it and the fixed file keeps it.
- **ASCII-folding is the wrong fix.** It would silently distort non-English repository text, which
  violates the project's central rule. A version that folded characters *worked*, and would have
  shipped a data-corrupting bug behind a green test suite.

Fixed in `csvFor()` (one line, plus a regression test asserting BOM position, CRLF retention and
`U+2026` round-tripping). Scope is precise: `csvFor()` renders booleans as `Yes`/`No`
(`src/adapters/csv.ts`), whereas the API path sends a real JSON boolean
(`src/adapters/smartsheet/mapper.ts`) - so `rsi sync` produces genuine checkboxes and the CSV path
cannot. That is a concrete, evidenced reason to prefer the API path.

## 3. Defect found: this project's own documentation contained a false claim

`docs/smartsheet-import.md` asserted that converting `Human Review` to a Checkbox column converts
imported `"Yes"`/`"No"` text to checked/unchecked. **It does not.** Measured on the live sheet:

| Formula | Result |
|---|---|
| `COUNTIF([Human Review]:[Human Review], true)` | 0 |
| `COUNTIF([Human Review]:[Human Review], 1)` | 0 |
| `COUNTIF([Human Review]:[Human Review], "Yes")` | **3** (correct) |

The column type changes only the display; the cells keep the literal strings. The Summary-field
recipe in that same doc used the broken formula and would have reported **0 items needing review**
on a tool whose entire premise is never stating anything it cannot back up. Both corrected.

## What was built on the live sheet

23 rows / 22 typed columns imported, then the surrounding Smartsheet toolset built by hand:

| Feature | Detail |
|---|---|
| Sheet Summary | 4 formulas - Open **10**, Blocked **0**, Needs review **3**, Sync conflicts **0** |
| Conditional formatting | `Confidence = Low` → amber row |
| Saved filter (**shared**) | `Confidence = Low` OR `Status = Blocked` OR `Sync Status ∈ (Conflict, Missing in Repo)` → 3 of 23 |
| Report | grouped by `Type`, 8 columns |
| Dashboard | Metric widget bound to **Sheet Summary data** |
| Automation | rows flagged Conflict/Missing → alert **contacts in the `Owner` cell** |
| Automation | `Owner is Blank` → weekly **Update Request** |

Two of those are the point of the whole design:

- The alert recipient picker offers **only `Owner`**, because `Owner` is a `CONTACT_LIST` column. A
  text column cannot be an alert recipient - column type is a design decision, not formatting.
- `Owner is Blank` matches **exactly 7 of 23** rows, matching the generated report's own line
  *"Owners: 7 of 23 items have no literal owner evidence and are left blank."* The tool refuses to
  guess an owner, so Smartsheet asks a human every week until one is supplied. The refusal to
  fabricate becomes a workflow rather than a gap.
