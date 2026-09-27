#!/usr/bin/env python3
"""Download and merge immutable listening-test response CSVs from private S3."""

from __future__ import annotations

import argparse
import csv
import io
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any, BinaryIO

if __package__:
    from .handler import CSV_FIELDS, ROOM_SIZE
else:  # Allow ``python listening_test/backend/export_results.py``.
    from handler import CSV_FIELDS, ROOM_SIZE


MAX_RESULT_BYTES = 1024 * 1024
EXPORT_FIELDS = ("source_object_key", *CSV_FIELDS)


def _read_result(key: str, data: bytes) -> list[dict[str, str]]:
    if len(data) > MAX_RESULT_BYTES:
        raise ValueError(f"{key}: object exceeds {MAX_RESULT_BYTES} bytes")
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ValueError(f"{key}: object is not UTF-8") from error
    reader = csv.DictReader(io.StringIO(text, newline=""), strict=True)
    if reader.fieldnames != list(CSV_FIELDS):
        raise ValueError(f"{key}: unexpected CSV header")
    try:
        rows = list(reader)
    except csv.Error as error:
        raise ValueError(f"{key}: malformed CSV: {error}") from error
    if len(rows) != ROOM_SIZE:
        raise ValueError(f"{key}: expected {ROOM_SIZE} rows, found {len(rows)}")
    if any(None in row or any(value is None for value in row.values()) for row in rows):
        raise ValueError(f"{key}: malformed row width")
    submission_ids = {row["submission_id"] for row in rows}
    positions = [row["question_position"] for row in rows]
    if len(submission_ids) != 1 or positions != [str(value) for value in range(1, ROOM_SIZE + 1)]:
        raise ValueError(f"{key}: inconsistent submission ID or question positions")
    return rows


def merge_csv_objects(objects: Iterable[tuple[str, bytes]]) -> bytes:
    """Validate and deterministically combine ``(S3 key, CSV bytes)`` objects."""

    parsed: list[tuple[str, list[dict[str, str]]]] = []
    seen_submissions: set[str] = set()
    for key, data in sorted(objects, key=lambda item: item[0]):
        if not key.endswith(".csv"):
            continue
        rows = _read_result(key, data)
        submission_id = rows[0]["submission_id"]
        if submission_id in seen_submissions:
            raise ValueError(f"duplicate submission_id across objects: {submission_id}")
        seen_submissions.add(submission_id)
        parsed.append((key, rows))
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=EXPORT_FIELDS, lineterminator="\n")
    writer.writeheader()
    for key, rows in parsed:
        for row in rows:
            writer.writerow({"source_object_key": key, **row})
    return output.getvalue().encode("utf-8")


def _object_keys(s3: Any, bucket: str, prefix: str) -> list[str]:
    keys: list[str] = []
    continuation: str | None = None
    while True:
        request: dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
        if continuation:
            request["ContinuationToken"] = continuation
        response = s3.list_objects_v2(**request)
        for item in response.get("Contents", []):
            key = item.get("Key")
            if isinstance(key, str) and key.endswith(".csv"):
                keys.append(key)
        if not response.get("IsTruncated"):
            return sorted(keys)
        continuation = response.get("NextContinuationToken")
        if not isinstance(continuation, str) or not continuation:
            raise RuntimeError("S3 returned a truncated listing without a continuation token")


def _read_limited(body: BinaryIO, *, key: str) -> bytes:
    data = body.read(MAX_RESULT_BYTES + 1)
    if len(data) > MAX_RESULT_BYTES:
        raise ValueError(f"{key}: object exceeds {MAX_RESULT_BYTES} bytes")
    return data


def export_from_s3(s3: Any, *, bucket: str, prefix: str) -> bytes:
    objects: list[tuple[str, bytes]] = []
    for key in _object_keys(s3, bucket, prefix):
        response = s3.get_object(Bucket=bucket, Key=key)
        body = response.get("Body")
        if body is None or not hasattr(body, "read"):
            raise RuntimeError(f"{key}: S3 returned no readable body")
        objects.append((key, _read_limited(body, key=key)))
    return merge_csv_objects(objects)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True, help="Private response bucket name")
    parser.add_argument("--prefix", default="responses/", help="Response object prefix")
    parser.add_argument("--output", type=Path, required=True, help="Destination merged CSV")
    parser.add_argument("--region", help="AWS region override")
    parser.add_argument("--profile", help="AWS profile override")
    parser.add_argument("--force", action="store_true", help="Replace an existing destination file")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if args.output.exists() and not args.force:
        raise FileExistsError(f"output exists (pass --force to replace): {args.output}")
    import boto3

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    merged = export_from_s3(
        session.client("s3"),
        bucket=args.bucket,
        prefix=args.prefix.strip("/") + "/",
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(f".{args.output.name}.tmp")
    temporary.write_bytes(merged)
    temporary.replace(args.output)
    row_count = max(0, merged.count(b"\n") - 1)
    print(f"Wrote {row_count} answer rows to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
