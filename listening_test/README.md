# Genre annotation listening test

This study asks listeners to choose the best genre label for a clip from three blinded choices:
the frozen ACE/RIDE output, the existing annotation, and a distinct control genre. The browser
never receives the semantic source of a choice; the private collector derives it after submission.

## Generated study

- Candidate pool: 11,117 disagreements (5,400 validation; 5,717 test).
- Publication contract: 100 unique clips in ten rooms of ten. The generator balances
  validation/test, confidence, and annotation-genre strata; the generated build summary records
  the exact coverage for a particular bank. Selected audio objects and artists are unique.
- Master link: `site/index.html` assigns a cryptographically random room.
- Another questionnaire: advances to the next room modulo ten and retains the anonymous
  participant UUID.
- Collection: one immutable ten-row CSV per completed room, later merged by the private
  exporter.

The complete private candidate CSV, matrices, plot, build summary, and versioned semantic bank are
under `../outputs/genre_listening_test/`. They are intentionally ignored by Git and must never be
copied into `site/`.

## Rebuild and verify

From the repository root:

```bash
.venv/bin/python scripts/prepare_genre_listening_test.py
.venv/bin/python -m pytest -q \
  tests/test_prepare_genre_listening_test.py \
  tests/test_listening_test_backend.py
deno check listening_test/site/core.js listening_test/site/master.js listening_test/site/room.js
deno test listening_test/site/tests/core_test.js
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

This is a purposive macro-balanced diagnostic panel, not a probability sample of the 11,117
disagreements. Its raw preference rate describes these 100 questions only. Roughly 300 completed
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
2. Deploy the AWS collector with the final Pages origin and versioned private bank, following
   `backend/README.md`.
3. Set the GitHub repository variable `LISTENING_TEST_ENDPOINT` to the returned HTTPS Function URL.
4. Push this repository (or only the Pages artifact plus workflow) to the intended GitHub Pages
   repository and enable **Settings → Pages → Source: GitHub Actions**.
5. Submit a staging room, retry the same submission ID, verify there is one private S3 CSV, and run
   the exporter before inviting listeners.

The workflow publishes an explicit participant-runtime allowlist rather than the whole `site/`
source tree, so developer documentation and tests are not exposed with the questionnaire.

The current workspace has no Git remote or commit history, so the final Pages origin and push
cannot be inferred here.
