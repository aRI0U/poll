# Static listening-test client

Serve this directory as the root of a static site (including GitHub Pages).
`index.html` is the master link: it validates the public bank and redirects to a
cryptographically random room. `room.html` runs one ten-question questionnaire.

## Public question-bank contract

The browser deliberately receives labels only. Model/annotation/random roles
must remain in the private backend bank so participants cannot discover them in
page source or browser storage.

```jsonc
{
  "schema_version": 1,
  "study_version": "study-v1",
  "question_bank_sha256": "64-character lowercase SHA-256",
  "room_size": 10,
  "room_count": 10,
  "rooms": [
    {
      "room_id": 0,
      "questions": [
        {
          "question_id": "q_0123456789abcdefabcd",
          "audio": "assets/<question-bank-sha256>/q_0123456789abcdefabcd.mp3",
          "audio_sha256": "64-character lowercase SHA-256",
          "choices": ["Genre A", "Genre B", "Genre C"]
        }
        // 9 more questions
      ]
    }
    // 9 more rooms
  ]
}
```

Every room must contain exactly `room_size` questions, every question and room
ID must be unique, and every question must have three distinct non-empty labels.
Audio paths are relative to the site root (the directory containing `room.html`)
and use a question-bank-versioned, content-addressed directory. `audio_sha256`
verifies the published bytes during the Pages build. Choice order is shuffled
from the session UUID and stored with the in-progress session, so reloads cannot
silently change it.

The current Pages publication gate requires exactly 10 rooms of 10 questions
(100 unique clips). The browser still derives navigation and modulo wraparound
from the manifest's `room_count` rather than embedding the room count in
application logic.

## Google Apps Script collector request

The Pages workflow injects the deployed Apps Script URL from the repository
variable `GOOGLE_APPS_SCRIPT_URL`. It must have the standard form
`https://script.google.com/macros/s/<deployment-id>/exec`; credentials, query
parameters, fragments, other hosts, and non-HTTPS URLs are rejected. The
form's `payload` field contains this JSON object:

```text
schema_version, study_version, question_bank_sha256,
submission_id, participant_id, room_id, room_sequence,
consent_version, app_build, started_at_client, completed_at_client,
answers[10] {
  question_id, question_position, option_order[3], selected_index,
  shown_at_client, answered_at_client, elapsed_ms,
  audio_play_count, audio_listened_ms
}
```

The collector's private `ACK_TARGET_ORIGIN` Script Property must be the exact
Pages origin, `https://ari0u.github.io` (an origin has no `/poll` path).

The client submits a hidden HTML form containing `payload` (the JSON string)
and a fresh high-entropy `ack_nonce` into a hidden iframe. Standard form POSTs
do not need CORS preflight. After committing or recognizing an idempotent
duplicate, the Apps Script HTML response sends a nonce-bound acknowledgement
to the top-level page with `postMessage`. The client accepts it only when the
message type, nonce, and `submission_id` all match and the message comes from an
Apps Script Google origin. Apps Script adds a sandbox iframe, so the client does
not depend on `event.source` identity.

The completion screen is shown only after that acknowledgement confirms the
spreadsheet write. A missing acknowledgement is treated as a retryable timeout;
the iframe is removed and the next attempt keeps the same `submission_id` but
uses a new nonce. JSON/CSV backups remain available after both success and
failure.

`submission_id` is the retry-safe idempotency key. Timeouts and network errors
reuse the same payload and ID, so the script must atomically ignore an exact
duplicate and reject a conflicting reuse. The script should validate all labels
and question IDs against its private bank and derive the selected semantic role
there. Do not place credentials in `config.js`; it is public.

The browser persists unfinished and pending sessions in `localStorage`, retries
transport failures with the same submission ID, and offers rich JSON/CSV
backups. The next-questionnaire
button advances to the next room modulo `room_count` and increments
`room_sequence`. Sequence progress is scoped to the validated question-bank
fingerprint, so publishing a new bank resets it even when `study_version` is
reused.

## Local checks

From the repository root, when Deno is available:

```sh
deno check listening_test/site/core.js listening_test/site/master.js listening_test/site/room.js
deno test listening_test/site/tests/core_test.js
```

For a manual run, serve the repository over HTTP; browsers commonly block
`fetch` from `file://`.
