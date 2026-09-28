// Public runtime configuration for the static listening-test client.
// Do not place API secrets here: everything in this file is visible to visitors.
window.LISTENING_TEST_CONFIG = Object.freeze({
  questionsUrl: "./data/questions.json",
  roomSize: 10,
  consentVersion: "1",
  appBuild: "2026-09-28.3",

  // The Pages workflow injects the public Google Apps Script /exec URL here.
  // The script must treat submission_id as an idempotency key.
  submissionEndpoint: "",

  // Apps Script is called through a hidden form/iframe and acknowledges a
  // successful Sheet write with a nonce-bound postMessage.
  submissionFormat: "google_apps_script",
  submissionTimeoutMs: 30000,
  retryDelaysMs: [0, 2000, 6000],

  storageNamespace: "genre-listening-test-v1",
});
