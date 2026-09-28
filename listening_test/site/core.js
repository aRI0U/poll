(function attachListeningTestCore(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ListeningTestCore = api;
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function createCore() {
    "use strict";

    function asNonEmptyString(value, fieldName) {
      const text = String(value == null ? "" : value).trim();
      if (!text) {
        throw new Error(`${fieldName} must be a non-empty string.`);
      }
      return text;
    }

    function asPositiveInteger(value, fieldName) {
      const number = Number(value);
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`${fieldName} must be a positive integer.`);
      }
      return number;
    }

    function normalizeChoice(choice, questionId, index) {
      return asNonEmptyString(
        choice,
        `Question ${questionId}: choice ${index + 1}`,
      );
    }

    function normalizeQuestion(question, index) {
      if (
        !question || typeof question !== "object" || Array.isArray(question)
      ) {
        throw new Error(`Question ${index + 1} must be an object.`);
      }

      const questionId = asNonEmptyString(
        question.question_id,
        `Question ${index + 1}: question_id`,
      );
      const choices = Array.isArray(question.choices)
        ? question.choices.map((choice, choiceIndex) =>
          normalizeChoice(choice, questionId, choiceIndex)
        )
        : [];

      if (choices.length !== 3) {
        throw new Error(
          `Question ${questionId}: exactly three choices are required.`,
        );
      }
      if (new Set(choices).size !== choices.length) {
        throw new Error(
          `Question ${questionId}: choice labels must be unique.`,
        );
      }

      return {
        ...question,
        question_id: questionId,
        audio: asNonEmptyString(
          question.audio,
          `Question ${questionId}: audio`,
        ),
        choices,
        _input_index: index,
      };
    }

    function normalizeDataset(raw, defaults) {
      const fallback = defaults || {};
      const input = raw;
      if (!input || typeof input !== "object") {
        throw new Error("The questions file must contain an object.");
      }

      if (!Array.isArray(input.rooms)) {
        throw new Error("The questions file must contain a rooms array.");
      }
      const roomSize = asPositiveInteger(
        input.room_size == null ? fallback.roomSize || 10 : input.room_size,
        "room_size",
      );
      const expectedRoomSize = asPositiveInteger(
        fallback.roomSize || 10,
        "configured roomSize",
      );
      if (roomSize !== expectedRoomSize) {
        throw new Error(
          `room_size must be exactly ${expectedRoomSize}; received ${roomSize}.`,
        );
      }
      const questionIds = new Set();
      const roomIds = new Set();
      const rooms = input.rooms.map((rawRoom, roomIndex) => {
        if (!rawRoom || typeof rawRoom !== "object" || Array.isArray(rawRoom)) {
          throw new Error(`Room ${roomIndex + 1} must be an object.`);
        }
        const roomId = Number(rawRoom.room_id);
        if (!Number.isInteger(roomId) || roomId < 0) {
          throw new Error(
            `Room ${roomIndex + 1}: room_id must be a non-negative integer.`,
          );
        }
        if (roomIds.has(roomId)) {
          throw new Error(`Duplicate room_id: ${roomId}.`);
        }
        roomIds.add(roomId);
        const rawQuestions = Array.isArray(rawRoom.questions)
          ? rawRoom.questions
          : [];
        const questions = rawQuestions.map(normalizeQuestion);
        if (questions.length !== roomSize) {
          throw new Error(
            `Room ${roomId} contains ${questions.length} questions; exactly ${roomSize} are required.`,
          );
        }
        questions.forEach((question) => {
          if (questionIds.has(question.question_id)) {
            throw new Error(`Duplicate question_id: ${question.question_id}.`);
          }
          questionIds.add(question.question_id);
        });
        return { room_id: roomId, questions };
      });

      const declaredRoomCount = asPositiveInteger(
        input.room_count == null ? rooms.length : input.room_count,
        "room_count",
      );
      if (declaredRoomCount !== rooms.length) {
        throw new Error(
          `room_count is ${declaredRoomCount}, but ${rooms.length} rooms were provided.`,
        );
      }

      const questionBankSha256 = asNonEmptyString(
        input.question_bank_sha256,
        "question_bank_sha256",
      ).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(questionBankSha256)) {
        throw new Error(
          "question_bank_sha256 must be a 64-character hexadecimal SHA-256.",
        );
      }

      const schemaVersion = Number(input.schema_version || 1);
      if (schemaVersion !== 1) {
        throw new Error(
          `Unsupported question-bank schema_version: ${schemaVersion}.`,
        );
      }

      return {
        ...input,
        schema_version: schemaVersion,
        study_version: asNonEmptyString(
          input.study_version || fallback.studyVersion ||
            "genre-listening-test-v1",
          "study_version",
        ),
        question_bank_sha256: questionBankSha256,
        room_size: roomSize,
        room_count: declaredRoomCount,
        rooms,
      };
    }

    function buildRooms(dataset) {
      return Array.isArray(dataset.rooms) ? dataset.rooms : [];
    }

    function fnv1a(text) {
      let hash = 0x811c9dc5;
      const string = String(text);
      for (let index = 0; index < string.length; index += 1) {
        hash ^= string.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }
      return hash >>> 0;
    }

    function mulberry32(seed) {
      let state = seed >>> 0;
      return function nextRandom() {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    }

    function stableShuffle(items, seedText) {
      const result = Array.from(items);
      const random = mulberry32(fnv1a(seedText));
      for (let index = result.length - 1; index > 0; index -= 1) {
        const selected = Math.floor(random() * (index + 1));
        [result[index], result[selected]] = [result[selected], result[index]];
      }
      return result;
    }

    function shuffleQuestionChoices(question, sessionId) {
      return stableShuffle(
        question.choices,
        `${sessionId}|${question.question_id}|option-order-v1`,
      );
    }

    function randomIndex(length, cryptoObject) {
      if (!Number.isInteger(length) || length <= 0) {
        throw new Error("randomIndex length must be a positive integer.");
      }
      const cryptoApi = cryptoObject ||
        (typeof crypto !== "undefined" ? crypto : null);
      if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
        return Math.floor(Math.random() * length);
      }

      const maximum = 0x100000000;
      const limit = maximum - (maximum % length);
      const values = new Uint32Array(1);
      do {
        cryptoApi.getRandomValues(values);
      } while (values[0] >= limit);
      return values[0] % length;
    }

    function makeUuid(cryptoObject) {
      const cryptoApi = cryptoObject ||
        (typeof crypto !== "undefined" ? crypto : null);
      if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
        return cryptoApi.randomUUID();
      }

      const bytes = new Uint8Array(16);
      if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
        cryptoApi.getRandomValues(bytes);
      } else {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = Math.floor(Math.random() * 256);
        }
      }
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((value) =>
        value.toString(16).padStart(2, "0")
      );
      return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${
        hex
          .slice(6, 8)
          .join("")
      }-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
    }

    function nextRoomId(roomIds, currentRoomId) {
      if (!Array.isArray(roomIds) || roomIds.length === 0) {
        throw new Error("At least one room is required.");
      }
      const currentIndex = roomIds.map(String).indexOf(String(currentRoomId));
      if (currentIndex < 0) {
        throw new Error(`Unknown room: ${currentRoomId}.`);
      }
      return roomIds[(currentIndex + 1) % roomIds.length];
    }

    function datasetFingerprint(dataset) {
      if (dataset.question_bank_sha256) return dataset.question_bank_sha256;
      const parts = [dataset.study_version, dataset.room_size];
      dataset.rooms.forEach((room) => {
        room.questions.forEach((question) => {
          parts.push(
            room.room_id,
            question.question_id,
            question.audio,
            ...question.choices,
          );
        });
      });
      return fnv1a(parts.join("\u241f")).toString(16).padStart(8, "0");
    }

    function roomSequenceStorageKey(storageNamespace, dataset, fingerprint) {
      const namespace = asNonEmptyString(
        storageNamespace || "genre-listening-test-v1",
        "storageNamespace",
      );
      if (!dataset || typeof dataset !== "object") {
        throw new Error(
          "A validated dataset is required for sequence storage.",
        );
      }
      const studyVersion = asNonEmptyString(
        dataset.study_version || "unknown-study",
        "study_version",
      );
      const bankIdentity = asNonEmptyString(
        fingerprint || datasetFingerprint(dataset),
        "question-bank fingerprint",
      );
      return `${namespace}:next-room-sequence:${
        encodeURIComponent(studyVersion)
      }:${encodeURIComponent(bankIdentity)}`;
    }

    function nonNegativeElapsedMs(start, end) {
      const value = Date.parse(end) - Date.parse(start);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    function buildCollectorPayload(state, room, settings) {
      const options = settings || {};
      if (!state || !room || !Array.isArray(room.questions)) {
        throw new Error("A complete session state and room are required.");
      }
      const answers = room.questions.map((question, index) => {
        const response = state.responses?.[question.question_id];
        if (!response || !Array.isArray(response.choice_order)) {
          throw new Error(
            `Missing response state for ${question.question_id}.`,
          );
        }
        if (
          !Number.isInteger(response.selected_index) ||
          response.selected_index < 0 || response.selected_index > 2
        ) {
          throw new Error(
            `Question ${question.question_id} has no valid selected_index.`,
          );
        }
        return {
          question_id: question.question_id,
          question_position: index + 1,
          option_order: [...response.choice_order],
          selected_index: response.selected_index,
          shown_at_client: response.first_shown_at,
          answered_at_client: response.last_selected_at,
          elapsed_ms: nonNegativeElapsedMs(
            response.first_shown_at,
            response.last_selected_at,
          ),
          audio_play_count: Math.max(
            0,
            Math.floor(Number(response.audio?.play_count) || 0),
          ),
          audio_listened_ms: Math.max(
            0,
            Math.round(
              (Number(response.audio?.listened_content_seconds) || 0) * 1000,
            ),
          ),
        };
      });

      return {
        schema_version: 1,
        study_version: state.study_version,
        question_bank_sha256: state.question_bank_sha256,
        submission_id: state.session_id,
        participant_id: state.participant_id,
        room_id: Number(state.room_id),
        room_sequence: Number(state.room_sequence),
        consent_version: String(options.consentVersion || "1"),
        app_build: String(options.appBuild || "dev"),
        started_at_client: state.started_at,
        completed_at_client: state.completed_at,
        answers,
      };
    }

    const GOOGLE_APPS_SCRIPT_ACK_TYPE = "genre-listening-test-submission-ack";

    function buildGoogleAppsScriptFormFields(payload, ackNonce) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("A collector payload object is required.");
      }
      const nonce = asNonEmptyString(ackNonce, "ack_nonce");
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
          .test(
            nonce,
          )
      ) {
        throw new Error("ack_nonce must be a canonical lowercase UUIDv4.");
      }
      return {
        payload: JSON.stringify(payload),
        ack_nonce: nonce,
      };
    }

    function trustedGoogleAppsScriptOrigin(origin) {
      let url;
      try {
        url = new URL(origin);
      } catch (_error) {
        return false;
      }
      if (
        url.protocol !== "https:" || url.port || url.username ||
        url.password || url.pathname !== "/" || url.search || url.hash
      ) {
        return false;
      }
      return url.hostname === "script.google.com" ||
        url.hostname === "script.googleusercontent.com" ||
        /^[a-z0-9-]+-script\.googleusercontent\.com$/.test(url.hostname);
    }

    function matchingGoogleAppsScriptAck(origin, data, expected) {
      if (!trustedGoogleAppsScriptOrigin(origin)) return null;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return null;
      }
      if (
        typeof expected?.ackNonce !== "string" ||
        typeof expected?.submissionId !== "string"
      ) {
        return null;
      }
      if (data.type !== GOOGLE_APPS_SCRIPT_ACK_TYPE) return null;
      if (data.ack_nonce !== expected?.ackNonce) return null;
      if (data.submission_id !== expected?.submissionId) return null;
      if (typeof data.ok !== "boolean") return null;
      if (
        data.ok &&
        (!new Set(["stored", "already_stored"]).has(data.status) ||
          data.rows_stored !== 10)
      ) {
        return null;
      }
      if (!data.ok && data.status !== "rejected") return null;
      return data;
    }

    function csvCell(value) {
      let text;
      if (value == null) {
        text = "";
      } else if (typeof value === "object") {
        text = JSON.stringify(value);
      } else {
        text = String(value);
      }
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }

    function rowsToCsv(rows, preferredColumns) {
      if (!Array.isArray(rows) || rows.length === 0) {
        return "";
      }
      const seen = new Set();
      const columns = [];
      (preferredColumns || []).forEach((column) => {
        if (!seen.has(column)) {
          seen.add(column);
          columns.push(column);
        }
      });
      rows.forEach((row) => {
        Object.keys(row).forEach((column) => {
          if (!seen.has(column)) {
            seen.add(column);
            columns.push(column);
          }
        });
      });
      const lines = [columns.map(csvCell).join(",")];
      rows.forEach((row) => {
        lines.push(columns.map((column) => csvCell(row[column])).join(","));
      });
      return `${lines.join("\r\n")}\r\n`;
    }

    return Object.freeze({
      buildRooms,
      buildCollectorPayload,
      buildGoogleAppsScriptFormFields,
      csvCell,
      datasetFingerprint,
      fnv1a,
      GOOGLE_APPS_SCRIPT_ACK_TYPE,
      makeUuid,
      matchingGoogleAppsScriptAck,
      mulberry32,
      nextRoomId,
      normalizeDataset,
      randomIndex,
      roomSequenceStorageKey,
      rowsToCsv,
      shuffleQuestionChoices,
      stableShuffle,
      trustedGoogleAppsScriptOrigin,
    });
  },
);
