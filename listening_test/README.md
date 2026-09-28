# Genre annotation listening test

This study asks listeners to choose the best genre label for a clip from three blinded choices:
the frozen ACE/RIDE output, the existing annotation, and a distinct control genre. The browser
never receives the semantic source of a choice; the private collector derives it after submission.

## Generated study

- Candidate pool: 10,158 eligible disagreements (4,896 validation; 5,262 test) after removing
  every question whose annotation or model output is `Stage & Screen` or `Miscellaneous`.
  Neither genre is eligible as a random control.
- Publication contract: 100 unique clips in ten rooms of ten. The generator balances
  validation/test, confidence, and annotation-genre strata; the generated build summary records
  the exact coverage for a particular bank. Selected audio objects and artists are unique.
- Master link: `site/index.html` assigns a cryptographically random room.
- Another questionnaire: advances to the next room modulo ten and retains the anonymous
  participant UUID.
- Collection: one validated row per answer in a private Google Sheet, with an idempotent
  submission registry and direct CSV export from Sheets.

The complete private candidate CSV, matrices, plot, build summary, and versioned semantic bank are
under `../outputs/genre_listening_test/`. They are intentionally ignored by Git and must never be
copied into `site/`.

## Rebuild and verify

From the repository root:

```bash
.venv/bin/python scripts/prepare_genre_listening_test.py
.venv/bin/python -m pytest -q tests/test_prepare_genre_listening_test.py
python3 listening_test/google_apps_script/prepare_setup.py
deno check listening_test/site/core.js listening_test/site/master.js listening_test/site/room.js
deno test listening_test/site/tests/core_test.js
deno test --allow-read=. listening_test/google_apps_script/tests/collector_core_test.js
```

Audio is published in a content-addressed directory under `site/assets/`; the public question-bank
manifest is switched only after the complete verified asset set and matching private bank exist.
The Pages artifact includes only the asset namespace referenced by the current manifest. Avoid
deploying a new bank while an older questionnaire may still be open; old local namespaces can be
retained for rollback and pruned deliberately.

## Analysis plan

Predeclare the primary outcome as model-versus-annotation preference among responses choosing one
of those two substantive labels. Report the control-genre choice rate separately; a control label
can occasionally be plausible and should not automatically be treated as listener error. Analyze
validation and test separately, and account for repeated ratings by both participant and question.
For descriptive panel estimates, equal-weight questions within each split so random room-traffic
imbalance does not silently change the estimand. Treat genre-specific results as exploratory: each
genre has only a few question clusters. Confidence bands are split-specific tertiles, so
interpret band effects within split or with an explicit split-by-band interaction rather than as
shared absolute score ranges.

This is a purposive macro-balanced diagnostic panel, not a probability sample of the 10,158
eligible disagreements. Its raw preference rate describes these 100 questions only. Roughly 300 completed
room questionnaires yield an average of 30 ratings per question across ten randomly assigned
rooms; add an imbalance buffer and treat that as a coverage target, not a formal power calculation.
For the primary analysis, retain only the first completed submission for each
`(participant_id, question_bank_sha256, room_id)`. A participant can revisit the master link and be
randomly assigned an already completed room before reaching room sequence ten, so do not identify
repeats from `room_sequence` alone.

Using judgments from the test questions for relabeling or model decisions exhausts the held-out
test set. Retire it from later confirmatory evaluation if that happens.

## Deployment

1. Confirm that the selected previews may be made internet-public. Presigned/private delivery is
   preferable if their redistribution rights do not allow GitHub Pages hosting.
2. Create and deploy the Google Apps Script collector with the final versioned private bank,
   following `google_apps_script/README.md`. Set its `ACK_TARGET_ORIGIN` Script Property to the
   exact Pages origin (`https://ari0u.github.io`).
3. Set the GitHub repository variable `GOOGLE_APPS_SCRIPT_URL` to the deployed Apps Script `/exec`
   URL.
4. Push this repository (or only the Pages artifact plus workflow) to the intended GitHub Pages
   repository and enable **Settings → Pages → Source: GitHub Actions**.
5. Submit a staging room, verify ten new `Responses` rows, then resend the same submission and
   verify the idempotency registry prevents duplicate rows before inviting listeners.

The workflow publishes an explicit participant-runtime allowlist rather than the whole `site/`
source tree, so developer documentation and tests are not exposed with the questionnaire.

The standalone publication repository is `poll/`, with remote
`https://github.com/aRI0U/poll.git`; its master URL is
`https://ari0u.github.io/poll/` after the Pages workflow succeeds.
