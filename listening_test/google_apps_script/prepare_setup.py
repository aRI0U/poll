#!/usr/bin/env python3
"""Validate and print the exact inputs for the Apps Script deployment."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PUBLIC_BANK = REPOSITORY_ROOT / "listening_test/site/data/questions.json"
PRIVATE_BANK_DIRECTORY = REPOSITORY_ROOT / "outputs/genre_listening_test/question_banks"
ACK_TARGET_ORIGIN = "https://ari0u.github.io"


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def setup_values(private_bank: Path | None = None) -> dict[str, Any]:
    public = load_json(PUBLIC_BANK)
    digest = public.get("question_bank_sha256")
    if not isinstance(digest, str) or len(digest) != 64:
        raise ValueError("public question bank has no valid question_bank_sha256")
    bank_path = private_bank or PRIVATE_BANK_DIRECTORY / f"{digest}.private.json"
    bank_path = bank_path.resolve()
    private = load_json(bank_path)
    core = {
        key: private[key]
        for key in ("schema_version", "study_version", "room_size", "room_count", "rooms")
    }
    computed = hashlib.sha256(canonical_bytes(core)).hexdigest()
    if computed != digest or private.get("question_bank_sha256") != digest:
        raise ValueError("private bank contents do not match the active public-bank digest")
    if private.get("room_size") != 10:
        raise ValueError("the active private bank must have exactly 10 questions per room")
    rooms = private.get("rooms")
    if not isinstance(rooms, list) or len(rooms) != private.get("room_count"):
        raise ValueError("private room_count does not match rooms")
    question_count = sum(len(room.get("questions", [])) for room in rooms)
    if any(len(room.get("questions", [])) != 10 for room in rooms):
        raise ValueError("every private room must have exactly 10 questions")
    return {
        "private_bank_to_upload": str(bank_path),
        "private_bank_bytes": bank_path.stat().st_size,
        "private_bank_file_sha256": hashlib.sha256(bank_path.read_bytes()).hexdigest(),
        "study_version": private.get("study_version"),
        "room_count": private.get("room_count"),
        "room_size": private.get("room_size"),
        "question_count": question_count,
        "script_properties": {
            "SPREADSHEET_ID": "PASTE_RESULTS_SHEET_ID",
            "PRIVATE_BANK_FILE_ID": "PASTE_PRIVATE_DRIVE_FILE_ID",
            "PRIVATE_BANK_FILE_SHA256": hashlib.sha256(bank_path.read_bytes()).hexdigest(),
            "EXPECTED_BANK_SHA256": digest,
            "ACK_TARGET_ORIGIN": ACK_TARGET_ORIGIN,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-bank", type=Path, help="override the inferred private bank")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    arguments = parser.parse_args()
    values = setup_values(arguments.private_bank)
    if arguments.json:
        print(json.dumps(values, indent=2, ensure_ascii=False))
        return
    print("Validated Google Apps Script collector inputs")
    print(f"Private bank to upload: {values['private_bank_to_upload']}")
    print(f"Private bank size:      {values['private_bank_bytes']} bytes")
    print(
        "Study layout:          "
        f"{values['room_count']} rooms x {values['room_size']} questions "
        f"= {values['question_count']} questions"
    )
    print("\nAdd these Script Properties in the Apps Script project:")
    for key, value in values["script_properties"].items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
