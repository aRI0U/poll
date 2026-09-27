#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 || $# -gt 5 ]]; then
  echo "Usage: $0 STACK_NAME ALLOWED_ORIGIN PRIVATE_QUESTION_BANK [AWS_REGION] [ARTIFACT_BUCKET]" >&2
  exit 2
fi

STACK_NAME=$1
ALLOWED_ORIGIN=$2
QUESTION_BANK=$3
AWS_REGION=${4:-${AWS_REGION:-us-east-1}}
ARTIFACT_BUCKET=${5:-${ARTIFACT_BUCKET:-}}
ARTIFACT_PREFIX=${ARTIFACT_PREFIX:-genre-listening-test/cloudformation-artifacts}
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if [[ -z "$ARTIFACT_BUCKET" ]]; then
  echo "Set ARTIFACT_BUCKET or pass an artifact bucket as the fifth argument." >&2
  exit 2
fi

if [[ ! -f "$QUESTION_BANK" ]]; then
  echo "Private question bank not found: $QUESTION_BANK" >&2
  exit 2
fi

BANK_SHA=$(PYTHONPATH="$SCRIPT_DIR" python3 -c 'import json,sys; from handler import _validate_private_bank; value=json.load(open(sys.argv[1], encoding="utf-8")); print(_validate_private_bank(value).sha256)' "$QUESTION_BANK")
BANK_KEY="question-banks/${BANK_SHA}.json"

existing_bucket=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`StorageBucketName`].OutputValue | [0]' \
  --output text 2>/dev/null || true)

upload_bank() {
  local bucket=$1
  if aws s3api head-object --bucket "$bucket" --key "$BANK_KEY" --region "$AWS_REGION" \
    >/dev/null 2>&1; then
    echo "Private question bank already exists at s3://${bucket}/${BANK_KEY}"
  else
    aws s3api put-object \
      --bucket "$bucket" \
      --key "$BANK_KEY" \
      --body "$QUESTION_BANK" \
      --content-type application/json \
      --server-side-encryption AES256 \
      --if-none-match '*' \
      --region "$AWS_REGION" >/dev/null
    echo "Uploaded private question bank to s3://${bucket}/${BANK_KEY}"
  fi
}

if [[ -n "$existing_bucket" && "$existing_bucket" != "None" ]]; then
  upload_bank "$existing_bucket"
fi

PACKAGED_TEMPLATE=$(mktemp "${TMPDIR:-/tmp}/genre-listening-test-packaged.XXXXXX")
trap 'rm -f -- "$PACKAGED_TEMPLATE"' EXIT
aws cloudformation package \
  --template-file "$SCRIPT_DIR/template.yaml" \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --s3-prefix "$ARTIFACT_PREFIX" \
  --output-template-file "$PACKAGED_TEMPLATE" \
  --region "$AWS_REGION"
aws cloudformation deploy \
  --template-file "$PACKAGED_TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "AllowedOrigin=$ALLOWED_ORIGIN" \
    "QuestionBankKey=$BANK_KEY"

bucket=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`StorageBucketName`].OutputValue | [0]' \
  --output text)
upload_bank "$bucket"

aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`CollectorUrl`].OutputValue | [0]' \
  --output text
