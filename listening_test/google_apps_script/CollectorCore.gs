/*
 * Pure validation and row-building logic for the Google Apps Script collector.
 *
 * Keep this file free of Apps Script services so the exact production logic can
 * be exercised locally.  Code.gs owns Drive, Sheets, locking, and HTTP glue.
 */
var ListeningTestCollectorCore = (function () {
  "use strict";

  var SCHEMA_VERSION = 1;
  var ROOM_SIZE = 10;
  var MAX_BODY_BYTES = 64 * 1024;
  var MAX_BANK_BYTES = 4 * 1024 * 1024;
  var MAX_CLIENT_DURATION_MS = 31 * 24 * 60 * 60 * 1000;
  var MAX_COUNTER = 1000000;
  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  var SAFE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
  var SHA256_RE = /^[0-9a-f]{64}$/;
  var HTTPS_ORIGIN_RE = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::(?:[1-9]\d{0,4}))?$/;
  var TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

  var PAYLOAD_FIELDS = [
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
  ];

  var ANSWER_FIELDS = [
    "question_id",
    "question_position",
    "option_order",
    "selected_index",
    "shown_at_client",
    "answered_at_client",
    "elapsed_ms",
    "audio_play_count",
    "audio_listened_ms",
  ];

  var QUESTION_FIELDS = [
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
  ];

  var RESPONSE_HEADERS = [
    "collector_received_at_utc",
    "payload_sha256",
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
  ];

  function fail(message) {
    throw new Error(message);
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function sameStringSet(left, right) {
    if (left.length !== right.length) return false;
    var expected = Object.create(null);
    right.forEach(function (value) {
      expected[value] = true;
    });
    return left.every(function (value) {
      return expected[value] === true;
    });
  }

  function requireExactFields(value, fields, description) {
    if (!isObject(value)) fail(description + " must be an object");
    var actual = Object.keys(value).sort();
    var expected = fields.slice().sort();
    if (actual.length !== expected.length || actual.some(function (key, index) {
      return key !== expected[index];
    })) {
      var missing = expected.filter(function (key) {
        return !Object.prototype.hasOwnProperty.call(value, key);
      });
      var extra = actual.filter(function (key) {
        return expected.indexOf(key) === -1;
      });
      var detail = [];
      if (missing.length) detail.push("missing " + missing.join(", "));
      if (extra.length) detail.push("unexpected " + extra.join(", "));
      fail(description + " has invalid fields (" + detail.join("; ") + ")");
    }
  }

  function requireString(value, name, maximum) {
    if (typeof value !== "string" || !value || value.trim() !== value) {
      fail(name + " must be a non-empty, trimmed string");
    }
    if (value.length > maximum || /[\u0000-\u001f]/.test(value)) {
      fail(name + " is too long or contains control characters");
    }
    return value;
  }

  function requireSheetSafeString(value, name, maximum) {
    var text = requireString(value, name, maximum);
    if (/^[=+\-@]/.test(text)) {
      fail(name + " starts with a spreadsheet formula prefix");
    }
    return text;
  }

  function requireInteger(value, name, minimum, maximum) {
    if (!Number.isInteger(value)) fail(name + " must be an integer");
    if (value < minimum || value > maximum) {
      fail(name + " must be between " + minimum + " and " + maximum);
    }
    return value;
  }

  function requireFiniteNumber(value, name) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(name + " must be a finite number");
    }
    return value;
  }

  function requireUuid4(value, name) {
    var text = requireString(value, name, 36);
    if (!UUID_V4_RE.test(text)) {
      fail(name + " must be a lowercase RFC 4122 version-4 UUID");
    }
    return text;
  }

  function daysInMonth(year, month) {
    if (month === 2) {
      var leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      return leap ? 29 : 28;
    }
    return [4, 6, 9, 11].indexOf(month) !== -1 ? 30 : 31;
  }

  function requireTimestamp(value, name) {
    var text = requireString(value, name, 35);
    var match = TIMESTAMP_RE.exec(text);
    if (!match) fail(name + " must be an RFC 3339 timestamp");
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var hour = Number(match[4]);
    var minute = Number(match[5]);
    var second = Number(match[6]);
    if (
      year < 1 || month < 1 || month > 12 || day < 1 ||
      day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59
    ) {
      fail(name + " must be a real RFC 3339 timestamp");
    }
    if (match[8] !== "Z") {
      var offsetHour = Number(match[8].slice(1, 3));
      var offsetMinute = Number(match[8].slice(4, 6));
      if (offsetHour > 23 || offsetMinute > 59) {
        fail(name + " has an invalid UTC offset");
      }
    }
    var milliseconds = Date.parse(text);
    if (!Number.isFinite(milliseconds)) fail(name + " must be an RFC 3339 timestamp");
    return { text: text, milliseconds: milliseconds };
  }

  /* JSON.parse accepts duplicate object keys.  This small strict parser does not. */
  function parseStrictJson(text) {
    if (typeof text !== "string" || !text) fail("JSON input must be a non-empty string");
    var index = 0;
    var depth = 0;

    function skipSpace() {
      while (index < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[index])) index += 1;
    }

    function parseString() {
      var start = index;
      index += 1;
      while (index < text.length) {
        var code = text.charCodeAt(index);
        if (code === 34) {
          index += 1;
          return JSON.parse(text.slice(start, index));
        }
        if (code < 32) fail("JSON string contains an unescaped control character");
        if (code === 92) {
          index += 1;
          if (index >= text.length || '"\\/bfnrtu'.indexOf(text[index]) === -1) {
            fail("JSON string contains an invalid escape");
          }
          if (text[index] === "u") {
            if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) {
              fail("JSON string contains an invalid Unicode escape");
            }
            index += 4;
          }
        }
        index += 1;
      }
      fail("JSON string is not terminated");
    }

    function parseNumber() {
      var match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
      if (!match) fail("JSON number is invalid");
      index += match[0].length;
      var number = Number(match[0]);
      if (!Number.isFinite(number)) fail("JSON number must be finite");
      return number;
    }

    function parseArray() {
      depth += 1;
      if (depth > 64) fail("JSON nesting is too deep");
      index += 1;
      var result = [];
      skipSpace();
      if (text[index] === "]") {
        index += 1;
        depth -= 1;
        return result;
      }
      while (index < text.length) {
        result.push(parseValue());
        skipSpace();
        if (text[index] === "]") {
          index += 1;
          depth -= 1;
          return result;
        }
        if (text[index] !== ",") fail("JSON array is missing a comma");
        index += 1;
        skipSpace();
      }
      fail("JSON array is not terminated");
    }

    function parseObject() {
      depth += 1;
      if (depth > 64) fail("JSON nesting is too deep");
      index += 1;
      var result = Object.create(null);
      skipSpace();
      if (text[index] === "}") {
        index += 1;
        depth -= 1;
        return result;
      }
      while (index < text.length) {
        if (text[index] !== '"') fail("JSON object key must be a string");
        var key = parseString();
        if (Object.prototype.hasOwnProperty.call(result, key)) {
          fail("JSON object contains duplicate key: " + key);
        }
        skipSpace();
        if (text[index] !== ":") fail("JSON object key is missing a colon");
        index += 1;
        skipSpace();
        result[key] = parseValue();
        skipSpace();
        if (text[index] === "}") {
          index += 1;
          depth -= 1;
          return result;
        }
        if (text[index] !== ",") fail("JSON object is missing a comma");
        index += 1;
        skipSpace();
      }
      fail("JSON object is not terminated");
    }

    function parseValue() {
      skipSpace();
      var character = text[index];
      if (character === '"') return parseString();
      if (character === "{") return parseObject();
      if (character === "[") return parseArray();
      if (text.slice(index, index + 4) === "true") {
        index += 4;
        return true;
      }
      if (text.slice(index, index + 5) === "false") {
        index += 5;
        return false;
      }
      if (text.slice(index, index + 4) === "null") {
        index += 4;
        return null;
      }
      if (character === "-" || /[0-9]/.test(character || "")) return parseNumber();
      fail("JSON value is invalid at character " + index);
    }

    var parsed = parseValue();
    skipSpace();
    if (index !== text.length) fail("JSON input contains trailing data");
    return parsed;
  }

  function canonicalJson(value) {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("Cannot canonicalize a non-finite number");
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return "[" + value.map(canonicalJson).join(",") + "]";
    }
    if (isObject(value)) {
      return "{" + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ":" + canonicalJson(value[key]);
      }).join(",") + "}";
    }
    fail("Cannot canonicalize unsupported JSON value");
  }

  function validatePrivateBank(raw, verifyBankIntegrity) {
    requireExactFields(raw, [
      "schema_version",
      "study_version",
      "question_bank_sha256",
      "room_size",
      "room_count",
      "rooms",
      "questions_by_id",
    ], "private question bank");
    requireInteger(raw.schema_version, "private schema_version", SCHEMA_VERSION, SCHEMA_VERSION);
    var studyVersion = requireString(raw.study_version, "private study_version", 128);
    if (!SAFE_VERSION_RE.test(studyVersion)) fail("private study_version contains unsafe characters");
    if (typeof raw.question_bank_sha256 !== "string" || !SHA256_RE.test(raw.question_bank_sha256)) {
      fail("private question_bank_sha256 is invalid");
    }
    requireInteger(raw.room_size, "private room_size", ROOM_SIZE, ROOM_SIZE);
    requireInteger(raw.room_count, "private room_count", 1, MAX_COUNTER);
    if (!Array.isArray(raw.rooms) || !raw.rooms.length || raw.rooms.length !== raw.room_count) {
      fail("private room_count does not match a non-empty rooms array");
    }
    if (typeof verifyBankIntegrity !== "function") {
      fail("a private-bank integrity verifier is required");
    }
    var bankCore = {
      schema_version: raw.schema_version,
      study_version: raw.study_version,
      room_size: raw.room_size,
      room_count: raw.room_count,
      rooms: raw.rooms,
    };
    if (verifyBankIntegrity(bankCore, raw.question_bank_sha256) !== true) {
      fail("private question-bank digest does not match its contents");
    }

    var rooms = Object.create(null);
    var questionsById = Object.create(null);
    raw.rooms.forEach(function (roomRaw) {
      requireExactFields(roomRaw, ["room_id", "questions"], "private room");
      var roomId = requireInteger(roomRaw.room_id, "private room_id", 0, MAX_COUNTER);
      if (Object.prototype.hasOwnProperty.call(rooms, String(roomId))) {
        fail("private room_id " + roomId + " is duplicated");
      }
      if (!Array.isArray(roomRaw.questions) || roomRaw.questions.length !== ROOM_SIZE) {
        fail("private room " + roomId + " must contain exactly " + ROOM_SIZE + " questions");
      }
      var parsedQuestions = roomRaw.questions.map(function (questionRaw) {
        requireExactFields(questionRaw, QUESTION_FIELDS, "private question");
        var questionId = requireSheetSafeString(
          questionRaw.question_id,
          "private question_id",
          128
        );
        var questionRoom = requireInteger(questionRaw.room_id, questionId + " room_id", 0, MAX_COUNTER);
        var position = requireInteger(questionRaw.room_position, questionId + " room_position", 1, ROOM_SIZE);
        if (questionRoom !== roomId) fail("private question " + questionId + " is in the wrong room");
        if (Object.prototype.hasOwnProperty.call(questionsById, questionId)) {
          fail("private question_id " + questionId + " is duplicated");
        }
        if (["valid", "test"].indexOf(questionRaw.split) === -1) {
          fail("private question " + questionId + " has an invalid split");
        }
        [
          "isrc", "audio_id", "annotation_genre", "annotation_subgenre",
          "model_genre", "random_genre",
        ].forEach(function (field) {
          requireSheetSafeString(questionRaw[field], questionId + " " + field, 512);
        });
        if (
          typeof questionRaw.published_audio_sha256 !== "string" ||
          !SHA256_RE.test(questionRaw.published_audio_sha256)
        ) {
          fail("private question " + questionId + " published_audio_sha256 is invalid");
        }
        ["model_confidence", "annotation_probability", "model_margin"].forEach(function (field) {
          var number = requireFiniteNumber(questionRaw[field], questionId + " " + field);
          if (number < 0 || number > 1) fail("private question " + questionId + " " + field + " is out of range");
        });
        if (!Array.isArray(questionRaw.options) || questionRaw.options.length !== 3) {
          fail("private question " + questionId + " must have three options");
        }
        var labelsToRoles = Object.create(null);
        var seenRoles = Object.create(null);
        questionRaw.options.forEach(function (option) {
          requireExactFields(option, ["role", "label"], "private question " + questionId + " option");
          var label = requireSheetSafeString(option.label, questionId + " option label", 512);
          if (["model", "annotation", "random"].indexOf(option.role) === -1) {
            fail("private question " + questionId + " role is invalid");
          }
          if (
            Object.prototype.hasOwnProperty.call(labelsToRoles, label) ||
            Object.prototype.hasOwnProperty.call(seenRoles, option.role)
          ) {
            fail("private question " + questionId + " options are duplicated");
          }
          labelsToRoles[label] = option.role;
          seenRoles[option.role] = true;
        });
        var expectedRoleLabels = {
          model: questionRaw.model_genre,
          annotation: questionRaw.annotation_genre,
          random: questionRaw.random_genre,
        };
        Object.keys(labelsToRoles).forEach(function (label) {
          if (expectedRoleLabels[labelsToRoles[label]] !== label) {
            fail("private question " + questionId + " options do not match its genres");
          }
        });
        var question = {
          raw: questionRaw,
          roomId: roomId,
          position: position,
          labelsToRoles: labelsToRoles,
        };
        questionsById[questionId] = questionRaw;
        return question;
      });
      parsedQuestions.sort(function (left, right) {
        return left.position - right.position;
      });
      parsedQuestions.forEach(function (question, index) {
        if (question.position !== index + 1) {
          fail("private room " + roomId + " positions are not 1 through " + ROOM_SIZE);
        }
      });
      rooms[String(roomId)] = parsedQuestions;
    });
    if (!isObject(raw.questions_by_id) || canonicalJson(raw.questions_by_id) !== canonicalJson(questionsById)) {
      fail("private questions_by_id does not match the room contents");
    }
    return {
      raw: raw,
      studyVersion: studyVersion,
      sha256: raw.question_bank_sha256,
      rooms: rooms,
    };
  }

  function validateSubmission(raw, bank) {
    requireExactFields(raw, PAYLOAD_FIELDS, "request body");
    requireInteger(raw.schema_version, "schema_version", SCHEMA_VERSION, SCHEMA_VERSION);
    var studyVersion = requireString(raw.study_version, "study_version", 128);
    if (studyVersion !== bank.studyVersion) fail("study_version does not match the active private question bank");
    var bankSha = requireString(raw.question_bank_sha256, "question_bank_sha256", 64);
    if (bankSha !== bank.sha256) fail("question_bank_sha256 does not match the active private question bank");
    var submissionId = requireUuid4(raw.submission_id, "submission_id");
    var participantId = requireUuid4(raw.participant_id, "participant_id");
    var roomId = requireInteger(raw.room_id, "room_id", 0, MAX_COUNTER);
    var roomSequence = requireInteger(raw.room_sequence, "room_sequence", 0, MAX_COUNTER);
    var room = bank.rooms[String(roomId)];
    if (!room) fail("room_id does not exist in the active private question bank");
    if (raw.consent_version !== "1") fail("consent_version must be '1'");
    var appBuild = requireString(raw.app_build, "app_build", 128);
    if (!SAFE_VERSION_RE.test(appBuild)) fail("app_build contains unsupported characters");
    var started = requireTimestamp(raw.started_at_client, "started_at_client");
    var completed = requireTimestamp(raw.completed_at_client, "completed_at_client");
    if (completed.milliseconds < started.milliseconds) {
      fail("completed_at_client precedes started_at_client");
    }
    if (completed.milliseconds - started.milliseconds > MAX_CLIENT_DURATION_MS) {
      fail("questionnaire duration exceeds the allowed maximum");
    }
    if (!Array.isArray(raw.answers) || raw.answers.length !== ROOM_SIZE) {
      fail("answers must contain exactly " + ROOM_SIZE + " items");
    }
    var expectedQuestions = Object.create(null);
    room.forEach(function (question) {
      expectedQuestions[question.raw.question_id] = question;
    });
    var answersById = Object.create(null);
    raw.answers.forEach(function (answer, answerIndex) {
      var number = answerIndex + 1;
      requireExactFields(answer, ANSWER_FIELDS, "answer " + number);
      var questionId = requireString(answer.question_id, "answer " + number + " question_id", 128);
      var question = expectedQuestions[questionId];
      if (!question) fail("answer " + number + " question_id is not in room " + roomId);
      if (Object.prototype.hasOwnProperty.call(answersById, questionId)) {
        fail("question_id " + questionId + " is answered more than once");
      }
      var position = requireInteger(answer.question_position, "answer " + number + " question_position", 1, ROOM_SIZE);
      if (position !== question.position) fail("question_position does not match private bank for " + questionId);
      if (
        !Array.isArray(answer.option_order) || answer.option_order.length !== 3 ||
        answer.option_order.some(function (label) { return typeof label !== "string"; }) ||
        new Set(answer.option_order).size !== 3 ||
        !sameStringSet(answer.option_order, Object.keys(question.labelsToRoles))
      ) {
        fail("option_order for " + questionId + " is not an exact bank permutation");
      }
      var selectedIndex = requireInteger(answer.selected_index, "answer " + number + " selected_index", 0, 2);
      var shown = requireTimestamp(answer.shown_at_client, "answer " + number + " shown_at_client");
      var answered = requireTimestamp(answer.answered_at_client, "answer " + number + " answered_at_client");
      if (
        shown.milliseconds < started.milliseconds || answered.milliseconds < shown.milliseconds ||
        answered.milliseconds > completed.milliseconds
      ) {
        fail("client timestamps for " + questionId + " are inconsistent");
      }
      answersById[questionId] = {
        question: question,
        optionOrder: answer.option_order.slice(),
        selectedIndex: selectedIndex,
        shownAtClient: shown.text,
        answeredAtClient: answered.text,
        elapsedMs: requireInteger(answer.elapsed_ms, "answer " + number + " elapsed_ms", 0, MAX_CLIENT_DURATION_MS),
        audioPlayCount: requireInteger(answer.audio_play_count, "answer " + number + " audio_play_count", 0, MAX_COUNTER),
        audioListenedMs: requireInteger(answer.audio_listened_ms, "answer " + number + " audio_listened_ms", 0, MAX_CLIENT_DURATION_MS),
      };
    });
    if (!sameStringSet(Object.keys(answersById), Object.keys(expectedQuestions))) {
      fail("answers do not cover the complete room");
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      studyVersion: studyVersion,
      questionBankSha256: bankSha,
      submissionId: submissionId,
      participantId: participantId,
      roomId: roomId,
      roomSequence: roomSequence,
      consentVersion: "1",
      appBuild: appBuild,
      startedAtClient: started.text,
      completedAtClient: completed.text,
      answersById: answersById,
    };
  }

  function buildResponseRows(submission, bank, receivedAt, payloadSha256) {
    return bank.rooms[String(submission.roomId)].map(function (question) {
      var answer = submission.answersById[question.raw.question_id];
      var order = answer.optionOrder;
      var selectedLabel = order[answer.selectedIndex];
      return {
        collector_received_at_utc: receivedAt,
        payload_sha256: payloadSha256,
        schema_version: submission.schemaVersion,
        study_version: submission.studyVersion,
        question_bank_sha256: submission.questionBankSha256,
        consent_version: submission.consentVersion,
        app_build: submission.appBuild,
        participant_id: submission.participantId,
        submission_id: submission.submissionId,
        room_id: submission.roomId,
        room_sequence: submission.roomSequence,
        started_at_client: submission.startedAtClient,
        completed_at_client: submission.completedAtClient,
        question_position: question.position,
        question_id: question.raw.question_id,
        split: question.raw.split,
        isrc: question.raw.isrc,
        audio_id: question.raw.audio_id,
        published_audio_sha256: question.raw.published_audio_sha256,
        annotation_subgenre: question.raw.annotation_subgenre,
        option_1_label: order[0],
        option_1_role: question.labelsToRoles[order[0]],
        option_2_label: order[1],
        option_2_role: question.labelsToRoles[order[1]],
        option_3_label: order[2],
        option_3_role: question.labelsToRoles[order[2]],
        selected_index: answer.selectedIndex,
        selected_label: selectedLabel,
        selected_role: question.labelsToRoles[selectedLabel],
        annotation_genre: question.raw.annotation_genre,
        model_genre: question.raw.model_genre,
        random_genre: question.raw.random_genre,
        model_confidence: question.raw.model_confidence,
        annotation_probability: question.raw.annotation_probability,
        model_margin: question.raw.model_margin,
        shown_at_client: answer.shownAtClient,
        answered_at_client: answer.answeredAtClient,
        elapsed_ms: answer.elapsedMs,
        audio_play_count: answer.audioPlayCount,
        audio_listened_ms: answer.audioListenedMs,
      };
    });
  }

  function rowsToMatrix(rows, headers) {
    return rows.map(function (row) {
      return headers.map(function (header) {
        if (!Object.prototype.hasOwnProperty.call(row, header)) {
          fail("response row is missing " + header);
        }
        return row[header];
      });
    });
  }

  function idempotencyAction(record, payloadSha256) {
    if (!record) return "new";
    if (String(record.payload_sha256) !== payloadSha256) {
      fail("submission_id already exists with different content");
    }
    if (String(record.status) === "complete") return "duplicate";
    if (String(record.status) === "pending") return "resume";
    fail("submission registry contains an invalid status");
  }

  function existingRowsAreRecoverable(existing, expectedMatrix, headers) {
    if (!Array.isArray(existing) || existing.length !== expectedMatrix.length) return false;
    var submissionIndex = headers.indexOf("submission_id");
    var payloadIndex = headers.indexOf("payload_sha256");
    var questionIndex = headers.indexOf("question_id");
    var positionIndex = headers.indexOf("question_position");
    if ([submissionIndex, payloadIndex, questionIndex, positionIndex].some(function (index) {
      return index < 0;
    })) return false;
    return existing.every(function (row, index) {
      if (!Array.isArray(row) || row.length !== headers.length) return false;
      var blank = row.every(function (value) { return value === ""; });
      if (blank) return true;
      if (
        !sheetCellEquals(row[submissionIndex], expectedMatrix[index][submissionIndex]) ||
        !sheetCellEquals(row[payloadIndex], expectedMatrix[index][payloadIndex]) ||
        !sheetCellEquals(row[questionIndex], expectedMatrix[index][questionIndex]) ||
        !sheetCellEquals(row[positionIndex], expectedMatrix[index][positionIndex])
      ) return false;
      return row.every(function (value, columnIndex) {
        return sheetCellEquals(value, expectedMatrix[index][columnIndex]);
      });
    });
  }

  function sheetCellEquals(value, expected) {
    if (Object.prototype.toString.call(value) === "[object Date]") {
      return Number.isFinite(value.getTime()) && value.toISOString() === expected;
    }
    return value === expected;
  }

  function normalizeSheetTimestamp(value) {
    var text;
    if (Object.prototype.toString.call(value) === "[object Date]") {
      if (!Number.isFinite(value.getTime())) fail("Sheet timestamp is invalid");
      text = value.toISOString();
    } else {
      text = String(value || "");
    }
    if (!text) return "";
    return requireTimestamp(text, "Sheet timestamp").text;
  }

  function stabilizeResponseRows(rows, receivedAt) {
    var timestamp = normalizeSheetTimestamp(receivedAt);
    if (!timestamp) fail("submission registry has no receipt timestamp");
    return rows.map(function (row) {
      var copy = Object.assign({}, row);
      copy.collector_received_at_utc = timestamp;
      return copy;
    });
  }

  function requiredGridGrowth(currentSize, requiredSize) {
    if (!Number.isInteger(currentSize) || currentSize < 1) {
      fail("current grid size must be a positive integer");
    }
    if (!Number.isInteger(requiredSize) || requiredSize < 1) {
      fail("required grid size must be a positive integer");
    }
    return Math.max(0, requiredSize - currentSize);
  }

  function buildAcknowledgementHtml(payload, targetOrigin) {
    if (typeof targetOrigin !== "string" || !HTTPS_ORIGIN_RE.test(targetOrigin)) {
      fail("ACK_TARGET_ORIGIN must be an exact HTTPS origin without a path");
    }
    function safeScriptJson(value) {
      return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, function (character) {
        return "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0");
      });
    }
    return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"robots\" content=\"noindex\"></head>" +
      "<body><script>window.top.postMessage(" + safeScriptJson(payload) + "," +
      safeScriptJson(targetOrigin) + ");<\/script></body></html>";
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    ROOM_SIZE: ROOM_SIZE,
    MAX_BODY_BYTES: MAX_BODY_BYTES,
    MAX_BANK_BYTES: MAX_BANK_BYTES,
    SHA256_RE: SHA256_RE,
    RESPONSE_HEADERS: RESPONSE_HEADERS,
    canonicalJson: canonicalJson,
    parseStrictJson: parseStrictJson,
    validatePrivateBank: validatePrivateBank,
    validateSubmission: validateSubmission,
    buildResponseRows: buildResponseRows,
    rowsToMatrix: rowsToMatrix,
    idempotencyAction: idempotencyAction,
    existingRowsAreRecoverable: existingRowsAreRecoverable,
    normalizeSheetTimestamp: normalizeSheetTimestamp,
    stabilizeResponseRows: stabilizeResponseRows,
    requiredGridGrowth: requiredGridGrowth,
    buildAcknowledgementHtml: buildAcknowledgementHtml,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ListeningTestCollectorCore;
}
