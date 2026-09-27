"""Strict AWS Lambda response collector for the genre listening test.

The browser is intentionally untrusted.  It reports opaque question identifiers,
the order in which labels were rendered, and a selected index.  This module
validates those values against a private question bank in S3 and derives the
model/annotation/random roles before writing one immutable CSV object.
"""

from __future__ import annotations

import base64
import binascii
import csv
import hashlib
import io
import json
import logging
import math
import os
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

SCHEMA_VERSION = 1
ROOM_SIZE = 10
MAX_BODY_BYTES = 64 * 1024
MAX_BANK_BYTES = 4 * 1024 * 1024
MAX_CLIENT_DURATION_MS = 31 * 24 * 60 * 60 * 1000
MAX_COUNTER = 1_000_000
UUID_V4_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
SAFE_VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
RFC3339_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$")
LOGGER = logging.getLogger(__name__)
EXPECTED_PAYLOAD_FIELDS = frozenset(
    {
        "schema_version",
        "study_version",
        "question_bank_sha256",
        "submission_id",
        "participant_id",
        "room_id",
        "room_sequence",
        "consent_version",
        "app_build",
        "started_at_client",
        "completed_at_client",
        "answers",
    }
)
EXPECTED_ANSWER_FIELDS = frozenset(
    {
        "question_id",
        "question_position",
        "option_order",
        "selected_index",
        "shown_at_client",
        "answered_at_client",
        "elapsed_ms",
        "audio_play_count",
        "audio_listened_ms",
    }
)
CSV_FIELDS = (
    "schema_version",
    "study_version",
    "question_bank_sha256",
    "consent_version",
    "app_build",
    "participant_id",
    "submission_id",
    "room_id",
    "room_sequence",
    "started_at_client",
    "completed_at_client",
    "question_position",
    "question_id",
    "split",
    "isrc",
    "audio_id",
    "published_audio_sha256",
    "annotation_subgenre",
    "option_1_label",
    "option_1_role",
    "option_2_label",
    "option_2_role",
    "option_3_label",
    "option_3_role",
    "selected_index",
    "selected_label",
    "selected_role",
    "annotation_genre",
    "model_genre",
    "random_genre",
    "model_confidence",
    "annotation_probability",
    "model_margin",
    "shown_at_client",
    "answered_at_client",
    "elapsed_ms",
    "audio_play_count",
    "audio_listened_ms",
)


class RequestError(Exception):
    """A safe, client-visible request failure."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class ConfigurationError(RuntimeError):
    """A collector or private-bank configuration failure."""


@dataclass(frozen=True)
class Question:
    raw: dict[str, Any]
    room_id: int
    position: int
    labels_to_roles: dict[str, str]


@dataclass(frozen=True)
class QuestionBank:
    raw: dict[str, Any]
    study_version: str
    sha256: str
    rooms: dict[int, tuple[Question, ...]]


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_non_finite(value: str) -> None:
    raise ValueError(f"non-finite JSON number: {value}")


def _load_json(data: bytes, *, description: str) -> Any:
    try:
        text = data.decode("utf-8", errors="strict")
        return json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_non_finite,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError(f"{description} is not valid strict UTF-8 JSON: {error}") from error


def _require_exact_fields(
    value: Mapping[str, Any], expected: frozenset[str], *, description: str
) -> None:
    actual = set(value)
    missing = sorted(expected - actual)
    extra = sorted(actual - expected)
    if missing or extra:
        detail = []
        if missing:
            detail.append(f"missing {', '.join(missing)}")
        if extra:
            detail.append(f"unexpected {', '.join(extra)}")
        raise ValueError(f"{description} has invalid fields ({'; '.join(detail)})")


def _require_string(value: Any, *, name: str, maximum: int = 256) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise ValueError(f"{name} must be a non-empty, trimmed string")
    if len(value) > maximum or any(ord(character) < 32 for character in value):
        raise ValueError(f"{name} is too long or contains control characters")
    return value


def _require_integer(value: Any, *, name: str, minimum: int = 0, maximum: int = MAX_COUNTER) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _require_finite_number(value: Any, *, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be numeric")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _require_uuid4(value: Any, *, name: str) -> str:
    text = _require_string(value, name=name, maximum=36)
    if not UUID_V4_RE.fullmatch(text):
        raise ValueError(f"{name} must be a lowercase RFC 4122 version-4 UUID")
    try:
        parsed = uuid.UUID(text)
    except ValueError as error:  # pragma: no cover - regex already excludes malformed UUIDs
        raise ValueError(f"{name} is not a valid UUID") from error
    if parsed.version != 4 or str(parsed) != text:
        raise ValueError(f"{name} must be a canonical version-4 UUID")
    return text


def _require_timestamp(value: Any, *, name: str) -> tuple[str, datetime]:
    text = _require_string(value, name=name, maximum=35)
    if not RFC3339_RE.fullmatch(text):
        raise ValueError(f"{name} must be an RFC 3339 timestamp")
    normalized = f"{text[:-1]}+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise ValueError(f"{name} must be an RFC 3339 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{name} must include a UTC offset")
    return text, parsed


def _validate_private_bank(raw: Any) -> QuestionBank:
    if not isinstance(raw, dict):
        raise ConfigurationError("private question bank must be a JSON object")
    expected = {
        "schema_version",
        "study_version",
        "question_bank_sha256",
        "room_size",
        "room_count",
        "rooms",
        "questions_by_id",
    }
    if set(raw) != expected:
        raise ConfigurationError("private question bank has an unexpected schema")
    try:
        _require_integer(
            raw["schema_version"],
            name="private schema_version",
            minimum=SCHEMA_VERSION,
            maximum=SCHEMA_VERSION,
        )
        study_version = _require_string(
            raw["study_version"], name="private study_version", maximum=128
        )
    except ValueError as error:
        raise ConfigurationError(str(error)) from error
    if not SAFE_VERSION_RE.fullmatch(study_version):
        raise ConfigurationError("private study_version contains unsafe characters")
    sha256 = raw["question_bank_sha256"]
    if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
        raise ConfigurationError("private question_bank_sha256 is invalid")
    try:
        _require_integer(
            raw["room_size"],
            name="private room_size",
            minimum=ROOM_SIZE,
            maximum=ROOM_SIZE,
        )
        room_count = _require_integer(raw["room_count"], name="private room_count", minimum=1)
    except ValueError as error:
        raise ConfigurationError(str(error)) from error
    rooms_raw = raw["rooms"]
    if not isinstance(rooms_raw, list) or not rooms_raw:
        raise ConfigurationError("private rooms must be a non-empty array")
    if room_count != len(rooms_raw):
        raise ConfigurationError("private room_count does not match rooms")

    bank_core = {
        "schema_version": raw["schema_version"],
        "study_version": raw["study_version"],
        "room_size": raw["room_size"],
        "room_count": raw["room_count"],
        "rooms": raw["rooms"],
    }
    computed_sha256 = hashlib.sha256(_canonical_json(bank_core)).hexdigest()
    if computed_sha256 != sha256:
        raise ConfigurationError("private question-bank digest does not match its contents")

    rooms: dict[int, tuple[Question, ...]] = {}
    questions_by_id: dict[str, dict[str, Any]] = {}
    required_question_fields = {
        "question_id",
        "room_id",
        "room_position",
        "split",
        "isrc",
        "audio_id",
        "published_audio_sha256",
        "annotation_genre",
        "annotation_subgenre",
        "model_genre",
        "random_genre",
        "model_confidence",
        "annotation_probability",
        "model_margin",
        "options",
    }
    for room_raw in rooms_raw:
        if not isinstance(room_raw, dict) or set(room_raw) != {"room_id", "questions"}:
            raise ConfigurationError("private room has an unexpected schema")
        try:
            room_id = _require_integer(room_raw["room_id"], name="private room_id")
        except ValueError as error:
            raise ConfigurationError(str(error)) from error
        if room_id in rooms:
            raise ConfigurationError(f"private room_id {room_id} is duplicated")
        room_questions = room_raw["questions"]
        if not isinstance(room_questions, list) or len(room_questions) != ROOM_SIZE:
            raise ConfigurationError(
                f"private room {room_id} must contain exactly {ROOM_SIZE} questions"
            )
        parsed_questions: list[Question] = []
        for question_raw in room_questions:
            if not isinstance(question_raw, dict) or set(question_raw) != required_question_fields:
                raise ConfigurationError("private question has an unexpected schema")
            try:
                question_id = _require_string(
                    question_raw["question_id"], name="private question_id", maximum=128
                )
                question_room = _require_integer(
                    question_raw["room_id"], name=f"{question_id} room_id"
                )
                position = _require_integer(
                    question_raw["room_position"],
                    name=f"{question_id} room_position",
                    minimum=1,
                    maximum=ROOM_SIZE,
                )
            except ValueError as error:
                raise ConfigurationError(str(error)) from error
            if question_room != room_id:
                raise ConfigurationError(f"private question {question_id} is in the wrong room")
            if question_id in questions_by_id:
                raise ConfigurationError(f"private question_id {question_id} is duplicated")
            if question_raw["split"] not in {"valid", "test"}:
                raise ConfigurationError(f"private question {question_id} has an invalid split")
            for field in (
                "isrc",
                "audio_id",
                "annotation_genre",
                "annotation_subgenre",
                "model_genre",
                "random_genre",
            ):
                try:
                    _require_string(question_raw[field], name=f"{question_id} {field}", maximum=512)
                except ValueError as error:
                    raise ConfigurationError(str(error)) from error
            published_audio_sha256 = question_raw["published_audio_sha256"]
            if not isinstance(published_audio_sha256, str) or not SHA256_RE.fullmatch(
                published_audio_sha256
            ):
                raise ConfigurationError(
                    f"private question {question_id} published_audio_sha256 is invalid"
                )
            for field in ("model_confidence", "annotation_probability", "model_margin"):
                try:
                    number = _require_finite_number(
                        question_raw[field], name=f"{question_id} {field}"
                    )
                except ValueError as error:
                    raise ConfigurationError(str(error)) from error
                if not 0.0 <= number <= 1.0:
                    raise ConfigurationError(
                        f"private question {question_id} {field} is out of range"
                    )

            options = question_raw["options"]
            if not isinstance(options, list) or len(options) != 3:
                raise ConfigurationError(f"private question {question_id} must have three options")
            labels_to_roles: dict[str, str] = {}
            for option in options:
                if not isinstance(option, dict) or set(option) != {"role", "label"}:
                    raise ConfigurationError(f"private question {question_id} option is invalid")
                role = option["role"]
                try:
                    label = _require_string(
                        option["label"], name=f"{question_id} option label", maximum=512
                    )
                except ValueError as error:
                    raise ConfigurationError(str(error)) from error
                if role not in {"model", "annotation", "random"}:
                    raise ConfigurationError(f"private question {question_id} role is invalid")
                if label in labels_to_roles or role in labels_to_roles.values():
                    raise ConfigurationError(
                        f"private question {question_id} options are duplicated"
                    )
                labels_to_roles[label] = role
            expected_role_labels = {
                "model": question_raw["model_genre"],
                "annotation": question_raw["annotation_genre"],
                "random": question_raw["random_genre"],
            }
            if {role: label for label, role in labels_to_roles.items()} != expected_role_labels:
                raise ConfigurationError(
                    f"private question {question_id} options do not match its genres"
                )
            question = Question(
                raw=question_raw,
                room_id=room_id,
                position=position,
                labels_to_roles=labels_to_roles,
            )
            parsed_questions.append(question)
            questions_by_id[question_id] = question_raw
        positions = [question.position for question in parsed_questions]
        if sorted(positions) != list(range(1, ROOM_SIZE + 1)):
            raise ConfigurationError(
                f"private room {room_id} positions are not 1 through {ROOM_SIZE}"
            )
        rooms[room_id] = tuple(sorted(parsed_questions, key=lambda item: item.position))

    raw_by_id = raw["questions_by_id"]
    if not isinstance(raw_by_id, dict) or raw_by_id != questions_by_id:
        raise ConfigurationError("private questions_by_id does not match the room contents")
    return QuestionBank(
        raw=raw,
        study_version=study_version,
        sha256=sha256,
        rooms=rooms,
    )


def _validate_submission(raw: Any, bank: QuestionBank) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("request body must be a JSON object")
    _require_exact_fields(raw, EXPECTED_PAYLOAD_FIELDS, description="request body")
    _require_integer(
        raw["schema_version"],
        name="schema_version",
        minimum=SCHEMA_VERSION,
        maximum=SCHEMA_VERSION,
    )
    study_version = _require_string(raw["study_version"], name="study_version", maximum=128)
    if study_version != bank.study_version:
        raise ValueError("study_version does not match the active private question bank")
    bank_sha = _require_string(raw["question_bank_sha256"], name="question_bank_sha256", maximum=64)
    if bank_sha != bank.sha256:
        raise ValueError("question_bank_sha256 does not match the active private question bank")
    submission_id = _require_uuid4(raw["submission_id"], name="submission_id")
    participant_id = _require_uuid4(raw["participant_id"], name="participant_id")
    room_id = _require_integer(raw["room_id"], name="room_id")
    room_sequence = _require_integer(raw["room_sequence"], name="room_sequence")
    if room_id not in bank.rooms:
        raise ValueError("room_id does not exist in the active private question bank")
    if raw["consent_version"] != "1":
        raise ValueError("consent_version must be '1'")
    app_build = _require_string(raw["app_build"], name="app_build", maximum=128)
    if not SAFE_VERSION_RE.fullmatch(app_build):
        raise ValueError("app_build contains unsupported characters")
    started_text, started = _require_timestamp(raw["started_at_client"], name="started_at_client")
    completed_text, completed = _require_timestamp(
        raw["completed_at_client"], name="completed_at_client"
    )
    if completed < started:
        raise ValueError("completed_at_client precedes started_at_client")
    if (completed - started).total_seconds() * 1000 > MAX_CLIENT_DURATION_MS:
        raise ValueError("questionnaire duration exceeds the allowed maximum")

    answers_raw = raw["answers"]
    if not isinstance(answers_raw, list) or len(answers_raw) != ROOM_SIZE:
        raise ValueError(f"answers must contain exactly {ROOM_SIZE} items")
    expected_questions = {question.raw["question_id"]: question for question in bank.rooms[room_id]}
    validated_answers: dict[str, dict[str, Any]] = {}
    for answer_index, answer in enumerate(answers_raw, start=1):
        if not isinstance(answer, dict):
            raise ValueError(f"answer {answer_index} must be an object")
        _require_exact_fields(answer, EXPECTED_ANSWER_FIELDS, description=f"answer {answer_index}")
        question_id = _require_string(
            answer["question_id"], name=f"answer {answer_index} question_id", maximum=128
        )
        question = expected_questions.get(question_id)
        if question is None:
            raise ValueError(f"answer {answer_index} question_id is not in room {room_id}")
        if question_id in validated_answers:
            raise ValueError(f"question_id {question_id} is answered more than once")
        position = _require_integer(
            answer["question_position"],
            name=f"answer {answer_index} question_position",
            minimum=1,
            maximum=ROOM_SIZE,
        )
        if position != question.position:
            raise ValueError(f"question_position does not match private bank for {question_id}")
        option_order = answer["option_order"]
        if not isinstance(option_order, list) or len(option_order) != 3:
            raise ValueError(f"option_order for {question_id} must contain exactly three labels")
        if any(not isinstance(label, str) for label in option_order):
            raise ValueError(f"option_order for {question_id} must contain strings")
        if len(set(option_order)) != 3 or set(option_order) != set(question.labels_to_roles):
            raise ValueError(f"option_order for {question_id} is not an exact bank permutation")
        selected_index = _require_integer(
            answer["selected_index"],
            name=f"answer {answer_index} selected_index",
            maximum=2,
        )
        shown_text, shown = _require_timestamp(
            answer["shown_at_client"], name=f"answer {answer_index} shown_at_client"
        )
        answered_text, answered = _require_timestamp(
            answer["answered_at_client"], name=f"answer {answer_index} answered_at_client"
        )
        if shown < started or answered < shown or answered > completed:
            raise ValueError(f"client timestamps for {question_id} are inconsistent")
        elapsed_ms = _require_integer(
            answer["elapsed_ms"],
            name=f"answer {answer_index} elapsed_ms",
            maximum=MAX_CLIENT_DURATION_MS,
        )
        audio_play_count = _require_integer(
            answer["audio_play_count"],
            name=f"answer {answer_index} audio_play_count",
        )
        audio_listened_ms = _require_integer(
            answer["audio_listened_ms"],
            name=f"answer {answer_index} audio_listened_ms",
            maximum=MAX_CLIENT_DURATION_MS,
        )
        validated_answers[question_id] = {
            "question": question,
            "option_order": tuple(option_order),
            "selected_index": selected_index,
            "shown_at_client": shown_text,
            "answered_at_client": answered_text,
            "elapsed_ms": elapsed_ms,
            "audio_play_count": audio_play_count,
            "audio_listened_ms": audio_listened_ms,
        }
    if set(validated_answers) != set(expected_questions):
        raise ValueError("answers do not cover the complete room")
    return {
        "schema_version": SCHEMA_VERSION,
        "study_version": study_version,
        "question_bank_sha256": bank_sha,
        "submission_id": submission_id,
        "participant_id": participant_id,
        "room_id": room_id,
        "room_sequence": room_sequence,
        "consent_version": "1",
        "app_build": app_build,
        "started_at_client": started_text,
        "completed_at_client": completed_text,
        "answers_by_id": validated_answers,
    }


def build_submission_csv(submission: Mapping[str, Any], bank: QuestionBank) -> bytes:
    """Return fixed-column, bank-position-ordered CSV bytes for one submission."""

    output = io.StringIO(newline="")
    writer = csv.DictWriter(
        output,
        fieldnames=CSV_FIELDS,
        extrasaction="raise",
        lineterminator="\n",
    )
    writer.writeheader()
    for question in bank.rooms[submission["room_id"]]:
        answer = submission["answers_by_id"][question.raw["question_id"]]
        option_order = answer["option_order"]
        selected_index = answer["selected_index"]
        selected_label = option_order[selected_index]
        writer.writerow(
            {
                "schema_version": submission["schema_version"],
                "study_version": submission["study_version"],
                "question_bank_sha256": submission["question_bank_sha256"],
                "consent_version": submission["consent_version"],
                "app_build": submission["app_build"],
                "participant_id": submission["participant_id"],
                "submission_id": submission["submission_id"],
                "room_id": submission["room_id"],
                "room_sequence": submission["room_sequence"],
                "started_at_client": submission["started_at_client"],
                "completed_at_client": submission["completed_at_client"],
                "question_position": question.position,
                "question_id": question.raw["question_id"],
                "split": question.raw["split"],
                "isrc": question.raw["isrc"],
                "audio_id": question.raw["audio_id"],
                "published_audio_sha256": question.raw["published_audio_sha256"],
                "annotation_subgenre": question.raw["annotation_subgenre"],
                "option_1_label": option_order[0],
                "option_1_role": question.labels_to_roles[option_order[0]],
                "option_2_label": option_order[1],
                "option_2_role": question.labels_to_roles[option_order[1]],
                "option_3_label": option_order[2],
                "option_3_role": question.labels_to_roles[option_order[2]],
                "selected_index": selected_index,
                "selected_label": selected_label,
                "selected_role": question.labels_to_roles[selected_label],
                "annotation_genre": question.raw["annotation_genre"],
                "model_genre": question.raw["model_genre"],
                "random_genre": question.raw["random_genre"],
                "model_confidence": question.raw["model_confidence"],
                "annotation_probability": question.raw["annotation_probability"],
                "model_margin": question.raw["model_margin"],
                "shown_at_client": answer["shown_at_client"],
                "answered_at_client": answer["answered_at_client"],
                "elapsed_ms": answer["elapsed_ms"],
                "audio_play_count": answer["audio_play_count"],
                "audio_listened_ms": answer["audio_listened_ms"],
            }
        )
    return output.getvalue().encode("utf-8")


def _event_method(event: Mapping[str, Any]) -> str:
    request_context = event.get("requestContext")
    if isinstance(request_context, Mapping):
        http = request_context.get("http")
        if isinstance(http, Mapping) and isinstance(http.get("method"), str):
            return http["method"].upper()
    method = event.get("httpMethod")
    return method.upper() if isinstance(method, str) else ""


def _event_headers(event: Mapping[str, Any]) -> dict[str, str]:
    raw = event.get("headers")
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise RequestError(400, "invalid_headers", "Request headers are malformed.")
    headers: dict[str, str] = {}
    for name, value in raw.items():
        if not isinstance(name, str) or not isinstance(value, str):
            raise RequestError(400, "invalid_headers", "Request headers are malformed.")
        lowered = name.lower()
        if lowered in headers and headers[lowered] != value:
            raise RequestError(400, "invalid_headers", "A request header is duplicated.")
        headers[lowered] = value
    return headers


def _validate_content_type(value: str | None) -> None:
    if value is None:
        raise RequestError(415, "unsupported_media_type", "Content-Type must be application/json.")
    parts = [part.strip() for part in value.split(";")]
    if not parts or parts[0].lower() != "application/json":
        raise RequestError(415, "unsupported_media_type", "Content-Type must be application/json.")
    parameters = parts[1:]
    if any(not parameter for parameter in parameters) or len(parameters) > 1:
        raise RequestError(415, "unsupported_media_type", "Content-Type parameters are invalid.")
    if parameters and parameters[0].replace(" ", "").lower() != "charset=utf-8":
        raise RequestError(415, "unsupported_media_type", "Only UTF-8 JSON is accepted.")


def _decode_body(event: Mapping[str, Any]) -> bytes:
    body = event.get("body")
    if not isinstance(body, str) or not body:
        raise RequestError(400, "invalid_body", "Request body must be non-empty JSON.")
    encoded = event.get("isBase64Encoded", False)
    if not isinstance(encoded, bool):
        raise RequestError(400, "invalid_body", "Request body encoding flag is invalid.")
    if encoded:
        try:
            result = base64.b64decode(body, validate=True)
        except (binascii.Error, ValueError) as error:
            raise RequestError(400, "invalid_body", "Request body is invalid base64.") from error
    else:
        try:
            result = body.encode("utf-8", errors="strict")
        except UnicodeEncodeError as error:
            raise RequestError(400, "invalid_body", "Request body is not valid UTF-8.") from error
    if len(result) > MAX_BODY_BYTES:
        raise RequestError(413, "body_too_large", "Request body is too large.")
    return result


def _error_code(error: BaseException) -> tuple[str, int | None]:
    response = getattr(error, "response", None)
    if not isinstance(response, Mapping):
        return "", None
    error_details = response.get("Error")
    code = error_details.get("Code", "") if isinstance(error_details, Mapping) else ""
    metadata = response.get("ResponseMetadata")
    status = metadata.get("HTTPStatusCode") if isinstance(metadata, Mapping) else None
    return str(code), status if isinstance(status, int) else None


class Collector:
    """Collector with injected environment and S3 client for cloud-free testing."""

    def __init__(self, s3_client: Any, environ: Mapping[str, str]) -> None:
        self.s3 = s3_client
        self.bucket = self._environment_value(environ, "STORAGE_BUCKET")
        self.bank_key = self._environment_value(environ, "QUESTION_BANK_KEY")
        self.allowed_origin = self._environment_value(environ, "ALLOWED_ORIGIN")
        prefix = environ.get("RESPONSES_PREFIX", "responses/").strip("/")
        if not prefix or any(part in {"", ".", ".."} for part in prefix.split("/")):
            raise ConfigurationError("RESPONSES_PREFIX is invalid")
        self.responses_prefix = prefix
        self._bank: QuestionBank | None = None

    @staticmethod
    def _environment_value(environ: Mapping[str, str], name: str) -> str:
        value = environ.get(name)
        if not isinstance(value, str) or not value.strip():
            raise ConfigurationError(f"{name} is required")
        return value.strip()

    def _load_bank(self) -> QuestionBank:
        if self._bank is not None:
            return self._bank
        try:
            response = self.s3.get_object(Bucket=self.bucket, Key=self.bank_key)
        except Exception as error:
            raise ConfigurationError("private question bank could not be read") from error
        length = response.get("ContentLength")
        if isinstance(length, int) and length > MAX_BANK_BYTES:
            raise ConfigurationError("private question bank is too large")
        body = response.get("Body")
        if body is None or not hasattr(body, "read"):
            raise ConfigurationError("private question bank object has no readable body")
        data = body.read(MAX_BANK_BYTES + 1)
        if not isinstance(data, bytes) or len(data) > MAX_BANK_BYTES:
            raise ConfigurationError("private question bank is too large or unreadable")
        try:
            raw = _load_json(data, description="private question bank")
        except ValueError as error:
            raise ConfigurationError(str(error)) from error
        self._bank = _validate_private_bank(raw)
        return self._bank

    @staticmethod
    def _origin_response_headers() -> dict[str, str]:
        # The Function URL owns CORS response headers. Emitting them here as well
        # can produce duplicate Access-Control-* fields after Lambda URL merging.
        return {"vary": "Origin"}

    @staticmethod
    def _json_response(
        status: int,
        payload: Mapping[str, Any],
        *,
        headers: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        response_headers = {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
        }
        if headers:
            response_headers.update(headers)
        return {
            "statusCode": status,
            "headers": response_headers,
            "body": json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
            "isBase64Encoded": False,
        }

    def _store(
        self,
        submission: Mapping[str, Any],
        csv_bytes: bytes,
        payload_sha256: str,
    ) -> tuple[str, bool]:
        key = (
            f"{self.responses_prefix}/{submission['study_version']}/"
            f"{submission['question_bank_sha256']}/room-{submission['room_id']:06d}/"
            f"{submission['submission_id']}.csv"
        )
        try:
            self.s3.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=csv_bytes,
                ContentType="text/csv; charset=utf-8",
                CacheControl="no-store",
                ServerSideEncryption="AES256",
                ChecksumSHA256=base64.b64encode(hashlib.sha256(csv_bytes).digest()).decode("ascii"),
                IfNoneMatch="*",
                Metadata={
                    "payload-sha256": payload_sha256,
                    "submission-id": submission["submission_id"],
                    "participant-id": submission["participant_id"],
                    "room-id": str(submission["room_id"]),
                },
            )
            return key, False
        except Exception as error:
            code, status = _error_code(error)
            if code not in {"PreconditionFailed", "ConditionalRequestConflict"} and status not in {
                409,
                412,
            }:
                raise
        try:
            existing = self.s3.head_object(Bucket=self.bucket, Key=key)
        except Exception as error:
            raise RequestError(
                503,
                "storage_race",
                "Submission storage is temporarily busy; retry with the same submission_id.",
            ) from error
        metadata = existing.get("Metadata", {})
        existing_sha = metadata.get("payload-sha256") if isinstance(metadata, Mapping) else None
        if existing_sha == payload_sha256:
            return key, True
        raise RequestError(
            409,
            "submission_conflict",
            "submission_id already exists with different content.",
        )

    def handle(self, event: Any) -> dict[str, Any]:
        origin_for_response: str | None = None
        try:
            if not isinstance(event, Mapping):
                raise RequestError(400, "invalid_event", "Request is malformed.")
            headers = _event_headers(event)
            origin = headers.get("origin")
            if origin != self.allowed_origin:
                raise RequestError(403, "origin_forbidden", "Request origin is not allowed.")
            origin_for_response = origin
            method = _event_method(event)
            if method == "OPTIONS":
                requested_method = headers.get("access-control-request-method", "").upper()
                requested_headers = {
                    part.strip().lower()
                    for part in headers.get("access-control-request-headers", "").split(",")
                    if part.strip()
                }
                if requested_method != "POST" or not requested_headers.issubset({"content-type"}):
                    raise RequestError(403, "preflight_forbidden", "CORS preflight is not allowed.")
                return {
                    "statusCode": 204,
                    "headers": self._origin_response_headers(),
                    "body": "",
                    "isBase64Encoded": False,
                }
            if method != "POST":
                raise RequestError(405, "method_not_allowed", "Only POST is allowed.")
            if event.get("rawQueryString") not in {None, ""}:
                raise RequestError(400, "query_not_allowed", "Query parameters are not accepted.")
            if "content-encoding" in headers and headers["content-encoding"].lower() != "identity":
                raise RequestError(
                    415, "content_encoding", "Compressed request bodies are not accepted."
                )
            _validate_content_type(headers.get("content-type"))
            body_bytes = _decode_body(event)
            try:
                raw = _load_json(body_bytes, description="request body")
            except ValueError as error:
                raise RequestError(400, "invalid_json", str(error)) from error
            bank = self._load_bank()
            try:
                submission = _validate_submission(raw, bank)
            except ValueError as error:
                raise RequestError(422, "invalid_submission", str(error)) from error
            payload_sha256 = hashlib.sha256(_canonical_json(raw)).hexdigest()
            csv_bytes = build_submission_csv(submission, bank)
            try:
                _key, duplicate = self._store(submission, csv_bytes, payload_sha256)
            except RequestError:
                raise
            except Exception as error:
                LOGGER.exception("Unable to persist listening-test submission")
                raise RequestError(
                    503,
                    "storage_unavailable",
                    "Submission storage is temporarily unavailable; retry the same submission.",
                ) from error
            return self._json_response(
                200 if duplicate else 201,
                {
                    "ok": True,
                    "submission_id": submission["submission_id"],
                    "status": "already_stored" if duplicate else "stored",
                },
                headers=self._origin_response_headers(),
            )
        except RequestError as error:
            response_headers = self._origin_response_headers() if origin_for_response else None
            return self._json_response(
                error.status,
                {"ok": False, "error": error.code, "message": error.message},
                headers=response_headers,
            )


_COLLECTOR: Collector | None = None


def _default_s3_client() -> Any:
    import boto3

    return boto3.client("s3")


def lambda_handler(event: Any, context: Any) -> dict[str, Any]:
    """AWS Lambda entry point."""

    del context
    global _COLLECTOR
    try:
        if _COLLECTOR is None:
            _COLLECTOR = Collector(_default_s3_client(), os.environ)
        return _COLLECTOR.handle(event)
    except ConfigurationError:
        # Configuration details stay in CloudWatch rather than leaking to the browser.
        LOGGER.exception("Listening-test collector configuration is unavailable")
        response_headers = None
        if _COLLECTOR is not None and isinstance(event, Mapping):
            try:
                origin = _event_headers(event).get("origin")
            except RequestError:
                origin = None
            if origin == _COLLECTOR.allowed_origin:
                response_headers = _COLLECTOR._origin_response_headers()
        return Collector._json_response(
            503,
            {
                "ok": False,
                "error": "collector_unavailable",
                "message": "The response collector is temporarily unavailable.",
            },
            headers=response_headers,
        )
