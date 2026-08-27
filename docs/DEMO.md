# Interactive browser demo (no setup)

For a live click-through in front of the PM, open **https://repo-smartsheet-intel.vercel.app/demo/** and press **Play the story** (or edit a file and press Sync). It runs the real engine in the browser; no account or token. The terminal `rsi demo` below is the equivalent for a CLI walkthrough.

---

# Demo script (3-5 minutes)

Audience: an engineering/product team. Setup: terminal in `app/`, `npm install` done, Smartsheet open in a browser tab (or skip to the CSV variant). Every command below is real output from the bundled sample repository "Orderly".

## 0:00 - The problem (20s)

"Project information is scattered across READMEs, changelogs, CI files and code comments. PMs hunt for it by hand. This tool reads the repository, never invents anything, and keeps a Smartsheet current. Watch what it refuses to guess."

## 0:20 - Analyze the repository (40s)

```
npx rsi report -c examples/sample-repo.project-config.yaml
```

Point at the log lines:

```
Analyzed 13 repository files (0 ignored by rules, 1 skipped as sensitive).
Found 23 trackable project items from 26 pieces of evidence.
3 items require human review.
```

Open `output/orderly/Repository-Intelligence-Report.md`. Show: "What this application appears to do" quotes the README with `README.md:1`; the "cannot reliably determine" section says due dates and priorities are blank on purpose; `config/credentials.example.json` was withheld.

## 1:00 - Show the evidence (40s)

```
npx rsi extract -c examples/sample-repo.project-config.yaml
```

Pick three items:
- `FIXME: sessions never expire` → **Bug**, Source `src/auth/session.js:5`, Owner `@maria, @dev-lee` *from CODEOWNERS*.
- `TODO(P1): daily summary report` → Priority **High** only because the code literally says P1.
- `Possible risk: package.json has no lockfile` → Type **Risk**, Confidence **Low**, Human Review **yes**, text in AI Suggestion, description says "not a fact".

## 1:40 - Preview, then sync (60s)

With a token in `.env` and a sheet from `npx rsi setup-sheet`:

```
npx rsi sync --dry-run -c examples/sample-repo.project-config.yaml
```

Shows `0 rows already exist … 23 new items will be created … Dry run: nothing was written to Smartsheet.` Then:

```
npx rsi sync -c examples/sample-repo.project-config.yaml
```

Switch to the browser: 23 rows, dropdowns populated, Human Review ticked on 3 rows, every row has a Source.

*CSV variant:* `npx rsi export-csv …` and import the file (docs/smartsheet-import.md, section B).

## 2:40 - Change the repo, sync again: no duplicates (50s)

In `examples/sample-repo/README.md` tick the box: `- [x] Email the customer when an order is ready (#42)`. Run the dry-run again:

```
1 item will be updated.   UPDATE RSI-CK-dad057ed  Email the customer when an order is ready (#42)  (status Not Started → Done)
22 items unchanged.
```

Run `sync`. Same row, now Done, `Sync Status = Updated`. Row count still 23.

## 3:30 - A human disagrees: conflict, not overwrite (40s)

In Smartsheet, set that row's Status to **Blocked**. In the repo, untick the box again. Sync:

```
1 conflict detected (human value kept, flagged for review).
CONFLICT RSI-CK-dad057ed … (status conflict: sheet says "Blocked", repo says "Not Started", last synced "Done")
```

The sheet still says Blocked; `Repo Status` says Not Started; the row is red; Human Review is ticked.

## 4:10 - Uncertain item goes to a human (20s)

Delete the FIXME line from `src/auth/session.js`, sync:

```
2 rows no longer found in the repository (kept, flagged).
MISSING RSI-TD-594c25cb sessions never expire; add a TTL and a cleanup job
MISSING RSI-RK-9c012f6c Possible risk: FIXME in a security-sensitive file …
```

Neither row is deleted; both become `Missing in Repo` with Human Review ticked (the bug and the risk suggestion that depended on it). "The tool does not know whether it was fixed or just removed, so it asks." Row count is still 23.

## 4:30 - Close (20s)

"Deterministic parsing, evidence on every row, three field classes so human decisions survive, idempotent sync, dry-run, 139 tests, and a CSV path when there is no API. The optional Claude pass writes to AI Suggestion and may fill an empty Description with a labelled summary; it never writes a fact column."

---

### Reset between rehearsals

`git checkout -- examples/sample-repo` and either delete the sheet rows or create a fresh sheet with `rsi setup-sheet`; remove `examples/.repo-smartsheet/`.
pitch url: https://repo-smartsheet-intel.vercel.app
