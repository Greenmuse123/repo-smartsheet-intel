# Smartsheet setup: API path and CSV fallback

## A. With API access (recommended)

> **Plan requirement (verified 2026-08-26 against a live account):** API access needs a
> **Business plan or higher** (3-member minimum). The **Free plan and the 30-day trial
> cannot generate a token** - the "Generate new access token" button is present but opens
> an "Upgrade for Smartsheet API" paywall. If you are on Free or trial, use path B.

1. In Smartsheet: **Account → Apps & Integrations → API Access → Generate new access token**.
2. `cp .env.example .env` and paste the token as `SMARTSHEET_ACCESS_TOKEN=...` (the file is git-ignored).
3. `npx rsi setup-sheet` - creates the sheet with all 22 columns, correct types and dropdown options, and prints the sheet id.
4. Put `SMARTSHEET_SHEET_ID=<id>` in `.env`.
5. `npx rsi sync --dry-run`, then `npx rsi sync`.

## B. Without API access (CSV fallback)

1. `npx rsi export-csv` → `output/<project>/smartsheet_import.csv` and `column-definitions.json`.
2. In Smartsheet: **Create → Import → Microsoft Excel / CSV**, choose the CSV, tick "first row is header".
   > The file is **UTF-8 with a byte-order mark, deliberately**. Smartsheet sniffs the encoding
   > and rejects a BOM-less file with "Failed to upload file" the moment it contains any
   > multibyte character - which the bundled sample does, via the truncator's `…` ellipsis.
   > Do not re-save the CSV in an editor that strips the BOM. CRLF line endings are correct
   > and are not the problem; the exporter keeps all non-ASCII text verbatim on purpose.
3. Smartsheet imports every column as Text/Number. Set the column types from `column-definitions.json`:
   - Right-click a column header → **Edit Column Properties**.
   - `Type`, `Status`, `Priority`, `Confidence`, `Sync Status`, `Repo Status` → **Dropdown (Single Select)**, paste the options listed in the JSON.
   - `Owner` → **Contact List**. `Due Date`, `Last Repo Update` → **Date**.
   - `Human Review`: **leave it as Text/Number on the CSV path.**
     > **Verified 2026-08-26 against a live sheet - do not skip this.** Converting the column to
     > **Checkbox does NOT convert the imported "Yes"/"No" text.** The cells keep the literal
     > strings, every box renders **unchecked**, and `COUNTIF([Human Review]:[Human Review], true)`
     > and `COUNTIF(..., 1)` both return **0** while `COUNTIF(..., "Yes")` returns the true count.
     > A checkbox column that shows 23 empty boxes when 3 items need review is worse than a text
     > column that says "Yes" - so keep it as text and count `"Yes"`, or tick the boxes by hand.
     >
     > **This affects the CSV path only.** `csvFor()` renders booleans as `Yes`/`No`
     > (`src/adapters/csv.ts:16`), whereas the API path sends a real JSON boolean
     > (`src/adapters/smartsheet/mapper.ts`), so `rsi sync` produces genuine checkboxes.
     > This is a concrete reason to prefer path A when a token is available.
4. Re-importing later: import to a *new* sheet, then compare on **Item ID**; the sync engine's dedup logic only runs on the API path. The CSV is a snapshot; the `Sync Status` column will say `New` for every row.

## C. Polish (both paths, UI only - a few minutes)

- **Hide technical columns:** AI Suggestion, Repo Status, Source Commit, Last Synced, Repo Fingerprint → right-click → Hide Column.
- **Filter "Needs my attention":** Filter → New Filter → `Human Review is checked` OR `Status is Blocked` OR `Sync Status is Conflict`. Share it.
- **Conditional formatting:** row red when `Sync Status = Conflict`; amber when `Human Review` is checked; grey when `Sync Status = Missing in Repo`.
- **Automation (Automation → Create workflow):** *When Human Review changes to checked → Alert someone: the Owner contact.* And a weekly reminder to the PM on rows where `Status = Blocked`.
- **Update request:** on rows where `Owner` is blank, send an Update Request asking "Who owns this?" - humans fill Owner; the sync never overwrites it.

## D. Management view (Summary sheet + dashboard)

Create a small sheet `Repo Intelligence - Summary` with one row per metric and a cross-sheet formula (Smartsheet: `COUNTIF({Column}, criterion)` referencing the main sheet):

| Metric | Formula (reference the main sheet's column) |
|---|---|
| Total Open Items | `=COUNTIFS({Status}, <>"Done", {Status}, <>"Released", {Sync Status}, <>"Missing in Repo")` |
| Completed Items | `=COUNTIFS({Status}, OR(@cell = "Done", @cell = "Released"))` |
| Blocked Items | `=COUNTIF({Status}, "Blocked")` |
| High-Priority Items | `=COUNTIF({Priority}, "High")` |
| Items Requiring Review | `=COUNTIF({Human Review}, "Yes")` on the CSV path; `=COUNTIF({Human Review}, true)` once synced via the API |
| Recently Changed (7 days) | `=COUNTIF({Last Repo Update}, >= TODAY(-7))` |

Then **Create → Dashboard** with six Metric widgets pointing at those cells and one Report widget showing the "Needs my attention" filter. That answers "what needs my attention?" in about five seconds.
