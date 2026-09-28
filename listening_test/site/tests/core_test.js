import "../core.js";

const core = globalThis.ListeningTestCore;

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function fixture(roomCount = 10) {
  return {
    schema_version: 1,
    study_version: "test-v1",
    question_bank_sha256: "a".repeat(64),
    room_size: 10,
    room_count: roomCount,
    rooms: Array.from({ length: roomCount }, (_, roomId) => ({
      room_id: roomId,
      questions: Array.from({ length: 10 }, (_, questionIndex) => ({
        question_id: `room-${roomId}-question-${questionIndex}`,
        audio: `audio/${roomId}-${questionIndex}.mp3`,
        choices: ["Jazz", "Rock", `Other ${roomId}-${questionIndex}`],
      })),
    })),
  };
}

Deno.test("normalizes the public blinded room schema", () => {
  const dataset = core.normalizeDataset(fixture(), { roomSize: 10 });
  assert(dataset.study_version === "test-v1");
  assert(dataset.rooms.length === 10);
  assert(dataset.rooms.flatMap((room) => room.questions).length === 100);
  assert(core.buildRooms(dataset)[1].questions[0].audio === "audio/1-0.mp3");
});

Deno.test("rejects malformed or information-leaking choice structures", () => {
  const data = fixture();
  data.rooms[0].questions[0].choices = ["Jazz", "Jazz", "Rock"];
  let error = null;
  try {
    core.normalizeDataset(data);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error, "Duplicate labels should fail validation");
});

Deno.test("option randomization is a stable permutation within a session", () => {
  const question = core.normalizeDataset(fixture()).rooms[0].questions[0];
  const first = core.shuffleQuestionChoices(question, "session-a");
  const resumed = core.shuffleQuestionChoices(question, "session-a");
  assert(
    JSON.stringify(first) === JSON.stringify(resumed),
    "Resume order changed",
  );
  assert(
    [...first].sort().join("|") === [...question.choices].sort().join("|"),
  );

  const observed = new Set();
  for (let index = 0; index < 100; index += 1) {
    observed.add(
      JSON.stringify(core.shuffleQuestionChoices(question, `session-${index}`)),
    );
  }
  assert(observed.size === 6, "All six permutations should be reachable");
});

Deno.test("next room wraps modulo room count", () => {
  assert(core.nextRoomId([0, 1, 2], 0) === 1);
  assert(core.nextRoomId([0, 1, 2], 2) === 0);
});

Deno.test("runtime room count remains manifest-driven", () => {
  const dataset = core.normalizeDataset(fixture(3), { roomSize: 10 });
  const rooms = core.buildRooms(dataset);
  assert(dataset.room_count === 3);
  assert(rooms.length === 3);
  assert(core.nextRoomId(rooms.map((room) => room.room_id), 2) === 0);
});

Deno.test("room sequence storage resets independently for each question bank", () => {
  const firstBank = core.normalizeDataset(fixture());
  const secondFixture = fixture();
  secondFixture.question_bank_sha256 = "b".repeat(64);
  const secondBank = core.normalizeDataset(secondFixture);
  const namespace = "genre-listening-test-v1";

  const firstKey = core.roomSequenceStorageKey(namespace, firstBank);
  const explicitFingerprintKey = core.roomSequenceStorageKey(
    namespace,
    firstBank,
    core.datasetFingerprint(firstBank),
  );
  const secondKey = core.roomSequenceStorageKey(namespace, secondBank);

  assert(firstKey === explicitFingerprintKey);
  assert(firstKey !== secondKey);
  const simulatedStorage = new Map([[firstKey, "7"]]);
  assert(Number(simulatedStorage.get(firstKey)) === 7);
  assert(Number(simulatedStorage.get(secondKey) || 0) === 0);

  const bankWithoutPublishedHash = { ...firstBank };
  delete bankWithoutPublishedHash.question_bank_sha256;
  const fallbackFingerprint = core.datasetFingerprint(bankWithoutPublishedHash);
  const fallbackKey = core.roomSequenceStorageKey(
    namespace,
    bankWithoutPublishedHash,
  );
  assert(fallbackKey.endsWith(`:${fallbackFingerprint}`));
});

Deno.test("collector payload contains exactly the agreed blinded contract", () => {
  const room = core.normalizeDataset(fixture()).rooms[0];
  const state = {
    study_version: "test-v1",
    question_bank_sha256: "a".repeat(64),
    session_id: "11111111-1111-4111-8111-111111111111",
    participant_id: "22222222-2222-4222-8222-222222222222",
    room_id: 0,
    room_sequence: 3,
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:12.000Z",
    responses: Object.fromEntries(
      room.questions.map((question, index) => [
        question.question_id,
        {
          choice_order: [...question.choices].reverse(),
          selected_index: index % 3,
          first_shown_at: `2026-01-01T00:00:0${index}.000Z`,
          last_selected_at: `2026-01-01T00:00:0${index + 1}.250Z`,
          audio: { play_count: index + 1, listened_content_seconds: 1.234 },
        },
      ]),
    ),
  };
  const payload = core.buildCollectorPayload(state, room, {
    consentVersion: "1",
    appBuild: "test-build",
  });
  const expectedKeys = [
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
  assert(JSON.stringify(Object.keys(payload)) === JSON.stringify(expectedKeys));
  assert(payload.answers.length === 10);
  assert(payload.answers[0].elapsed_ms === 1250);
  assert(payload.answers[0].audio_listened_ms === 1234);
  assert(!JSON.stringify(payload).includes("user_agent"));
  assert(!JSON.stringify(payload).includes("model"));
});

Deno.test("Apps Script form fields preserve the raw payload and bind an ACK nonce", () => {
  const payload = {
    schema_version: 1,
    submission_id: "11111111-1111-4111-8111-111111111111",
    answers: [],
  };
  const nonce = "33333333-3333-4333-8333-333333333333";
  const fields = core.buildGoogleAppsScriptFormFields(payload, nonce);
  assert(fields.payload === JSON.stringify(payload));
  assert(fields.ack_nonce === nonce);
  assert(Object.keys(fields).length === 2);
  const retry = core.buildGoogleAppsScriptFormFields(
    payload,
    "44444444-4444-4444-8444-444444444444",
  );
  assert(
    retry.payload === fields.payload,
    "Retry changed the idempotent payload",
  );
  assert(retry.ack_nonce !== fields.ack_nonce, "Retry reused its ACK nonce");
});

Deno.test("Apps Script ACK requires a Google origin, nonce, ID, and type", () => {
  const expected = {
    ackNonce: "33333333-3333-4333-8333-333333333333",
    submissionId: "11111111-1111-4111-8111-111111111111",
  };
  const ack = {
    type: core.GOOGLE_APPS_SCRIPT_ACK_TYPE,
    ok: true,
    status: "stored",
    ack_nonce: expected.ackNonce,
    submission_id: expected.submissionId,
    rows_stored: 10,
  };
  assert(
    core.matchingGoogleAppsScriptAck(
      "https://script.googleusercontent.com",
      ack,
      expected,
    ) === ack,
  );
  assert(
    core.matchingGoogleAppsScriptAck(
      "https://n-example-0lu-script.googleusercontent.com",
      ack,
      expected,
    ) === ack,
  );
  assert(
    core.matchingGoogleAppsScriptAck(
      "https://script.google.com",
      ack,
      expected,
    ) === ack,
  );
  assert(
    core.matchingGoogleAppsScriptAck("https://example.com", ack, expected) ===
      null,
  );
  assert(
    core.matchingGoogleAppsScriptAck(
      "https://script.googleusercontent.com",
      { ...ack, ack_nonce: "wrong" },
      expected,
    ) === null,
  );
  assert(
    core.matchingGoogleAppsScriptAck(
      "https://script.googleusercontent.com",
      { ...ack, submission_id: "wrong" },
      expected,
    ) === null,
  );
  assert(
    core.matchingGoogleAppsScriptAck(
      "https://script.googleusercontent.com",
      { ...ack, type: "wrong" },
      expected,
    ) === null,
  );
  assert(
    core.matchingGoogleAppsScriptAck(
      "https://script.googleusercontent.com",
      { ...ack, rows_stored: 9 },
      expected,
    ) === null,
  );
  assert(
    !core.trustedGoogleAppsScriptOrigin(
      "https://script.googleusercontent.com.evil.example",
    ),
  );
});

Deno.test("CSV output preserves commas, quotes, and JSON-valued telemetry", () => {
  const csv = core.rowsToCsv([
    { question_id: "q1", label: 'Jazz, "modern"', order: ["A", "B", "C"] },
  ]);
  assert(csv.includes('"Jazz, ""modern"""'));
  assert(csv.includes('"[""A"",""B"",""C""]"'));
});
