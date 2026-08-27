# Repo → Smartsheet Project Intelligence (`rsi`)

Turns an existing software repository into an accurate, traceable, human-reviewable project view in Smartsheet.

```
Repository → Scanner → Extractors → Normalized Project Model → Validation / Confidence → Sync Engine → Smartsheet
```

**Four promises, stated precisely:**
1. **It does not copy a value into a fact column unless the repository literally states it.** Owner, priority, dates and milestones stay blank otherwise. The one deliberate inference is `Status`: a TODO that is still present is recorded as `Not Started`, because the comment describing the work still exists. That is a documented rule, not a fact read out of the file, and it is the only place the tool asserts something the repository did not say.
2. **Every row carries its provenance** - the file, and the line where evidence has one. Repository-wide heuristics (for example "package.json has no lockfile") cite `(repository)` because they are about the repo as a whole, not a line.
3. **A disagreement is never resolved silently.** When both sides moved and landed somewhere
   different, the row becomes a **Conflict** with your value kept. When only the sheet's own
   technical baseline was stale - which happens on imported or hand-repaired sheets, and means
   the repository has not actually moved - the baseline is repaired instead, and if you are
   sitting on a different Status the row is flagged for you with a reason. Neither case picks a
   winner on your behalf.
4. **It never silently overwrites a decision a person made in the sheet.** Human-controlled columns are written on create only. The one case where it does write over you is an emptied `Status` cell: a blank Status breaks every report and rollup, so the repository value is restored - and the row is flagged for review with a reason saying exactly that, never quietly.

- Works with **or without** Smartsheet API access (CSV fallback).
- `sync --dry-run` shows every change before anything is written.
- 133 automated tests cover extraction, no-fabrication, redaction of every outbound field, deduplication, updates, protected human fields, the missing/reappearing and conflict lifecycles, the required-column guard on the real Smartsheet target, invalid credentials, authorization vs. token errors, plan-restriction errors, rate-limit retries, and dry-run safety. They run against a fake `fetch`; no test performs a live API call.

---

# How This Works - Super Simple Version

Imagine your software project is a giant toy box.

Lots of important notes are hidden inside the box: sticky notes that say "fix this later", a list of what was finished, a diary of every version, a card that says who looks after which corner of the box.

Our program looks through the box and finds the useful notes.

It does not throw anything away. It does not move anything. It only reads.

It organizes **copies** of those notes and puts them into Smartsheet, one row per note.

Smartsheet becomes our easy-to-read checklist.

When something changes in the toy box, the program can check again and update the checklist. It updates the same row, matched on a stable Item ID, so a repeated run does not add a second row for the same note. (Run one sync at a time: two syncs racing against the same sheet can both decide a row is missing and each create it. There is no cross-process lock.)

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
| Source | The file, and the line where the evidence has one, so anyone can go and look. Repository-wide heuristics cite `(repository)`. |
| Dependency / Milestone / Due Date | Yours. The program never invents these. |
| Last Repo Update | When that part of the code last changed. |
| Confidence | High = written plainly in the code. Medium = pieced together from clues. Low = a suggestion. |
| Human Review | Ticked when a person should look. Untick it when you have. |
| Sync Status | New, Synced, Updated, Conflict (you and the code disagree), Missing in Repo (the note vanished from the code)., Conflict (missing in repo) (both at once - it is gone AND you still disagree; resolve the disagreement and it drops back to Missing in Repo). |
| AI Suggestion | The program's guesses and notes. Never treated as fact. |
| Management Notes | Your free-text space. The program never touches it. |

The columns to the right of Sync Status are technical (Repo Status, Repo Path, Repo Review, Source Commit, Last Synced, Repo Fingerprint). Hide them if you like; the program needs them to stay honest.

### What happens when something changes?

- A new note appears in the code → a new row.
- A note's wording, file, or status changes in the code → the same row is updated and marked **Updated**.
- You changed Status in the sheet and the code did not → your value stays.
There are two kinds of disagreement, and they are handled differently:

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

If Smartsheet is busy, the program waits and retries by itself. If a run fails halfway, run it again: rows that were already written are matched by their `Item ID` and updated rather than added, so re-running is safe. (Batches commit independently, so an earlier batch can succeed while a later one fails; that is exactly the case re-running is designed to recover from.) If you are ever unsure, run `sync --dry-run` first; it changes nothing.

---

# Technical Documentation

## Architecture

```
Repository (read-only)
    ↓ scanner/        walk tree · ignore rules · sensitive-file gate · git metadata (one `git log`) · classification
    ↓ extractors/     nine pure functions over the file list → RawEvidence[] (quoted excerpts, whitespace collapsed, ≤400 chars, redacted)
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
  tests/                     vitest suites (133 tests)
  examples/sample-repo/      "Orderly" demo repository + sample-repo.project-config.yaml
  docs/                      DATA-MAPPING.md · smartsheet-import.md · DEMO.md
```

## Installation

```
cd app
npm install
npm test          # 133 tests
npm run typecheck
```

Node ≥ 20. Runtime dependencies: `commander`, `yaml`. Optional: `@anthropic-ai/sdk` (only if `ai.enabled: true`).

## Configuration (`project-config.yaml`)

Created by `rsi init`. Every key has a default, including `project.name` (`My Project`) and `project.repository` (`.`), so a config that omits them still loads - set both to something meaningful rather than relying on the defaults.

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
# Which columns are human-controlled and which are shared is NOT configurable: those roles are
# part of the sheet schema and the merge rules are written against them.
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

See `src/model/types.ts`. `RawEvidence` is kept inside `ProjectItem.evidence`. It is the closest quotation of the source the tool can safely publish, not a byte-for-byte copy: whitespace is collapsed, it is clipped to 400 characters, and every free-text field (`excerpt`, `section`, `path`, `sourceType`, `refs`) is passed through the redactor before it can reach a sheet cell, the CSV, a log line or the optional AI payload; interpretation lives in `aiSuggestion`. Item ID = `RSI-<extractor code>-<sha1(path | normalized text)[0:12]>`, stable across line moves. Fingerprint = sha1 over repo-controlled fields **excluding the line number**, so a file gaining a line at the top does not mark everything beneath it as Updated. Full column mapping: `docs/DATA-MAPPING.md`.

## Sync strategy

1. Analyze → items. Validation issues abort with exit 2.
2. Read the whole sheet once (`GET /sheets/{id}`).
3. `planSync` (pure): join on `Item ID`; compare `Repo Fingerprint`; classify create / update / unchanged / conflict / missing.
4. `--dry-run` prints the plan and stops.
5. `applyPlan`: one `POST /rows` per ≤400 creates, one `PUT /rows` per ≤400 updates, serialized per sheet; then the local state cache is saved.

State (`.repo-smartsheet/state.json`) is a cache. Identity, fingerprint and both last-written shared values are also stored in the sheet (`Item ID`, `Repo Fingerprint`, `Repo Status`, `Repo Review`), so a fresh clone with no state still produces zero duplicates (tested).

## Conflict handling

| Field class | Columns | Rule |
|---|---|---|
| Repo-controlled | Item, Type, Component, Description, Source, Source Commit, Last Repo Update, Confidence, Sync Status, AI Suggestion, Repo Status, Last Synced, Repo Fingerprint | overwritten when the fingerprint changes |
| Human-controlled | Priority, Owner, Dependency, Milestone, Due Date, Management Notes | written on row creation only (and only from literal evidence); never afterwards |
| Shared | Status, Human Review | 3-way merge against the value we last wrote, which the sheet keeps in `Repo Status` and `Repo Review` so no local file is needed. Human-only change → keep. Repo-only change → apply. Both changed and differ → keep human, write repo value to Repo Status, `Sync Status = Conflict`, `Human Review = true`. |

Rows are never deleted. Vanished items → `Missing in Repo` + Human Review, flagged once.

## API integration

`src/adapters/smartsheet/client.ts`: `fetch`-based, base `https://api.smartsheet.com/2.0`, Bearer auth. Retries 429 (errorCode 4003), 5xx and network errors with exponential backoff (2s·2ⁿ, honours `Retry-After`, up to 5 retries, so at most 6 attempts in total). Writes issued by a single client instance never overlap: they are serialized on one promise chain. That is per-process, not per-sheet - two syncs run at the same time against the same sheet can still interleave, which is why runs are meant to be serialized externally. Cell text is truncated at 3900 chars with a visible marker (Smartsheet silently truncates at 4000). `setup-sheet` creates the sheet via `POST /sheets` with one primary column and picklist options from `schema.ts`.

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

The computer reads the sticky notes inside the toy box, copies them neatly onto a big chart, and asks a grown-up whenever it is not sure. It never throws a note away, and it never invents a name or a date. (It does say an unfinished note is "Not Started" - that is the one thing it decides for itself, and it is a rule, not a guess.)

## Level 2 - to a project manager

- **Time saved:** no more hunting through READMEs, changelogs and code comments; one command produces the sheet and keeps it current.
- **Visibility:** every open TODO, bug, release, decision and test suite in one filterable view with Type, Status, Component and Owner (when the code states it).
- **Easier updates:** re-running matches rows by `Item ID` and updates them in place; nothing is ever deleted. Duplicate protection is per sync run: two syncs running against the same sheet at the same time can both decide to create the same row, so run one at a time (see the concurrency note above).
- **Fewer mistakes:** blank beats guessed. Priority, due dates and owners are yours; the tool only seeds them when the code literally says so.
- **Traceability:** every row has a Source and a Confidence, so you can verify in seconds. The Source is `file:line` wherever the evidence has a line; repository-wide checks (a missing CI config, say) cite `(repository)` instead.
- **Human review:** suggestions, conflicts and vanished items are flagged for a person, never silently decided.

## Level 3 - to an engineer

- **Architecture:** scanner → pure extractors → normalizer → validator → optional LLM → pure planner → batched adapter. Each unit is independently testable; extractors operate on an in-memory file list.
- **Parsing:** regex/line parsers for comments, markdown sections, Keep-a-Changelog headings, JSON/TOML/requirements manifests, YAML job names, CODEOWNERS (last match wins). No LLM in the parse path.
- **LLM usage:** optional Anthropic call with redacted ≤400-char excerpts, `effort: low`, batch of 25, JSON out; writes only `AI Suggestion` (and empty descriptions, labeled). Disabled → byte-identical output.
- **Data model:** `RawEvidence` kept inside `ProjectItem` as the closest safely-publishable quotation (whitespace collapsed, clipped to 400 chars, every free-text field redacted); stable IDs from `sha1(path|normalized text)`; fingerprint over repo-controlled fields minus the line number.
- **Synchronization:** read sheet once → 3-way merge on shared fields (last-written value is persisted in the sheet as `Repo Status`) → create/update/conflict/missing → batched `POST`/`PUT` ≤400 rows, serialized per sheet.
- **API interaction:** thin `fetch` client; 429/5xx/network retried with exponential backoff and `Retry-After`; friendly errors for 401/403/404.
- **Identity is a deterministic digest, and that is a trade-off:** `Item ID` is
  `sha1(path | normalized text)[0:12]`, unsalted. That is what lets a fresh clone with no state
  file rebuild identity from the sheet alone - but it also means an observer who can guess a
  candidate path - or a candidate line of text, which is just as guessable - can confirm the guess offline, and it is 48 bits, widened from 32 after a brute-force
  search found a real collision between two ordinary generated paths in a few million tries. Salting would break state-free reconstruction, so the
  digest stays; collisions are detected rather than silently merged (the planner warns when two
  rows claim one `Item ID`), and paths are redacted before publication.
- **Once it raises something with you, that row is yours:** if a sync finds an oddity it cannot
  interpret - a technical baseline that disagrees with the repository while somebody is also
  sitting on a different Status - it repairs the baseline, ticks Human Review and says why. From
  then on it never writes that checkbox again, whether you leave it or clear it. A warning you
  can dismiss for good is worth more than one that keeps coming back, and the cost is that this
  row will not be flagged automatically again.
- **If you lose `state.json`, one ownership case cannot be reconstructed:** the sheet records
  the last value this tool wrote to `Human Review`, but not who changed it last. So if the tool
  ticked a row, you cleared it, the state file was then lost, and you later tick it again by
  hand, the next repository change can read that tick as the tool's own and clear it. Keeping
  the state file (it lives in `.repo-smartsheet/`) avoids this entirely.
- **One thing the tool will not do:** if a row has no record of what this tool last wrote to
  `Human Review` - no `Repo Review` value and no local cache, which happens on rows imported by
  hand or created before that column existed - it can never tell its own tick from a person's.
  It therefore leaves that checkbox alone permanently, even when its own model says the row
  needs review. That is deliberate: a stale flag costs someone a glance, and clearing a real
  one loses a decision silently. Rows created by `setup-sheet` and synced by this tool always
  carry the record, so this only affects hand-made rows.
- **Upgrading a sheet made by an older build:** the identity digest went from 8 to 12 hex
  characters, so every `Item ID` changed. The tool does **not** try to work out which old row
  belongs to which item. Each item gets a fresh row, and the old rows are flagged
  `Missing in Repo` with every value you put on them still there, ready to merge by hand.

  That is a deliberate choice, and it is the more conservative one. Matching old rows was
  implemented and then removed, because nothing on a sheet reliably identifies which item a
  row belongs to: displayed text is clipped, several items share a file, an old 32-bit digest
  can collide, and redaction makes two different items identical on purpose. Every version of
  the check was defeated by some pair of rows that look alike. Guessing wrong moves somebody's
  Owner and Management Notes onto the wrong work and cannot be undone; a `Missing in Repo`
  flag costs a few minutes and loses nothing. Run `sync --dry-run` first to see the list.

- **State management:** local `state.json` is a cache; `Item ID` + `Repo Fingerprint` + `Repo Status` + `Repo Review` + `Repo Path` in the sheet are sufficient to rebuild it (tested). Those five plus `Sync Status` are enforced as required columns: `SmartsheetTarget` refuses to sync a sheet missing any of them rather than silently mislabelling edits.
- **Security:** sensitive-path gate before ignore rules, regex redaction at the excerpt boundary, env-only credentials, no repo writes.
- **Conflict handling:** human-controlled columns written on create only; shared columns merged; conflicts keep the human value and flag.
- **Testing:** 133 vitest cases including fake-`fetch` client tests and an in-memory `SheetTarget` for engine tests.
