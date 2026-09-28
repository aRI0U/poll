/* Google Apps Script entry points and durable Google Sheets storage. */
var ListeningTestCollector = (function () {
  "use strict";

  var RESPONSE_SHEET = "Responses";
  var REGISTRY_SHEET = "_Submissions";
  var LOCK_TIMEOUT_MS = 30000;
  var CONFIG_KEYS = {
    spreadsheetId: "SPREADSHEET_ID",
    privateBankFileId: "PRIVATE_BANK_FILE_ID",
    privateBankFileSha256: "PRIVATE_BANK_FILE_SHA256",
    expectedBankSha256: "EXPECTED_BANK_SHA256",
    ackTargetOrigin: "ACK_TARGET_ORIGIN",
    initializedBankSha256: "INITIALIZED_BANK_SHA256",
  };
  var ACK_TYPE = "genre-listening-test-submission-ack";
  var UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  var REGISTRY_HEADERS = [
    "submission_id",
    "payload_sha256",
    "status",
    "participant_id",
    "study_version",
    "question_bank_sha256",
    "room_id",
    "room_sequence",
    "response_start_row",
    "response_row_count",
    "first_received_at_utc",
    "completed_at_utc",
    "last_error",
  ];

  function RequestFailure(code, message) {
    this.name = "RequestFailure";
    this.code = code;
    this.message = message;
    this.stack = new Error(message).stack;
  }
  RequestFailure.prototype = Object.create(Error.prototype);

  function jsonOutput(payload) {
    return ContentService.createTextOutput(JSON.stringify(payload))
      .setMimeType(ContentService.MimeType.JSON);
  }

  function acknowledgementOutput(payload, targetOrigin) {
    return HtmlService.createHtmlOutput(ListeningTestCollectorCore.buildAcknowledgementHtml(payload, targetOrigin))
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  function sha256Hex(text) {
    var bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      text,
      Utilities.Charset.UTF_8
    );
    return bytes.map(function (value) {
      var unsigned = value < 0 ? value + 256 : value;
      return unsigned.toString(16).padStart(2, "0");
    }).join("");
  }

  function sha256BytesHex(bytes) {
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
    return digest.map(function (value) {
      var unsigned = value < 0 ? value + 256 : value;
      return unsigned.toString(16).padStart(2, "0");
    }).join("");
  }

  function utf8Length(text) {
    return Utilities.newBlob(text, "text/plain").getBytes().length;
  }

  function getConfig(requireInitialized) {
    var properties = PropertiesService.getScriptProperties();
    var result = {};
    Object.keys(CONFIG_KEYS).forEach(function (name) {
      result[name] = String(properties.getProperty(CONFIG_KEYS[name]) || "").trim();
    });
    [
      "spreadsheetId",
      "privateBankFileId",
      "privateBankFileSha256",
      "expectedBankSha256",
      "ackTargetOrigin",
    ].forEach(function (name) {
      if (!result[name]) throw new Error(CONFIG_KEYS[name] + " script property is required");
    });
    if (!ListeningTestCollectorCore.SHA256_RE.test(result.privateBankFileSha256)) {
      throw new Error("PRIVATE_BANK_FILE_SHA256 must be a lowercase SHA-256 digest");
    }
    if (!ListeningTestCollectorCore.SHA256_RE.test(result.expectedBankSha256)) {
      throw new Error("EXPECTED_BANK_SHA256 must be a lowercase SHA-256 digest");
    }
    ListeningTestCollectorCore.buildAcknowledgementHtml({}, result.ackTargetOrigin);
    if (requireInitialized && result.initializedBankSha256 !== result.expectedBankSha256) {
      throw new Error("run initializeCollector() for the configured private bank before accepting responses");
    }
    return result;
  }

  function loadBank(config) {
    var file = DriveApp.getFileById(config.privateBankFileId);
    if (file.getSize() > ListeningTestCollectorCore.MAX_BANK_BYTES) {
      throw new Error("private question bank is too large");
    }
    var blob = file.getBlob();
    var bytes = blob.getBytes();
    if (bytes.length > ListeningTestCollectorCore.MAX_BANK_BYTES) {
      throw new Error("private question bank is too large");
    }
    if (sha256BytesHex(bytes) !== config.privateBankFileSha256) {
      throw new Error("private question-bank file does not match PRIVATE_BANK_FILE_SHA256");
    }
    var text = blob.getDataAsString("UTF-8");
    var raw = ListeningTestCollectorCore.parseStrictJson(text);
    // The exact file bytes are pinned above.  The callback binds its embedded
    // logical digest to the public question bank without reserializing floats;
    // Python and JavaScript intentionally format some small floats differently.
    var bank = ListeningTestCollectorCore.validatePrivateBank(raw, function (_bankCore, declaredSha256) {
      return declaredSha256 === config.expectedBankSha256;
    });
    if (bank.sha256 !== config.expectedBankSha256) {
      throw new Error("private question bank does not match EXPECTED_BANK_SHA256");
    }
    return bank;
  }

  function ensureGridCapacity(sheet, requiredRows, requiredColumns) {
    var currentRows = sheet.getMaxRows();
    var rowGrowth = ListeningTestCollectorCore.requiredGridGrowth(currentRows, requiredRows);
    if (rowGrowth > 0) {
      sheet.insertRowsAfter(currentRows, rowGrowth);
    }
    var currentColumns = sheet.getMaxColumns();
    var columnGrowth = ListeningTestCollectorCore.requiredGridGrowth(
      currentColumns,
      requiredColumns
    );
    if (columnGrowth > 0) {
      sheet.insertColumnsAfter(currentColumns, columnGrowth);
    }
  }

  function requireSheetSchema(spreadsheet, name, headers, create) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet && create) sheet = spreadsheet.insertSheet(name);
    if (!sheet) throw new Error("missing required sheet: " + name);
    ensureGridCapacity(sheet, 1, headers.length);
    if (sheet.getLastRow() === 0) {
      if (!create) throw new Error("sheet " + name + " has not been initialized");
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    }
    var actual = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
    if (actual.length !== headers.length || actual.some(function (value, index) {
      return value !== headers[index];
    })) {
      throw new Error("sheet " + name + " header does not match the collector schema");
    }
    if (sheet.getLastColumn() > headers.length) {
      var extra = sheet.getRange(1, headers.length + 1, 1, sheet.getLastColumn() - headers.length)
        .getDisplayValues()[0];
      if (extra.some(function (value) { return value !== ""; })) {
        throw new Error("sheet " + name + " contains unexpected header columns");
      }
    }
    return sheet;
  }

  function openStorage(config, create) {
    var spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
    var responses = requireSheetSchema(
      spreadsheet,
      RESPONSE_SHEET,
      ListeningTestCollectorCore.RESPONSE_HEADERS,
      create
    );
    var registry = requireSheetSchema(spreadsheet, REGISTRY_SHEET, REGISTRY_HEADERS, create);
    if (create && !registry.isSheetHidden()) registry.hideSheet();
    return { spreadsheet: spreadsheet, responses: responses, registry: registry };
  }

  function initialize() {
    var config = getConfig(false);
    var bank = loadBank(config);
    var lock = LockService.getScriptLock();
    lock.waitLock(LOCK_TIMEOUT_MS);
    try {
      openStorage(config, true);
      PropertiesService.getScriptProperties().setProperty(
        CONFIG_KEYS.initializedBankSha256,
        bank.sha256
      );
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    var result = {
      ok: true,
      study_version: bank.studyVersion,
      question_bank_sha256: bank.sha256,
      room_count: Object.keys(bank.rooms).length,
      room_size: ListeningTestCollectorCore.ROOM_SIZE,
      spreadsheet_url: "https://docs.google.com/spreadsheets/d/" + config.spreadsheetId + "/edit",
    };
    console.log(JSON.stringify(result));
    return result;
  }

  function oneParameter(event, name) {
    if (!event.parameters || !Object.prototype.hasOwnProperty.call(event.parameters, name)) return null;
    var values = event.parameters[name];
    if (!Array.isArray(values) || values.length !== 1) {
      throw new RequestFailure("invalid_request", name + " must occur exactly once");
    }
    return values[0];
  }

  function extractRequest(event) {
    if (!event || !event.postData || typeof event.postData.contents !== "string") {
      throw new RequestFailure("invalid_body", "request body must be non-empty JSON");
    }
    var contentType = String(event.postData.type || "").toLowerCase().split(";", 1)[0].trim();
    var rawText;
    var acknowledgementNonce = null;
    var responseMode = "json";
    if (contentType === "application/x-www-form-urlencoded") {
      var allowed = ["payload", "ack_nonce"];
      Object.keys(event.parameters || {}).forEach(function (name) {
        if (allowed.indexOf(name) === -1) {
          throw new RequestFailure("invalid_request", "unexpected request parameter: " + name);
        }
      });
      rawText = oneParameter(event, "payload");
      acknowledgementNonce = oneParameter(event, "ack_nonce");
      if (!rawText) throw new RequestFailure("invalid_body", "form payload is required");
      if (!acknowledgementNonce || !UUID_V4_RE.test(acknowledgementNonce)) {
        throw new RequestFailure("invalid_request", "ack_nonce must be a lowercase version-4 UUID");
      }
      responseMode = "ack";
    } else if (contentType === "text/plain" || contentType === "application/json") {
      if (Object.keys(event.parameters || {}).length) {
        throw new RequestFailure("invalid_request", "query parameters are not accepted");
      }
      rawText = event.postData.contents;
    } else {
      throw new RequestFailure(
        "unsupported_media_type",
        "Content-Type must be text/plain, application/json, or application/x-www-form-urlencoded"
      );
    }
    if (!rawText || utf8Length(rawText) > ListeningTestCollectorCore.MAX_BODY_BYTES) {
      throw new RequestFailure("invalid_body", "request JSON is empty or too large");
    }
    var parsed;
    try {
      parsed = ListeningTestCollectorCore.parseStrictJson(rawText);
    } catch (error) {
      throw new RequestFailure("invalid_json", error.message);
    }
    return {
      raw: parsed,
      acknowledgementNonce: acknowledgementNonce,
      responseMode: responseMode,
    };
  }

  function acknowledgementContext(event) {
    if (!event || !event.postData) return { responseMode: "json", nonce: "" };
    var contentType = String(event.postData.type || "").toLowerCase().split(";", 1)[0].trim();
    if (contentType !== "application/x-www-form-urlencoded") {
      return { responseMode: "json", nonce: "" };
    }
    var values = event.parameters && event.parameters.ack_nonce;
    if (!Array.isArray(values) || values.length !== 1 || !UUID_V4_RE.test(values[0])) {
      return { responseMode: "json", nonce: "" };
    }
    return { responseMode: "ack", nonce: values[0] };
  }

  function findRegistryRecord(sheet, submissionId) {
    if (sheet.getLastRow() < 2) return null;
    var matches = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
      .createTextFinder(submissionId)
      .matchEntireCell(true)
      .useRegularExpression(false)
      .findAll();
    if (matches.length > 1) throw new Error("submission registry contains a duplicate ID");
    if (!matches.length) return null;
    var rowNumber = matches[0].getRow();
    var values = sheet.getRange(rowNumber, 1, 1, REGISTRY_HEADERS.length).getValues()[0];
    var record = { _rowNumber: rowNumber };
    REGISTRY_HEADERS.forEach(function (header, index) {
      record[header] = values[index];
    });
    return record;
  }

  function nextResponseStartRow(storage) {
    var next = Math.max(2, storage.responses.getLastRow() + 1);
    if (storage.registry.getLastRow() < 2) return next;
    var startIndex = REGISTRY_HEADERS.indexOf("response_start_row");
    var countIndex = REGISTRY_HEADERS.indexOf("response_row_count");
    storage.registry.getRange(2, 1, storage.registry.getLastRow() - 1, REGISTRY_HEADERS.length)
      .getValues().forEach(function (row) {
        var start = Number(row[startIndex]);
        var count = Number(row[countIndex]);
        if (Number.isInteger(start) && Number.isInteger(count) && start >= 2 && count > 0) {
          next = Math.max(next, start + count);
        }
      });
    return next;
  }

  function appendPendingRegistry(storage, submission, payloadSha256, receivedAt) {
    var responseStart = nextResponseStartRow(storage);
    var row = {
      submission_id: submission.submissionId,
      payload_sha256: payloadSha256,
      status: "pending",
      participant_id: submission.participantId,
      study_version: submission.studyVersion,
      question_bank_sha256: submission.questionBankSha256,
      room_id: submission.roomId,
      room_sequence: submission.roomSequence,
      response_start_row: responseStart,
      response_row_count: ListeningTestCollectorCore.ROOM_SIZE,
      first_received_at_utc: receivedAt,
      completed_at_utc: "",
      last_error: "",
    };
    var values = REGISTRY_HEADERS.map(function (header) { return row[header]; });
    var rowNumber = storage.registry.getLastRow() + 1;
    ensureGridCapacity(storage.registry, rowNumber, values.length);
    storage.registry.getRange(rowNumber, 1, 1, values.length).setValues([values]);
    row._rowNumber = rowNumber;
    return row;
  }

  function ensureReservationMatches(record, expectedMatrix) {
    var start = Number(record.response_start_row);
    var count = Number(record.response_row_count);
    if (!Number.isInteger(start) || start < 2 || count !== ListeningTestCollectorCore.ROOM_SIZE) {
      throw new Error("submission registry contains an invalid response reservation");
    }
    if (expectedMatrix.length !== count) throw new Error("response row count is invalid");
    return start;
  }

  function verifyOrWriteResponses(storage, record, expectedMatrix) {
    var start = ensureReservationMatches(record, expectedMatrix);
    ensureGridCapacity(
      storage.responses,
      start + expectedMatrix.length - 1,
      ListeningTestCollectorCore.RESPONSE_HEADERS.length
    );
    var range = storage.responses.getRange(
      start,
      1,
      expectedMatrix.length,
      ListeningTestCollectorCore.RESPONSE_HEADERS.length
    );
    var existing = range.getValues();
    if (!ListeningTestCollectorCore.existingRowsAreRecoverable(
      existing,
      expectedMatrix,
      ListeningTestCollectorCore.RESPONSE_HEADERS
    )) {
      throw new Error("reserved response rows conflict with the submission registry");
    }
    var complete = existing.every(function (row, rowIndex) {
      return ListeningTestCollectorCore.existingRowsAreRecoverable(
        [row],
        [expectedMatrix[rowIndex]],
        ListeningTestCollectorCore.RESPONSE_HEADERS
      ) && row.some(function (value) { return value !== ""; });
    });
    if (!complete) range.setValues(expectedMatrix);
    SpreadsheetApp.flush();
  }

  function markRegistryComplete(storage, record, completedAt) {
    var statusColumn = REGISTRY_HEADERS.indexOf("status") + 1;
    var completedColumn = REGISTRY_HEADERS.indexOf("completed_at_utc") + 1;
    storage.registry.getRange(record._rowNumber, completedColumn, 1, 2)
      .setValues([[completedAt, ""]]);
    SpreadsheetApp.flush();
    // Status is the durable completion marker and must be committed last.
    storage.registry.getRange(record._rowNumber, statusColumn).setValue("complete");
    SpreadsheetApp.flush();
  }

  function markRegistryError(storage, record, error) {
    if (!record || !record._rowNumber) return;
    var errorColumn = REGISTRY_HEADERS.indexOf("last_error") + 1;
    var message = String(error && error.message ? error.message : "storage failure").slice(0, 500);
    storage.registry.getRange(record._rowNumber, errorColumn).setValue(message);
    SpreadsheetApp.flush();
  }

  function persist(config, submission, rows, payloadSha256, receivedAt) {
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(LOCK_TIMEOUT_MS);
    } catch (error) {
      throw new RequestFailure("collector_busy", "collector is busy; retry the same submission_id");
    }
    var record = null;
    try {
      var storage = openStorage(config, false);
      record = findRegistryRecord(storage.registry, submission.submissionId);
      var action;
      try {
        action = ListeningTestCollectorCore.idempotencyAction(record, payloadSha256);
      } catch (error) {
        throw new RequestFailure("submission_conflict", error.message);
      }
      if (action === "new") {
        record = appendPendingRegistry(storage, submission, payloadSha256, receivedAt);
        SpreadsheetApp.flush();
      }
      var stableRows = ListeningTestCollectorCore.stabilizeResponseRows(
        rows,
        record.first_received_at_utc
      );
      var expectedMatrix = ListeningTestCollectorCore.rowsToMatrix(
        stableRows,
        ListeningTestCollectorCore.RESPONSE_HEADERS
      );
      verifyOrWriteResponses(storage, record, expectedMatrix);
      var wasComplete = action === "duplicate";
      var completionMetadataMissing = !record.completed_at_utc || record.last_error;
      if (!wasComplete || completionMetadataMissing) {
        markRegistryComplete(storage, record, new Date().toISOString());
      }
      return wasComplete;
    } catch (error) {
      try {
        if (record && !(error instanceof RequestFailure)) {
          markRegistryError(openStorage(config, false), record, error);
        }
      } catch (ignored) {
        console.error("Unable to record collector storage error: " + ignored.message);
      }
      throw error;
    } finally {
      lock.releaseLock();
    }
  }

  function handlePost(event) {
    var request;
    var config;
    var submissionId = "";
    var acknowledgementNonce = "";
    var context = acknowledgementContext(event);
    var responseMode = context.responseMode;
    acknowledgementNonce = context.nonce;
    try {
      request = extractRequest(event);
      acknowledgementNonce = request.acknowledgementNonce || "";
      responseMode = request.responseMode;
      if (request.raw && typeof request.raw.submission_id === "string" && UUID_V4_RE.test(request.raw.submission_id)) {
        submissionId = request.raw.submission_id;
      }
      config = getConfig(true);
      var bank = loadBank(config);
      var submission;
      try {
        submission = ListeningTestCollectorCore.validateSubmission(request.raw, bank);
      } catch (error) {
        throw new RequestFailure("invalid_submission", error.message);
      }
      submissionId = submission.submissionId;
      var canonicalPayload = ListeningTestCollectorCore.canonicalJson(request.raw);
      var payloadSha256 = sha256Hex(canonicalPayload);
      var receivedAt = new Date().toISOString();
      var rows = ListeningTestCollectorCore.buildResponseRows(
        submission,
        bank,
        receivedAt,
        payloadSha256
      );
      var duplicate = persist(config, submission, rows, payloadSha256, receivedAt);
      var success = {
        type: ACK_TYPE,
        ok: true,
        submission_id: submission.submissionId,
        status: duplicate ? "already_stored" : "stored",
        ack_nonce: acknowledgementNonce,
        rows_stored: ListeningTestCollectorCore.ROOM_SIZE,
      };
      return responseMode === "ack"
        ? acknowledgementOutput(success, config.ackTargetOrigin)
        : jsonOutput(success);
    } catch (error) {
      var failure;
      if (error instanceof RequestFailure) {
        failure = {
          type: ACK_TYPE,
          ok: false,
          status: "rejected",
          submission_id: submissionId,
          ack_nonce: acknowledgementNonce,
          error: error.code,
          message: error.message,
        };
      } else {
        console.error(error && error.stack ? error.stack : String(error));
        failure = {
          type: ACK_TYPE,
          ok: false,
          status: "rejected",
          submission_id: submissionId,
          ack_nonce: acknowledgementNonce,
          error: "collector_unavailable",
          message: "The response collector is temporarily unavailable. Retry the same submission.",
        };
      }
      var targetOrigin = config && config.ackTargetOrigin;
      if (!targetOrigin) {
        try {
          targetOrigin = String(
            PropertiesService.getScriptProperties().getProperty(CONFIG_KEYS.ackTargetOrigin) || ""
          ).trim();
        } catch (ignored) {
          targetOrigin = "";
        }
      }
      if (responseMode === "ack" && targetOrigin) {
        try {
          return acknowledgementOutput(failure, targetOrigin);
        } catch (ignored) {
          console.error("Unable to render acknowledgement: " + ignored.message);
        }
      }
      return jsonOutput(failure);
    }
  }

  return {
    initialize: initialize,
    handlePost: handlePost,
  };
})();

function doPost(event) {
  return ListeningTestCollector.handlePost(event);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({
    ok: false,
    error: "method_not_allowed",
    message: "Submit listening-test results with POST.",
  })).setMimeType(ContentService.MimeType.JSON);
}

function initializeCollector() {
  return ListeningTestCollector.initialize();
}
