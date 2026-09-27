# Genre listening poll

Blinded listening test for comparing a frozen genre model with the original
annotation and a random control genre.

- 10 rooms
- 10 songs per room
- 100 unique, repository-hosted audio previews
- randomized option order per questionnaire session
- anonymous participant and session identifiers
- retry-safe submission collection and CSV export

The master page will be published at `https://ari0u.github.io/poll/`. It redirects
each participant to a random room. After completing a room, the participant can
continue to the next room modulo ten.

## Deployment

The Pages workflow validates every public field and audio SHA-256 before
publishing only the participant-facing runtime. In GitHub:

1. Set **Settings → Pages → Source** to **GitHub Actions**.
2. Create the Actions repository variable `LISTENING_TEST_ENDPOINT` with the
   credential-free HTTPS URL of the response collector.
3. Push `main` or run the Pages workflow manually.

The browser serves audio from this repository; it does not access S3. Completed
responses are posted to the HTTPS collector under `listening_test/backend/`,
which validates them against a private question bank and stores immutable CSV
objects in its private S3 bucket.

Private question banks, the candidate CSV, response exports, and semantic
model/annotation/control mappings must never be committed here.

See [the study documentation](listening_test/README.md) and
[collector deployment documentation](listening_test/backend/README.md) for the
full operational and analysis instructions.
