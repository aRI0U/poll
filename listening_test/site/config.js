// Public runtime configuration for the static listening-test client.
// Do not place API secrets here: everything in this file is visible to visitors.
window.LISTENING_TEST_CONFIG = Object.freeze({
  questionsUrl: "./data/questions.json",
  roomSize: 10,
  consentVersion: "1",
  appBuild: "2026-09-28.2",

  // Set this to the HTTPS collector URL before deployment. The collector should
  // treat submission_id as an idempotency key and return a 2xx response on success.
  submissionEndpoint: "",

  // "json" posts the complete payload as application/json. "form" posts the
  // same JSON string in a form field named payload (useful for Apps Script).
  submissionFormat: "json",
  submissionHeaders: {},
  submissionTimeoutMs: 15000,
  retryDelaysMs: [0, 1500, 4000],

  storageNamespace: "genre-listening-test-v1",
});
