(function runListeningRoom() {
  "use strict";

  const core = window.ListeningTestCore;
  const config = {
    questionsUrl: "./data/questions.json",
    roomSize: 10,
    consentVersion: "1",
    appBuild: "dev",
    submissionEndpoint: "",
    submissionFormat: "json",
    submissionHeaders: {},
    submissionTimeoutMs: 15000,
    retryDelaysMs: [0, 1500, 4000],
    storageNamespace: "genre-listening-test-v1",
    ...(window.LISTENING_TEST_CONFIG || {}),
  };

  const elements = {
    loadingView: document.getElementById("loading-view"),
    introView: document.getElementById("intro-view"),
    surveyView: document.getElementById("survey-view"),
    submitView: document.getElementById("submit-view"),
    completeView: document.getElementById("complete-view"),
    errorView: document.getElementById("error-view"),
    errorMessage: document.getElementById("error-message"),
    saveIndicator: document.getElementById("save-indicator"),
    resumeNote: document.getElementById("resume-note"),
    startButton: document.getElementById("start-button"),
    progressLabel: document.getElementById("progress-label"),
    answeredLabel: document.getElementById("answered-label"),
    progressBar: document.getElementById("progress-bar"),
    questionTitle: document.getElementById("question-title"),
    audio: document.getElementById("question-audio"),
    audioMessage: document.getElementById("audio-message"),
    choicesList: document.getElementById("choices-list"),
    choiceError: document.getElementById("choice-error"),
    previousButton: document.getElementById("previous-button"),
    nextButton: document.getElementById("next-button"),
    submitTitle: document.getElementById("submit-title"),
    submitStatus: document.getElementById("submit-status"),
    completionIcon: document.getElementById("completion-icon"),
    completeTitle: document.getElementById("complete-title"),
    completeMessage: document.getElementById("complete-message"),
    participantCode: document.getElementById("participant-code"),
    submissionCode: document.getElementById("submission-code"),
    retryPanel: document.getElementById("retry-panel"),
    retryMessage: document.getElementById("retry-message"),
    retrySubmitButton: document.getElementById("retry-submit-button"),
    downloadJsonButton: document.getElementById("download-json-button"),
    downloadCsvButton: document.getElementById("download-csv-button"),
    anotherPanel: document.getElementById("another-panel"),
    anotherButton: document.getElementById("another-button"),
    finishButton: document.getElementById("finish-button"),
    finishedMessage: document.getElementById("finished-message"),
  };

  const views = [
    elements.loadingView,
    elements.introView,
    elements.surveyView,
    elements.submitView,
    elements.completeView,
    elements.errorView,
  ];

  let dataset = null;
  let rooms = [];
  let room = null;
  let roomIndex = -1;
  let manifestUrl = null;
  let fingerprint = null;
  let participantId = null;
  let requestedRoomSequence = 0;
  let state = null;
  let stateKey = null;
  let submissionInFlight = false;
  let storageUsable = true;

  const runtime = {
    questionId: null,
    activeStartedAt: null,
    playWallStartedAt: null,
    lastMediaTime: null,
    seekFrom: null,
    lastTimeupdateSave: 0,
  };

  function nowIso() {
    return new Date().toISOString();
  }

  function elapsedMs(startIso, endIso) {
    if (!startIso || !endIso) return null;
    const elapsed = Date.parse(endIso) - Date.parse(startIso);
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  }

  function round(value, digits) {
    if (value == null || !Number.isFinite(Number(value))) return null;
    const factor = 10 ** (digits == null ? 3 : digits);
    return Math.round(Number(value) * factor) / factor;
  }

  function showView(view) {
    views.forEach((candidate) => {
      candidate.hidden = candidate !== view;
    });
  }

  function showFatal(error) {
    closeQuestionTracking();
    showView(elements.errorView);
    elements.errorMessage.textContent = error instanceof Error
      ? error.message
      : String(error || "Unknown error.");
    document.title = "Questionnaire unavailable";
  }

  function storageGet(key) {
    if (!storageUsable) return null;
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      storageUsable = false;
      updateSaveIndicator();
      return null;
    }
  }

  function storageSet(key, value) {
    if (!storageUsable) return false;
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (_error) {
      storageUsable = false;
      updateSaveIndicator();
      return false;
    }
  }

  function storageRemove(key) {
    if (!storageUsable) return;
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      storageUsable = false;
      updateSaveIndicator();
    }
  }

  function updateSaveIndicator() {
    if (!elements.saveIndicator) return;
    elements.saveIndicator.textContent = storageUsable
      ? "Saved on this device"
      : "Saved until this tab closes";
  }

  function persistState() {
    if (!state || !stateKey) return;
    state.updated_at = nowIso();
    if (storageSet(stateKey, JSON.stringify(state))) {
      updateSaveIndicator();
    }
  }

  function addLifecycleEvent(type, detail) {
    if (!state) return;
    state.lifecycle_events.push({
      event: type,
      at: nowIso(),
      ...(detail || {}),
    });
  }

  function getParticipantId() {
    const key = `${config.storageNamespace}:participant-id`;
    const existing = storageGet(key);
    if (existing) return existing;
    const created = core.makeUuid();
    storageSet(key, created);
    return created;
  }

  function sequenceStorageKey() {
    return core.roomSequenceStorageKey(
      config.storageNamespace,
      dataset,
      fingerprint,
    );
  }

  function storedRoomSequence() {
    const value = Number(storageGet(sequenceStorageKey()));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function markSequenceCompleted(sequence) {
    const next = Math.max(storedRoomSequence(), Number(sequence) + 1);
    storageSet(sequenceStorageKey(), String(next));
  }

  function newAudioMetrics() {
    return {
      play_count: 0,
      pause_count: 0,
      ended_count: 0,
      replay_count: 0,
      seek_count: 0,
      seek_forward_seconds: 0,
      seek_backward_seconds: 0,
      waiting_count: 0,
      stalled_count: 0,
      error_count: 0,
      listened_content_seconds: 0,
      playback_wall_ms: 0,
      max_position_seconds: 0,
      last_position_seconds: 0,
      duration_seconds: null,
      first_play_at: null,
      last_play_at: null,
      last_pause_at: null,
      ended_at: null,
      played_to_end: false,
      playback_rate_events: [],
      volume_events: [],
      errors: [],
    };
  }

  function createSession() {
    const assignedAt = nowIso();
    const sessionId = core.makeUuid();
    const responses = {};
    room.questions.forEach((question) => {
      const choiceOrder = core.shuffleQuestionChoices(question, sessionId);
      responses[question.question_id] = {
        question_id: question.question_id,
        choice_order: choiceOrder,
        first_shown_at: null,
        last_shown_at: null,
        view_count: 0,
        active_ms: 0,
        selected_index: null,
        selected_label: null,
        first_selected_at: null,
        last_selected_at: null,
        selection_event_count: 0,
        answer_change_count: 0,
        selection_history: [],
        audio: newAudioMetrics(),
      };
    });

    return {
      response_schema_version: "1.0.0",
      study_version: dataset.study_version,
      question_bank_sha256: dataset.question_bank_sha256,
      dataset_fingerprint: fingerprint,
      participant_id: participantId,
      session_id: sessionId,
      room_id: room.room_id,
      room_sequence: requestedRoomSequence,
      room_index: roomIndex,
      room_count: rooms.length,
      room_size: dataset.room_size,
      question_ids: room.questions.map((question) => question.question_id),
      assigned_at: assignedAt,
      started_at: null,
      completed_at: null,
      submitted_at: null,
      updated_at: assignedAt,
      status: "assigned",
      current_index: 0,
      page_load_count: 1,
      resume_count: 0,
      lifecycle_events: [{ event: "assigned", at: assignedAt }],
      submission: {
        attempt_count: 0,
        last_attempt_at: null,
        last_error: null,
        receipt: null,
        server_response: null,
      },
      responses,
    };
  }

  function compatibleState(candidate) {
    if (!candidate || typeof candidate !== "object") return false;
    if (candidate.dataset_fingerprint !== fingerprint) return false;
    if (String(candidate.room_id) !== String(room.room_id)) return false;
    if (!candidate.responses || typeof candidate.responses !== "object") {
      return false;
    }
    return room.questions.every((question) =>
      Array.isArray(candidate.responses[question.question_id]?.choice_order)
    );
  }

  function loadOrCreateSession(forceFresh) {
    const encodedStudy = encodeURIComponent(dataset.study_version);
    const encodedRoom = encodeURIComponent(room.room_id);
    stateKey =
      `${config.storageNamespace}:session:${encodedStudy}:${fingerprint}:${encodedRoom}`;
    if (forceFresh) storageRemove(stateKey);

    const raw = storageGet(stateKey);
    if (raw) {
      try {
        const restored = JSON.parse(raw);
        if (compatibleState(restored)) {
          state = restored;
          state.page_load_count = Number(state.page_load_count || 1) + 1;
          if (state.status === "active" || state.status === "pending") {
            state.resume_count = Number(state.resume_count || 0) + 1;
            addLifecycleEvent("resumed", {
              page_load_count: state.page_load_count,
            });
          }
          persistState();
          return true;
        }
      } catch (_error) {
        // A malformed local copy is ignored and replaced with a fresh assignment.
      }
    }

    state = createSession();
    persistState();
    return false;
  }

  function currentQuestion() {
    return room?.questions[state?.current_index] || null;
  }

  function responseForQuestion(questionId) {
    return state?.responses?.[questionId] || null;
  }

  function currentResponse() {
    return runtime.questionId ? responseForQuestion(runtime.questionId) : null;
  }

  function choiceOrder(question, response) {
    const availableCounts = new Map();
    question.choices.forEach((choice) => {
      availableCounts.set(choice, (availableCounts.get(choice) || 0) + 1);
    });
    response.choice_order.forEach((choice) => {
      availableCounts.set(choice, (availableCounts.get(choice) || 0) - 1);
    });
    if (
      response.choice_order.length !== question.choices.length ||
      [...availableCounts.values()].some((count) => count !== 0)
    ) {
      throw new Error(
        `Saved choice order is invalid for question ${question.question_id}.`,
      );
    }
    return [...response.choice_order];
  }

  function beginActiveTime() {
    if (
      document.visibilityState === "visible" && runtime.questionId &&
      runtime.activeStartedAt == null
    ) {
      runtime.activeStartedAt = Date.now();
    }
  }

  function endActiveTime() {
    const response = currentResponse();
    if (response && runtime.activeStartedAt != null) {
      response.active_ms += Math.max(0, Date.now() - runtime.activeStartedAt);
    }
    runtime.activeStartedAt = null;
  }

  function beginPlaybackWall() {
    if (runtime.playWallStartedAt == null) {
      runtime.playWallStartedAt = Date.now();
    }
  }

  function endPlaybackWall() {
    const response = currentResponse();
    if (response && runtime.playWallStartedAt != null) {
      response.audio.playback_wall_ms += Math.max(
        0,
        Date.now() - runtime.playWallStartedAt,
      );
    }
    runtime.playWallStartedAt = null;
  }

  function closeQuestionTracking() {
    endActiveTime();
    endPlaybackWall();
    runtime.questionId = null;
    runtime.lastMediaTime = null;
    runtime.seekFrom = null;
    try {
      elements.audio.pause();
    } catch (_error) {
      // No action needed if the media element is not initialized.
    }
    persistState();
  }

  function resolveAudioUrl(audioUrl) {
    // Public-bank audio paths are rooted beside room.html (for example
    // "assets/<bank-sha>/q_....mp3"), not beside data/questions.json.
    const resolved = new URL(audioUrl, window.location.href);
    const allowed = ["https:", "http:"];
    if (window.location.protocol === "file:") allowed.push("file:");
    if (!allowed.includes(resolved.protocol)) {
      throw new Error(`Unsupported audio URL protocol for ${audioUrl}.`);
    }
    return resolved.href;
  }

  function renderQuestion(shouldFocus) {
    closeQuestionTracking();
    showView(elements.surveyView);
    const question = currentQuestion();
    const response = responseForQuestion(question.question_id);
    const orderedChoices = choiceOrder(question, response);
    const questionNumber = state.current_index + 1;
    const total = room.questions.length;
    const answered = room.questions.filter(
      (candidate) =>
        responseForQuestion(candidate.question_id).selected_index != null,
    ).length;

    elements.progressLabel.textContent =
      `Question ${questionNumber} of ${total}`;
    elements.answeredLabel.textContent = `${answered} answered`;
    elements.progressBar.max = total;
    elements.progressBar.value = questionNumber;
    elements.progressBar.textContent = `${questionNumber} of ${total}`;
    elements.previousButton.disabled = state.current_index === 0;
    elements.nextButton.textContent = questionNumber === total
      ? "Finish and submit"
      : "Next question";
    elements.choiceError.hidden = true;
    elements.audioMessage.textContent = "";

    elements.choicesList.replaceChildren();
    orderedChoices.forEach((choice, position) => {
      const label = document.createElement("label");
      label.className = "choice-label";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "genre-choice";
      input.value = String(position);
      input.checked = response.selected_index === position;
      input.setAttribute("aria-describedby", "choice-error");
      input.addEventListener("change", () => selectOption(position));

      const letter = document.createElement("span");
      letter.className = "choice-letter";
      letter.setAttribute("aria-hidden", "true");
      letter.textContent = String.fromCharCode(65 + position);

      const text = document.createElement("span");
      text.textContent = choice;

      label.append(input, letter, text);
      elements.choicesList.append(label);
    });

    runtime.questionId = question.question_id;
    runtime.lastMediaTime = null;
    runtime.seekFrom = null;
    runtime.playWallStartedAt = null;
    response.view_count = Number(response.view_count || 0) + 1;
    response.first_shown_at ||= nowIso();
    response.last_shown_at = nowIso();
    beginActiveTime();

    elements.audio.src = resolveAudioUrl(question.audio);
    elements.audio.load();
    persistState();
    document.title =
      `Question ${questionNumber} of ${total} · Genre listening test`;
    if (shouldFocus) elements.questionTitle.focus();
  }

  function selectOption(position) {
    const question = currentQuestion();
    const response = responseForQuestion(question.question_id);
    const selected = choiceOrder(question, response)[position];
    if (!selected) return;

    const previousIndex = response.selected_index;
    const selectedAt = nowIso();
    response.selection_event_count =
      Number(response.selection_event_count || 0) + 1;
    if (previousIndex != null && previousIndex !== position) {
      response.answer_change_count = Number(response.answer_change_count || 0) +
        1;
    }
    response.selected_index = position;
    response.selected_label = selected;
    response.first_selected_at ||= selectedAt;
    response.last_selected_at = selectedAt;
    response.selection_history.push({
      selected_at: selectedAt,
      selected_index: position,
      selected_label: selected,
      display_position: position + 1,
      audio_position_seconds: round(elements.audio.currentTime || 0),
      audio_play_count: response.audio.play_count,
      elapsed_since_first_show_ms: elapsedMs(
        response.first_shown_at,
        selectedAt,
      ),
    });
    elements.choiceError.hidden = true;
    elements.answeredLabel.textContent = `${
      room.questions.filter(
        (candidate) =>
          responseForQuestion(candidate.question_id).selected_index != null,
      ).length
    } answered`;
    persistState();
  }

  function navigateQuestion(delta) {
    const response = responseForQuestion(currentQuestion().question_id);
    if (delta > 0 && response.selected_index == null) {
      elements.choiceError.hidden = false;
      const firstInput = elements.choicesList.querySelector("input");
      if (firstInput) firstInput.focus();
      return;
    }

    if (delta > 0 && state.current_index === room.questions.length - 1) {
      finishQuestionnaire();
      return;
    }

    const nextIndex = state.current_index + delta;
    if (nextIndex < 0 || nextIndex >= room.questions.length) return;
    closeQuestionTracking();
    state.current_index = nextIndex;
    persistState();
    renderQuestion(true);
  }

  function allAnswered() {
    return room.questions.every(
      (question) =>
        responseForQuestion(question.question_id).selected_index != null,
    );
  }

  function startQuestionnaire() {
    state.started_at ||= nowIso();
    state.status = "active";
    addLifecycleEvent("started", { current_index: state.current_index });
    persistState();
    renderQuestion(true);
  }

  function finishQuestionnaire() {
    if (!allAnswered()) {
      const firstUnanswered = room.questions.findIndex(
        (question) =>
          responseForQuestion(question.question_id).selected_index == null,
      );
      if (firstUnanswered >= 0) {
        state.current_index = firstUnanswered;
        renderQuestion(true);
        elements.choiceError.hidden = false;
      }
      return;
    }

    closeQuestionTracking();
    state.completed_at ||= nowIso();
    state.status = "pending";
    addLifecycleEvent("completed", { answered_count: room.questions.length });
    persistState();
    submitResults(false);
  }

  function buildResponseRows(generatedAt) {
    const submittedAt = state.submitted_at || "";
    return room.questions.map((question, index) => {
      const response = responseForQuestion(question.question_id);
      const ordered = choiceOrder(question, response);
      const audio = response.audio;
      const row = {
        response_schema_version: state.response_schema_version,
        study_version: state.study_version,
        question_bank_sha256: state.question_bank_sha256,
        participant_id: state.participant_id,
        submission_id: state.session_id,
        room_id: state.room_id,
        room_sequence: state.room_sequence,
        room_index_zero_based: state.room_index,
        room_number_one_based: state.room_index + 1,
        room_count: state.room_count,
        room_size: state.room_size,
        question_id: question.question_id,
        question_position_one_based: index + 1,
        audio: question.audio,
        option_order_json: ordered,
        option_1_label: ordered[0],
        option_2_label: ordered[1],
        option_3_label: ordered[2],
        selected_index_zero_based: response.selected_index,
        selected_position_one_based: response.selected_index == null
          ? null
          : response.selected_index + 1,
        selected_label: response.selected_label,
        assigned_at: state.assigned_at,
        session_started_at: state.started_at || "",
        question_first_shown_at: response.first_shown_at || "",
        question_last_shown_at: response.last_shown_at || "",
        answer_first_selected_at: response.first_selected_at || "",
        answer_last_selected_at: response.last_selected_at || "",
        session_completed_at: state.completed_at || "",
        session_submitted_at: submittedAt,
        payload_generated_at: generatedAt,
        assignment_to_start_ms: elapsedMs(state.assigned_at, state.started_at),
        start_to_completion_ms: elapsedMs(state.started_at, state.completed_at),
        question_time_to_first_answer_ms: elapsedMs(
          response.first_shown_at,
          response.first_selected_at,
        ),
        question_time_to_final_answer_ms: elapsedMs(
          response.first_shown_at,
          response.last_selected_at,
        ),
        question_active_ms: Math.round(response.active_ms || 0),
        question_view_count: response.view_count,
        selection_event_count: response.selection_event_count,
        answer_change_count: response.answer_change_count,
        selection_history_json: response.selection_history,
        audio_play_count: audio.play_count,
        audio_pause_count: audio.pause_count,
        audio_ended_count: audio.ended_count,
        audio_replay_count: audio.replay_count,
        audio_seek_count: audio.seek_count,
        audio_seek_forward_seconds: round(audio.seek_forward_seconds),
        audio_seek_backward_seconds: round(audio.seek_backward_seconds),
        audio_waiting_count: audio.waiting_count,
        audio_stalled_count: audio.stalled_count,
        audio_error_count: audio.error_count,
        audio_listened_content_seconds: round(audio.listened_content_seconds),
        audio_playback_wall_ms: Math.round(audio.playback_wall_ms || 0),
        audio_max_position_seconds: round(audio.max_position_seconds),
        audio_last_position_seconds: round(audio.last_position_seconds),
        audio_duration_seconds: round(audio.duration_seconds),
        audio_fraction_reached: audio.duration_seconds > 0
          ? round(
            Math.min(1, audio.max_position_seconds / audio.duration_seconds),
            4,
          )
          : null,
        audio_first_play_at: audio.first_play_at || "",
        audio_last_play_at: audio.last_play_at || "",
        audio_last_pause_at: audio.last_pause_at || "",
        audio_ended_at: audio.ended_at || "",
        audio_played_to_end: audio.played_to_end,
        audio_playback_rate_events_json: audio.playback_rate_events,
        audio_volume_events_json: audio.volume_events,
        audio_errors_json: audio.errors,
        page_load_count: state.page_load_count,
        resume_count: state.resume_count,
        submission_attempt_count: state.submission.attempt_count,
        question_definition_json: {
          ...question,
          _input_index: undefined,
        },
        raw_question_response_json: response,
      };
      return row;
    });
  }

  function buildPayload() {
    return core.buildCollectorPayload(state, room, {
      consentVersion: config.consentVersion,
      appBuild: config.appBuild,
    });
  }

  function buildBackupBundle() {
    const generatedAt = nowIso();
    return {
      collector_payload: buildPayload(),
      generated_at: generatedAt,
      local_session: state,
      analysis_rows: buildResponseRows(generatedAt),
    };
  }

  function validSubmissionEndpoint() {
    const endpoint = String(config.submissionEndpoint || "").trim();
    if (!endpoint) {
      throw new Error(
        "No result collector is configured. Download a backup and ask the study owner to set submissionEndpoint in config.js.",
      );
    }
    const url = new URL(endpoint, window.location.href);
    const localHttp = url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) {
      throw new Error(
        "The result collector must use HTTPS (HTTP is allowed only on localhost).",
      );
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error(
        "The result collector URL must not contain credentials, a query, or a fragment.",
      );
    }
    return url.href;
  }

  async function postPayload(payload) {
    const endpoint = validSubmissionEndpoint();
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      Math.max(1000, Number(config.submissionTimeoutMs) || 15000),
    );
    const headers = { ...(config.submissionHeaders || {}) };
    let body;

    if (config.submissionFormat === "form") {
      headers["Content-Type"] ||=
        "application/x-www-form-urlencoded;charset=UTF-8";
      body = new URLSearchParams({
        submission_id: payload.submission_id,
        idempotency_key: payload.submission_id,
        payload: JSON.stringify(payload),
      }).toString();
    } else if (config.submissionFormat === "json") {
      headers["Content-Type"] ||= "application/json";
      body = JSON.stringify(payload);
    } else {
      throw new Error(
        `Unsupported submissionFormat: ${config.submissionFormat}.`,
      );
    }
    headers.Accept ||= "application/json, text/plain;q=0.9";

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          `The result collector returned HTTP ${response.status}${
            responseText ? `: ${responseText.slice(0, 240)}` : "."
          }`,
        );
      }
      let parsed = null;
      if (responseText) {
        try {
          parsed = JSON.parse(responseText);
        } catch (_error) {
          parsed = { message: responseText.slice(0, 2000) };
        }
      }
      return parsed || { ok: true };
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(
          "Submission timed out. Check your connection and try again.",
        );
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function submitResults(automatic) {
    if (submissionInFlight) return;
    submissionInFlight = true;
    showView(elements.submitView);
    elements.submitTitle.textContent = automatic
      ? "Retrying your submission…"
      : "Sending your answers…";
    elements.submitStatus.textContent =
      "Keep this page open until submission is confirmed.";

    const delays =
      Array.isArray(config.retryDelaysMs) && config.retryDelaysMs.length
        ? config.retryDelaysMs.map((delay) => Math.max(0, Number(delay) || 0))
        : [0];
    let lastError = null;

    for (let index = 0; index < delays.length; index += 1) {
      if (delays[index] > 0) {
        elements.submitStatus.textContent = `Connection issue. Retrying (${
          index + 1
        } of ${delays.length})…`;
        await wait(delays[index]);
      }
      state.submission.attempt_count =
        Number(state.submission.attempt_count || 0) + 1;
      state.submission.last_attempt_at = nowIso();
      addLifecycleEvent("submission_attempted", {
        attempt_count: state.submission.attempt_count,
        automatic: Boolean(automatic),
      });
      persistState();

      try {
        const receipt = await postPayload(buildPayload());
        state.status = "submitted";
        state.submitted_at = nowIso();
        state.submission.last_error = null;
        state.submission.receipt = receipt?.receipt_id ||
          receipt?.submission_id || receipt?.id || state.session_id;
        state.submission.server_response = receipt;
        markSequenceCompleted(state.room_sequence);
        addLifecycleEvent("submitted", { receipt: state.submission.receipt });
        persistState();
        submissionInFlight = false;
        showCompletion(true);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        state.submission.last_error = lastError.message;
        addLifecycleEvent("submission_failed", {
          attempt_count: state.submission.attempt_count,
          error: lastError.message,
        });
        persistState();
        if (!String(config.submissionEndpoint || "").trim()) break;
      }
    }

    state.status = "pending";
    persistState();
    submissionInFlight = false;
    showCompletion(
      false,
      lastError?.message || "Submission failed. Please try again.",
    );
  }

  function showCompletion(succeeded, errorMessage) {
    closeQuestionTracking();
    showView(elements.completeView);
    elements.participantCode.textContent = state.participant_id;
    elements.submissionCode.textContent = state.submission.receipt ||
      state.session_id;
    elements.finishedMessage.hidden = true;

    if (succeeded) {
      elements.completionIcon.textContent = "✓";
      elements.completionIcon.classList.remove("completion-icon--error");
      elements.completeTitle.textContent = "Thank you for listening";
      elements.completeMessage.textContent =
        `Your ${room.questions.length} answers were received successfully.`;
      elements.retryPanel.hidden = true;
      elements.anotherPanel.hidden = false;
      document.title = "Answers received · Genre listening test";
    } else {
      elements.completionIcon.textContent = "!";
      elements.completionIcon.classList.add("completion-icon--error");
      elements.completeTitle.textContent =
        "Your answers are saved, but not sent";
      elements.completeMessage.textContent =
        "Nothing has been lost. Keep this page open and retry when your connection is available.";
      elements.retryMessage.textContent = errorMessage ||
        state.submission.last_error || "Submission failed.";
      elements.retryPanel.hidden = false;
      elements.anotherPanel.hidden = true;
      document.title = "Submission needs attention · Genre listening test";
    }
  }

  function downloadBlob(contents, mimeType, extension) {
    const blob = new Blob([contents], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `genre-listening-${state.session_id}.${extension}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadJsonBackup() {
    downloadBlob(
      `${JSON.stringify(buildBackupBundle(), null, 2)}\n`,
      "application/json;charset=utf-8",
      "json",
    );
  }

  function downloadCsvBackup() {
    const rows = buildResponseRows(nowIso());
    downloadBlob(
      `\ufeff${core.rowsToCsv(rows)}`,
      "text/csv;charset=utf-8",
      "csv",
    );
  }

  function goToNextRoom() {
    const roomIds = rooms.map((candidate) => candidate.room_id);
    const nextRoom = core.nextRoomId(roomIds, room.room_id);
    const target = new URL("./room.html", window.location.href);
    target.searchParams.set("room", nextRoom);
    target.searchParams.set("fresh", "1");
    target.searchParams.set(
      "sequence",
      String(Number(state.room_sequence) + 1),
    );
    window.location.assign(target.href);
  }

  function bindControls() {
    elements.startButton.addEventListener("click", startQuestionnaire);
    elements.previousButton.addEventListener(
      "click",
      () => navigateQuestion(-1),
    );
    elements.nextButton.addEventListener("click", () => navigateQuestion(1));
    elements.retrySubmitButton.addEventListener(
      "click",
      () => submitResults(false),
    );
    elements.downloadJsonButton.addEventListener("click", downloadJsonBackup);
    elements.downloadCsvButton.addEventListener("click", downloadCsvBackup);
    elements.anotherButton.addEventListener("click", goToNextRoom);
    elements.finishButton.addEventListener("click", () => {
      elements.anotherButton.hidden = true;
      elements.finishButton.hidden = true;
      elements.finishedMessage.hidden = false;
    });

    document.addEventListener("visibilitychange", () => {
      if (!runtime.questionId) return;
      if (document.visibilityState === "hidden") {
        endActiveTime();
        persistState();
      } else {
        beginActiveTime();
      }
    });
    window.addEventListener("pagehide", () => {
      endActiveTime();
      endPlaybackWall();
      persistState();
    });
    window.addEventListener("online", () => {
      if (state?.status === "pending" && !submissionInFlight) {
        submitResults(true);
      }
    });

    bindAudioMetrics();
  }

  function bindAudioMetrics() {
    const audioElement = elements.audio;

    audioElement.addEventListener("loadedmetadata", () => {
      const response = currentResponse();
      if (!response) return;
      response.audio.duration_seconds = Number.isFinite(audioElement.duration)
        ? audioElement.duration
        : null;
      elements.audioMessage.textContent = "";
      persistState();
    });

    audioElement.addEventListener("play", () => {
      const response = currentResponse();
      if (!response) return;
      const metrics = response.audio;
      if (metrics.play_count > 0 && audioElement.currentTime < 0.75) {
        metrics.replay_count += 1;
      }
      metrics.play_count += 1;
      metrics.first_play_at ||= nowIso();
      metrics.last_play_at = nowIso();
      runtime.lastMediaTime = audioElement.currentTime;
      beginPlaybackWall();
      persistState();
    });

    audioElement.addEventListener("pause", () => {
      const response = currentResponse();
      if (!response) return;
      response.audio.pause_count += 1;
      response.audio.last_pause_at = nowIso();
      endPlaybackWall();
      runtime.lastMediaTime = null;
      persistState();
    });

    audioElement.addEventListener("ended", () => {
      const response = currentResponse();
      if (!response) return;
      response.audio.ended_count += 1;
      response.audio.ended_at = nowIso();
      response.audio.played_to_end = true;
      response.audio.max_position_seconds = Math.max(
        response.audio.max_position_seconds,
        Number.isFinite(audioElement.duration)
          ? audioElement.duration
          : audioElement.currentTime,
      );
      endPlaybackWall();
      runtime.lastMediaTime = null;
      persistState();
    });

    audioElement.addEventListener("timeupdate", () => {
      const response = currentResponse();
      if (!response) return;
      const current = audioElement.currentTime || 0;
      const previous = runtime.lastMediaTime;
      if (!audioElement.seeking && !audioElement.paused && previous != null) {
        const delta = current - previous;
        if (delta >= 0 && delta <= 3) {
          response.audio.listened_content_seconds += delta;
        }
      }
      runtime.lastMediaTime = current;
      response.audio.last_position_seconds = current;
      response.audio.max_position_seconds = Math.max(
        response.audio.max_position_seconds,
        current,
      );
      if (Date.now() - runtime.lastTimeupdateSave > 1200) {
        runtime.lastTimeupdateSave = Date.now();
        persistState();
      }
    });

    audioElement.addEventListener("seeking", () => {
      if (!currentResponse()) return;
      if (runtime.seekFrom == null) {
        runtime.seekFrom = runtime.lastMediaTime ?? audioElement.currentTime;
      }
    });

    audioElement.addEventListener("seeked", () => {
      const response = currentResponse();
      if (!response) return;
      const destination = audioElement.currentTime || 0;
      const origin = runtime.seekFrom == null ? destination : runtime.seekFrom;
      const delta = destination - origin;
      response.audio.seek_count += 1;
      if (delta > 0) response.audio.seek_forward_seconds += delta;
      if (delta < 0) response.audio.seek_backward_seconds += Math.abs(delta);
      runtime.seekFrom = null;
      runtime.lastMediaTime = destination;
      persistState();
    });

    audioElement.addEventListener("waiting", () => {
      const response = currentResponse();
      if (response) response.audio.waiting_count += 1;
    });

    audioElement.addEventListener("stalled", () => {
      const response = currentResponse();
      if (response) response.audio.stalled_count += 1;
    });

    audioElement.addEventListener("ratechange", () => {
      const response = currentResponse();
      if (!response) return;
      response.audio.playback_rate_events.push({
        at: nowIso(),
        rate: audioElement.playbackRate,
      });
      persistState();
    });

    audioElement.addEventListener("volumechange", () => {
      const response = currentResponse();
      if (!response) return;
      response.audio.volume_events.push({
        at: nowIso(),
        volume: round(audioElement.volume),
        muted: audioElement.muted,
      });
      persistState();
    });

    audioElement.addEventListener("error", () => {
      const response = currentResponse();
      if (!response) return;
      const mediaError = audioElement.error;
      const error = {
        at: nowIso(),
        code: mediaError?.code || null,
        message: mediaError?.message || "Audio could not be loaded.",
        network_state: audioElement.networkState,
        ready_state: audioElement.readyState,
      };
      response.audio.error_count += 1;
      response.audio.errors.push(error);
      elements.audioMessage.textContent =
        "This clip could not be loaded. Check your connection, then reload the page.";
      persistState();
    });
  }

  async function boot() {
    bindControls();
    updateSaveIndicator();
    try {
      manifestUrl = new URL(config.questionsUrl, window.location.href);
      const response = await fetch(manifestUrl.href, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`The question list returned HTTP ${response.status}.`);
      }
      dataset = core.normalizeDataset(await response.json(), config);
      rooms = core.buildRooms(dataset);
      if (rooms.length === 0) {
        throw new Error("No questionnaire rooms are configured yet.");
      }
      fingerprint = core.datasetFingerprint(dataset);

      const parameters = new URLSearchParams(window.location.search);
      const requestedRoom = parameters.get("room");
      if (requestedRoom == null) {
        throw new Error(
          "No room was selected. Please enter through the master link.",
        );
      }
      const numericRoom = Number(requestedRoom);
      if (!Number.isInteger(numericRoom) || numericRoom < 0) {
        throw new Error(`Invalid room identifier: ${requestedRoom}.`);
      }
      roomIndex = rooms.findIndex((candidate) =>
        candidate.room_id === numericRoom
      );
      if (roomIndex < 0) {
        throw new Error(
          `Room ${requestedRoom} does not exist in this question set.`,
        );
      }
      room = rooms[roomIndex];
      participantId = getParticipantId();
      const sequenceParameter = parameters.get("sequence");
      const parsedSequence = sequenceParameter == null
        ? storedRoomSequence()
        : Number(sequenceParameter);
      requestedRoomSequence =
        Number.isInteger(parsedSequence) && parsedSequence >= 0
          ? parsedSequence
          : storedRoomSequence();
      let restored = loadOrCreateSession(parameters.get("fresh") === "1");
      if (parameters.get("from") === "master" && state.status === "submitted") {
        requestedRoomSequence = storedRoomSequence();
        restored = loadOrCreateSession(true);
      }

      if (state.status === "submitted") {
        showCompletion(true);
      } else if (state.status === "pending") {
        showCompletion(false, state.submission.last_error);
        if (
          String(config.submissionEndpoint || "").trim() && navigator.onLine
        ) {
          window.setTimeout(() => submitResults(true), 250);
        }
      } else {
        elements.resumeNote.hidden = !(restored && state.started_at);
        elements.startButton.textContent = restored && state.started_at
          ? "Resume listening"
          : "Start listening";
        showView(elements.introView);
        elements.startButton.focus();
      }
    } catch (error) {
      showFatal(error);
    }
  }

  boot();
})();
