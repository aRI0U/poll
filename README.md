# Genre listening poll

Blinded listening test for comparing a frozen genre model with the original
annotation and a random control genre.

- 10 rooms
- 10 songs per room
- 100 unique, repository-hosted audio previews
- randomized option order per questionnaire session
- anonymous participant and session identifiers
- retry-safe collection in a private Google Sheet and direct CSV export

The master page will be published at `https://ari0u.github.io/poll/`. It redirects
each participant to a random room. After completing a room, the participant can
continue to the next room modulo ten.

## Deployment

The Pages workflow validates every public field and audio SHA-256 before
publishing only the participant-facing runtime. In GitHub:

1. Set **Settings → Pages → Source** to **GitHub Actions**.
2. Deploy the collector in `listening_test/google_apps_script/` as an
   owner-executed web app available to anyone.
3. Create the Actions repository variable `GOOGLE_APPS_SCRIPT_URL` with its
   public `https://script.google.com/macros/s/.../exec` URL.
4. Push `main` or run the Pages workflow manually.

The browser serves audio from this repository; it does not access S3. The Apps
Script collector validates each completed room against a restricted Drive bank,
derives the blinded semantic roles, and appends ten analysis-ready rows to a
private Google Sheet. Export the `Responses` tab as CSV whenever needed.

Private question banks, the candidate CSV, response exports, and semantic
model/annotation/control mappings must never be committed here.

See [the study documentation](listening_test/README.md) and
[collector deployment documentation](listening_test/google_apps_script/README.md)
for the full operational and analysis instructions.
