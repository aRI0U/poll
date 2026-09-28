const source = await Deno.readTextFile(
  new URL("../CollectorCore.gs", import.meta.url),
);
const core = new Function(
  `${source}\nreturn ListeningTestCollectorCore;`,
)();

const appSource = await Deno.readTextFile(
  new URL("../Code.gs", import.meta.url),
);

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function assert(condition, message = "assertion failed") {
  if (!condition) throw new Error(message);
}

function assertEquals(actual, expected, message = "values differ") {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
}

function assertThrows(callback, pattern) {
  let error = null;
  try {
    callback();
  } catch (candidate) {
    error = candidate;
  }
  assert(error instanceof Error, "expected callback to throw");
  if (pattern) {
    assert(pattern.test(error.message), `unexpected error: ${error.message}`);
  }
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeBank() {
  const questions = Array.from({ length: 10 }, (_, index) => {
    const position = index + 1;
    return {
      question_id: `q_${String(position).padStart(20, "0")}`,
      room_id: 0,
      room_position: position,
      split: index % 2 === 0 ? "valid" : "test",
      isrc: `TEST${String(position).padStart(8, "0")}`,
      audio_id: `audio-${position}`,
      published_audio_sha256: String(position % 10).repeat(64),
      annotation_genre: `Annotation ${position}`,
      annotation_subgenre: `Annotation ${position}`,
      model_genre: `Model ${position}`,
      random_genre: `Random ${position}`,
      model_confidence: 0.7,
      annotation_probability: 0.2,
      model_margin: 0.5,
      options: [
        { role: "model", label: `Model ${position}` },
        { role: "annotation", label: `Annotation ${position}` },
        { role: "random", label: `Random ${position}` },
      ],
    };
  });
  const questionsById = Object.fromEntries(
    questions.map((question) => [question.question_id, question]),
  );
  return {
    schema_version: 1,
    study_version: "genre-listening-test-v1",
    room_size: 10,
    room_count: 1,
    rooms: [{ room_id: 0, questions }],
    question_bank_sha256: "a".repeat(64),
    questions_by_id: questionsById,
  };
}

function validatedBank() {
  return core.validatePrivateBank(
    makeBank(),
    (_bankCore, declaredSha256) => declaredSha256 === "a".repeat(64),
  );
}

function makePayload(bank = makeBank()) {
  return {
    schema_version: 1,
    study_version: bank.study_version,
    question_bank_sha256: bank.question_bank_sha256,
    submission_id: "12345678-1234-4234-8234-123456789abc",
    participant_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    room_id: 0,
    room_sequence: 0,
    consent_version: "1",
    app_build: "test-build.1",
    started_at_client: "2026-09-28T12:00:00.000Z",
    completed_at_client: "2026-09-28T12:01:00.000Z",
    answers: bank.rooms[0].questions.map((question, index) => ({
      question_id: question.question_id,
      question_position: index + 1,
      option_order: [
        question.random_genre,
        question.model_genre,
        question.annotation_genre,
      ],
      selected_index: index % 3,
      shown_at_client: `2026-09-28T12:00:${
        String(index).padStart(2, "0")
      }.000Z`,
      answered_at_client: `2026-09-28T12:00:${
        String(index).padStart(2, "0")
      }.500Z`,
      elapsed_ms: 500,
      audio_play_count: 1,
      audio_listened_ms: 450,
    })),
  };
}

Deno.test("strict JSON parser rejects duplicate keys and trailing input", () => {
  assertThrows(() => core.parseStrictJson('{"a":1,"a":2}'), /duplicate key/);
  assertThrows(() => core.parseStrictJson('{"a":1} true'), /trailing data/);
  assertEquals(core.parseStrictJson('{"a":[true,null,-2.5]}').a, [
    true,
    null,
    -2.5,
  ]);
});

Deno.test("canonical JSON is independent of object key insertion order", () => {
  assert(
    core.canonicalJson({ z: 1, nested: { b: 2, a: 1 } }) ===
      core.canonicalJson({ nested: { a: 1, b: 2 }, z: 1 }),
  );
});

Deno.test("Apps Script files can evaluate in reverse order", () => {
  const loaded = new Function(
    `${appSource}\n${source}\nreturn {
      collector: typeof ListeningTestCollector,
      core: typeof ListeningTestCollectorCore,
      post: typeof doPost,
    };`,
  )();
  assertEquals(loaded, {
    collector: "object",
    core: "object",
    post: "function",
  });
});

Deno.test("active private bank passes exact-file and structural validation when available", async () => {
  const logicalSha =
    "5239bacf889f9a67f4932e5b641159a2808f28e4279b3ac88cbe34e0211e5822";
  const expectedFileSha =
    "b632066f0690d4f2546d442777b7a0820d11a0b36206891b3054bcc6d27ca004";
  const bankUrl = new URL(
    `../../../outputs/genre_listening_test/question_banks/${logicalSha}.private.json`,
    import.meta.url,
  );
  let bytes;
  try {
    bytes = await Deno.readFile(bankUrl);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  assert(
    await sha256Hex(bytes) === expectedFileSha,
    "active private file hash drifted",
  );
  const raw = core.parseStrictJson(new TextDecoder().decode(bytes));
  const bank = core.validatePrivateBank(
    raw,
    (_bankCore, declaredSha256) => declaredSha256 === logicalSha,
  );
  assert(bank.sha256 === logicalSha);
  assert(Object.keys(bank.rooms).length === 10);
  assert(Object.values(bank.rooms).every((room) => room.length === 10));
});

Deno.test("private bank and complete ten-answer payload validate", () => {
  const bank = validatedBank();
  const submission = core.validateSubmission(makePayload(), bank);
  assert(submission.submissionId === "12345678-1234-4234-8234-123456789abc");
  assert(Object.keys(submission.answersById).length === 10);
});

Deno.test("analysis rows recover semantic roles from the private bank", () => {
  const bank = validatedBank();
  const submission = core.validateSubmission(makePayload(), bank);
  const rows = core.buildResponseRows(
    submission,
    bank,
    "2026-09-28T12:02:00.000Z",
    "b".repeat(64),
  );
  assert(rows.length === 10);
  assert(rows[0].selected_role === "random");
  assert(rows[1].selected_role === "model");
  assert(rows[2].selected_role === "annotation");
  assert(rows[0].option_1_role === "random");
  assert(rows[0].option_2_role === "model");
  assert(rows[0].option_3_role === "annotation");
  const matrix = core.rowsToMatrix(rows, core.RESPONSE_HEADERS);
  assert(
    matrix.length === 10 && matrix[0].length === core.RESPONSE_HEADERS.length,
  );
});

Deno.test("payload validator rejects schema drift and forged answer data", () => {
  const bank = validatedBank();
  const extra = makePayload();
  extra.unexpected = true;
  assertThrows(
    () => core.validateSubmission(extra, bank),
    /unexpected unexpected/,
  );

  const forged = makePayload();
  forged.answers[0].option_order[0] = "Forged genre";
  assertThrows(
    () => core.validateSubmission(forged, bank),
    /exact bank permutation/,
  );

  const partial = makePayload();
  partial.answers.pop();
  assertThrows(() => core.validateSubmission(partial, bank), /exactly 10/);

  const badDate = makePayload();
  badDate.started_at_client = "2026-02-30T12:00:00Z";
  assertThrows(() => core.validateSubmission(badDate, bank), /real RFC 3339/);
});

Deno.test("private bank rejects semantic-role mismatch and digest mismatch", () => {
  const roleMismatch = deepCopy(makeBank());
  roleMismatch.rooms[0].questions[0].options[0].label = "Wrong model";
  roleMismatch.questions_by_id[roleMismatch.rooms[0].questions[0].question_id] =
    roleMismatch.rooms[0].questions[0];
  assertThrows(
    () => core.validatePrivateBank(roleMismatch, () => true),
    /options do not match/,
  );
  assertThrows(
    () => core.validatePrivateBank(makeBank(), () => false),
    /digest does not match/,
  );

  const formula = deepCopy(makeBank());
  formula.rooms[0].questions[0].annotation_genre = '=IMPORTXML("bad")';
  formula.rooms[0].questions[0].options[1].label = '=IMPORTXML("bad")';
  formula.questions_by_id[formula.rooms[0].questions[0].question_id] =
    formula.rooms[0].questions[0];
  assertThrows(
    () => core.validatePrivateBank(formula, () => true),
    /spreadsheet formula prefix/,
  );
});

Deno.test("idempotency distinguishes new, retry, duplicate, and conflict", () => {
  const sha = "c".repeat(64);
  assert(core.idempotencyAction(null, sha) === "new");
  assert(
    core.idempotencyAction({ payload_sha256: sha, status: "pending" }, sha) ===
      "resume",
  );
  assert(
    core.idempotencyAction({ payload_sha256: sha, status: "complete" }, sha) ===
      "duplicate",
  );
  assertThrows(
    () =>
      core.idempotencyAction({
        payload_sha256: "d".repeat(64),
        status: "complete",
      }, sha),
    /different content/,
  );
});

Deno.test("grid growth covers new response columns and long studies", () => {
  assert(core.requiredGridGrowth(26, core.RESPONSE_HEADERS.length) === 14);
  assert(core.requiredGridGrowth(1000, 3001) === 2001);
  assert(core.requiredGridGrowth(4000, 3001) === 0);
});

Deno.test("retry rows retain the first registry receipt timestamp", () => {
  const bank = validatedBank();
  const submission = core.validateSubmission(makePayload(), bank);
  const firstRows = core.buildResponseRows(
    submission,
    bank,
    "2026-09-28T12:02:00.000Z",
    "e".repeat(64),
  );
  const retryRows = core.buildResponseRows(
    submission,
    bank,
    "2026-09-28T12:03:00.000Z",
    "e".repeat(64),
  );
  const stableRetry = core.stabilizeResponseRows(
    retryRows,
    new Date("2026-09-28T12:02:00.000Z"),
  );
  assertEquals(stableRetry, firstRows);
  assert(
    retryRows[0].collector_received_at_utc === "2026-09-28T12:03:00.000Z",
    "stabilization must not mutate the caller's rows",
  );
});

Deno.test("reserved Sheet rows are recoverable only for the same submission", () => {
  const bank = validatedBank();
  const submission = core.validateSubmission(makePayload(), bank);
  const rows = core.buildResponseRows(
    submission,
    bank,
    "2026-09-28T12:02:00.000Z",
    "e".repeat(64),
  );
  const expected = core.rowsToMatrix(rows, core.RESPONSE_HEADERS);
  const empty = expected.map((row) => row.map(() => ""));
  assert(
    core.existingRowsAreRecoverable(empty, expected, core.RESPONSE_HEADERS),
  );
  const partial = deepCopy(empty);
  partial[0] = deepCopy(expected[0]);
  assert(
    core.existingRowsAreRecoverable(partial, expected, core.RESPONSE_HEADERS),
  );
  const selectedRole = core.RESPONSE_HEADERS.indexOf("selected_role");
  partial[0][selectedRole] = "corrupted-role";
  assert(
    !core.existingRowsAreRecoverable(partial, expected, core.RESPONSE_HEADERS),
  );
  partial[0] = deepCopy(expected[0]);
  partial[0][core.RESPONSE_HEADERS.indexOf("submission_id")] =
    "ffffffff-ffff-4fff-8fff-ffffffffffff";
  assert(
    !core.existingRowsAreRecoverable(partial, expected, core.RESPONSE_HEADERS),
  );
});

Deno.test("ACK HTML targets the exact origin and escapes script-breaking data", () => {
  const payload = {
    type: "genre-listening-test-submission-ack",
    ok: false,
    message: "</script><script>throw new Error('injected')</script>",
  };
  const html = core.buildAcknowledgementHtml(
    payload,
    "https://ari0u.github.io",
  );
  assert(html.includes("window.top.postMessage("));
  assert(html.includes('"https://ari0u.github.io"'));
  assert(!html.includes("</script><script>"));
  const inlineScript = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  let received = null;
  new Function("window", inlineScript)({
    top: {
      postMessage: (message, origin) => {
        received = { message, origin };
      },
    },
  });
  assertEquals(received, {
    message: payload,
    origin: "https://ari0u.github.io",
  });
  assertThrows(
    () =>
      core.buildAcknowledgementHtml(payload, "https://ari0u.github.io/path"),
    /exact HTTPS origin/,
  );
});
