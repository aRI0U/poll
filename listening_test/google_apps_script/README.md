# Google Apps Script result collector

This collector replaces the AWS backend. It accepts one completed 10-question
room, validates it against the private question bank, derives the blinded
`model` / `annotation` / `random` roles, and appends ten analysis-ready rows to a
private Google Sheet.

Retries are safe. A hidden `_Submissions` sheet records the canonical payload
hash and a reserved ten-row range under a script lock. The same
`submission_id` and payload resumes or returns `already_stored`; reusing an ID
with different content is rejected. A pending write can be repaired by the next
identical retry.

## 1. Verify the active bank

From the `ms_genre` repository root, run:

```bash
python3 listening_test/google_apps_script/prepare_setup.py
```

For the current 10-room, 10-question study it prints the exact private file to
upload and these two integrity pins:

```text
EXPECTED_BANK_SHA256=5239bacf889f9a67f4932e5b641159a2808f28e4279b3ac88cbe34e0211e5822
PRIVATE_BANK_FILE_SHA256=b632066f0690d4f2546d442777b7a0820d11a0b36206891b3054bcc6d27ca004
```

The first digest identifies the public/logical question bank. The second pins
the exact bytes uploaded to private Drive. Both checks are required because
Python and JavaScript serialize one small floating-point value differently.

Do not put the `.private.json` bank in the public poll repository.

## 2. Create private Google storage

1. Create a Google Sheet named, for example, `Genre listening results`.
2. Copy its ID from `https://docs.google.com/spreadsheets/d/SHEET_ID/edit`.
3. Upload the exact private-bank file printed by `prepare_setup.py` to Google
   Drive. Leave its sharing setting **Restricted**.
4. Copy its file ID from the Drive URL.

The Sheet and bank file must be accessible to the Google account that owns the
Apps Script project. Neither should be shared with participants.

## 3. Create the Apps Script project

Open [script.google.com](https://script.google.com), create a standalone
project, and add the files from this directory:

- replace the default `Code.gs` with [`Code.gs`](Code.gs);
- add a script file named `CollectorCore` and paste
  [`CollectorCore.gs`](CollectorCore.gs);
- enable **Show `appsscript.json` manifest file in editor** in Project Settings,
  then replace its contents with [`appsscript.json`](appsscript.json).

The implementation does not depend on Apps Script's multi-file evaluation
order.

In **Project Settings → Script Properties**, add exactly:

| Property | Value |
| --- | --- |
| `SPREADSHEET_ID` | ID of the private results Sheet |
| `PRIVATE_BANK_FILE_ID` | ID of the restricted Drive JSON file |
| `PRIVATE_BANK_FILE_SHA256` | value printed by `prepare_setup.py` |
| `EXPECTED_BANK_SHA256` | value printed by `prepare_setup.py` |
| `ACK_TARGET_ORIGIN` | `https://ari0u.github.io` |

`ACK_TARGET_ORIGIN` is an exact origin: no path and no trailing slash.

Select `initializeCollector` in the editor and click **Run**. Approve the Drive
read and Sheets permissions. A successful run logs a JSON summary and creates:

- `Responses`, the visible analysis table;
- `_Submissions`, a hidden idempotency/write registry.

Initialization refuses a modified bank, wrong digest, wrong room size, or
unexpected Sheet schema.

## 4. Deploy the web app

Choose **Deploy → New deployment → Web app**:

- **Execute as:** Me
- **Who has access:** Anyone

Some managed Google Workspace domains disable anonymous web apps; use a
personal Google account if `Anyone` is unavailable.

Copy the deployed `/exec` URL, which must look like:

```text
https://script.google.com/macros/s/DEPLOYMENT_ID/exec
```

In GitHub, open `aRI0U/poll` → **Settings → Secrets and variables → Actions →
Variables**, create `GOOGLE_APPS_SCRIPT_URL` with that URL, and rerun the Pages
deployment workflow.

After any Apps Script source change, create a **new deployment version**. Saving
the editor alone does not update an existing deployed version.

## How browser acknowledgements work

The static poll submits a hidden HTML form with exactly two fields:

- `payload`: the schema-v1 JSON result;
- `ack_nonce`: a fresh lowercase UUIDv4.

Apps Script writes the result and returns an `HtmlService` page in the hidden
iframe. That page sends this message to the exact `ACK_TARGET_ORIGIN` with
`window.top.postMessage`:

```json
{
  "type": "genre-listening-test-submission-ack",
  "ok": true,
  "status": "stored",
  "submission_id": "…",
  "ack_nonce": "…",
  "rows_stored": 10
}
```

The client checks the Google sender origin, type, nonce, submission ID, status,
and row count. Error acknowledgements use `ok: false`, `status: "rejected"`,
plus `error` and `message`. No token or Sheet ID is exposed to the browser.

## Retrieve results as CSV

Open the results spreadsheet, select `Responses`, then choose **File → Download
→ Comma-separated values (.csv), current sheet**. The file already contains one
row per answer and ten rows per completed room, including:

- participant, submission, room, and question identifiers;
- rendered option labels and their semantic roles;
- selected index, label, and semantic role;
- annotation/model/random genres and model scores;
- client timing and audio-listening metrics;
- server receipt time and canonical payload hash.

The hidden registry is operational metadata and should not be included in the
analysis export.

## Test before inviting participants

Run the cloud-free suite:

```bash
deno test --allow-read listening_test/google_apps_script/tests/collector_core_test.js
python3 listening_test/google_apps_script/prepare_setup.py --json
```

The local suite covers strict JSON/schema validation, private semantic mapping,
ten-row output, identical retry vs conflict behavior, immutable receipt times,
interrupted-row recovery, Sheet growth beyond its initial 26 columns/1,000 rows,
formula-injection rejection, ACK injection safety, reverse Apps Script file
evaluation, and the exact active private-bank file when it is present locally.

After deployment, complete one real room and confirm exactly ten new
`Responses` rows plus one `complete` registry row. Retry the same saved
submission and confirm it does not add rows. Then download `Responses` as CSV
and inspect it before distributing the master link.

## Operational limits and privacy

The web app is publicly writable because participants are anonymous. The
collector strictly checks every field against the private bank, but it cannot
prove that a submission came from a human participant. Keep the endpoint out of
unrelated channels, monitor the Sheet, retain the idempotency registry, and stay
within Apps Script/Sheets quotas.

Participant IDs are random browser UUIDs, not login identities. Still treat the
Sheet as research data: keep it restricted, define a retention period, and do
not collect names or email addresses through this endpoint.
