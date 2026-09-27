(function runMasterRedirect() {
  "use strict";

  const status = document.getElementById("redirect-status");
  const indicator = document.getElementById("loading-indicator");
  const errorBox = document.getElementById("redirect-error");
  const errorMessage = document.getElementById("redirect-error-message");
  const retryButton = document.getElementById("retry-button");

  function showError(message) {
    status.textContent = "We could not assign a questionnaire.";
    indicator.hidden = true;
    errorMessage.textContent = message;
    errorBox.hidden = false;
    retryButton.focus();
  }

  async function assignRoom() {
    const core = window.ListeningTestCore;
    const config = window.LISTENING_TEST_CONFIG || {};
    errorBox.hidden = true;
    indicator.hidden = false;
    status.textContent = "Assigning a questionnaire at random…";

    try {
      const response = await fetch(
        config.questionsUrl || "./data/questions.json",
        {
          cache: "no-store",
          headers: { Accept: "application/json" },
        },
      );
      if (!response.ok) {
        throw new Error(`The question list returned HTTP ${response.status}.`);
      }
      const raw = await response.json();
      const dataset = core.normalizeDataset(raw, config);
      const rooms = core.buildRooms(dataset);
      if (rooms.length === 0) {
        throw new Error("No questionnaire rooms are configured yet.");
      }

      const selected = rooms[core.randomIndex(rooms.length)];
      const target = new URL("./room.html", window.location.href);
      target.searchParams.set("room", selected.room_id);
      target.searchParams.set("from", "master");
      window.location.replace(target.href);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Please try again.");
    }
  }

  retryButton.addEventListener("click", assignRoom);
  assignRoom();
})();
