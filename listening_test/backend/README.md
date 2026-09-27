# Listening-test response collector

This directory deploys a public AWS Lambda Function URL that accepts only the
configured GitHub Pages origin. The Lambda validates every complete room against
the private, content-addressed question bank and writes one 10-row CSV per
submission to a private S3 bucket. S3 Object Lock (governance mode), bucket
versioning, and `If-None-Match: *` make the logical submission key immutable.

The browser never sends or receives semantic roles. It sends labels in rendered
order plus a selected zero-based index; the Lambda derives `model`, `annotation`,
and `random` from the private bank. Retries with an identical `submission_id` and
payload return `already_stored`; reuse with different content returns HTTP 409.

## Deploy

The only prerequisite is an authenticated AWS CLI session with CloudFormation,
Lambda, IAM, and S3 deployment rights. The fourth argument is the region and the
fifth argument is an existing artifact bucket (or set `ARTIFACT_BUCKET`). The
origin must be only the scheme and hostname (no path or trailing slash).
`http://localhost:PORT` and `http://127.0.0.1:PORT` are accepted for staging
stacks. From the repository root:

```bash
chmod +x listening_test/backend/deploy.sh
listening_test/backend/deploy.sh \
  genre-listening-test \
  https://YOUR_ACCOUNT.github.io \
  outputs/genre_listening_test/question_banks/QUESTION_BANK_SHA256.private.json \
  us-east-1 \
  YOUR_ARTIFACT_BUCKET
```

The final line is the Function URL. Copy it to `submissionEndpoint` in the static
site configuration before publishing GitHub Pages. The first deployment creates
the retained private bucket, then uploads the bank; do not advertise the URL
until the script completes. Use a new study/question-bank version rather than
altering an active bank.

The generated bucket has a 90-day default governance retention period. Set the
`ResponseRetentionDays` CloudFormation parameter deliberately if your data
retention policy requires a different value. Deleting the stack retains the
bucket and its contents.

## Export

Use the `StorageBucketName` stack output with credentials allowed to list and
read `responses/`:

```bash
python3 listening_test/backend/export_results.py \
  --bucket PRIVATE_BUCKET_NAME \
  --prefix responses/ \
  --output listening-test-results.csv
```

The exporter rejects malformed objects, duplicate submission IDs, wrong headers,
or anything other than ten ordered rows per submission. Pass `--force` only when
you intend to replace an existing local export.

## Request contract

`POST` must use `Content-Type: application/json` and the exact configured
`Origin`. The strict schema is version 1:

```text
study_version, question_bank_sha256, submission_id (UUIDv4), participant_id
(UUIDv4), room_id, room_sequence, consent_version="1", app_build,
started_at_client, completed_at_client, answers[10]

answer: question_id, question_position, option_order[3], selected_index,
shown_at_client, answered_at_client, elapsed_ms, audio_play_count,
audio_listened_ms
```

All timestamps are RFC 3339 with an explicit offset. Unknown and missing fields,
partial rooms, mismatched option orders, stale bank hashes, invalid counters,
and inconsistent timestamps are rejected before S3 is written.
