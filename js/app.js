window.MT = window.MT || {};

(function () {
  const $ = (sel) => document.querySelector(sel);

  let state = null;
  let currentChar = null;
  let currentMorse = "";
  let userBuffer = "";
  let promptStartTime = 0;
  let inputLocked = true;       // locked during playback / between prompts
  let lastChar = null;
  let evaluating = false;
  let started = false;          // user has clicked Start (unlocks audio)
  let promptToken = 0;          // increments to invalidate stale async prompts

  // ---- init ---------------------------------------------------------------

  function init() {
    state = MT.SRS.load();
    applySettingsToUI();
    applySettingsToAudio();
    bindUI();
    bindKeys();
    renderProgressTable();
    showStartOverlay();
  }

  function showStartOverlay() {
    const overlay = $("#startOverlay");
    overlay.hidden = false;
    overlay.querySelector("button").focus();
  }

  function hideStartOverlay() {
    $("#startOverlay").hidden = true;
  }

  function applySettingsToAudio() {
    const s = state.settings;
    MT.Audio.setWPM(s.wpm);
    MT.Audio.setFarnsworth(s.farnsworthWpm);
    MT.Audio.setFrequency(s.frequencyHz);
  }

  function applySettingsToUI() {
    const s = state.settings;
    $("#wpm").value = s.wpm;
    $("#wpmVal").textContent = s.wpm;
    $("#farnsworthWpm").value = s.farnsworthWpm;
    $("#farnsworthVal").textContent = s.farnsworthWpm;
    $("#freq").value = s.frequencyHz;
    $("#freqVal").textContent = s.frequencyHz;
    $("#speakLetter").checked = !!s.speakLetter;
    $("#audioAid").value = s.audioAid;
    $("#visualAid").value = s.visualAid;
    $("#ditKey").value = s.ditKey;
    $("#dahKey").value = s.dahKey;
  }

  // ---- UI binding ---------------------------------------------------------

  function bindUI() {
    $("#wpm").addEventListener("input", (e) => {
      const v = parseInt(e.target.value, 10);
      state.settings.wpm = v;
      $("#wpmVal").textContent = v;
      MT.Audio.setWPM(v);
      if (state.settings.farnsworthWpm > v) {
        state.settings.farnsworthWpm = v;
        $("#farnsworthWpm").value = v;
        $("#farnsworthVal").textContent = v;
        MT.Audio.setFarnsworth(v);
      }
      MT.SRS.save();
    });
    $("#farnsworthWpm").addEventListener("input", (e) => {
      let v = parseInt(e.target.value, 10);
      if (v > state.settings.wpm) v = state.settings.wpm;
      state.settings.farnsworthWpm = v;
      $("#farnsworthVal").textContent = v;
      MT.Audio.setFarnsworth(v);
      MT.SRS.save();
    });
    $("#freq").addEventListener("input", (e) => {
      const v = parseInt(e.target.value, 10);
      state.settings.frequencyHz = v;
      $("#freqVal").textContent = v;
      MT.Audio.setFrequency(v);
      MT.SRS.save();
    });
    $("#speakLetter").addEventListener("change", (e) => {
      state.settings.speakLetter = e.target.checked; MT.SRS.save();
    });
    $("#audioAid").addEventListener("change", (e) => {
      state.settings.audioAid = e.target.value; MT.SRS.save(); refreshAidStatus();
    });
    $("#visualAid").addEventListener("change", (e) => {
      state.settings.visualAid = e.target.value; MT.SRS.save(); refreshAidStatus();
    });
    $("#ditKey").addEventListener("change", (e) => {
      state.settings.ditKey = (e.target.value || "[")[0]; MT.SRS.save();
      $("#ditKey").value = state.settings.ditKey;
    });
    $("#dahKey").addEventListener("change", (e) => {
      state.settings.dahKey = (e.target.value || "]")[0]; MT.SRS.save();
      $("#dahKey").value = state.settings.dahKey;
    });

    $("#replay").addEventListener("click", () => playCurrent());
    $("#skip").addEventListener("click", () => nextPrompt());
    $("#reset").addEventListener("click", () => {
      if (confirm("Reset all progress? This wipes saved stats and active characters.")) {
        state = MT.SRS.reset();
        applySettingsToUI();
        applySettingsToAudio();
        renderProgressTable();
        nextPrompt();
      }
    });

    $("#startOverlay button").addEventListener("click", () => {
      MT.Audio.ensureCtx();      // unlock audio under user gesture
      started = true;
      hideStartOverlay();
      nextPrompt();
    });
  }

  // ---- keyboard input -----------------------------------------------------

  function bindKeys() {
    document.addEventListener("keydown", (e) => {
      // ignore typing into form fields
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;

      // start overlay: any key dismisses it
      if (!started) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          $("#startOverlay button").click();
        }
        return;
      }

      const key = e.key;
      const dit = state.settings.ditKey;
      const dah = state.settings.dahKey;

      if (key === dit) {
        e.preventDefault();
        if (!inputLocked) appendSymbol(".");
      } else if (key === dah) {
        e.preventDefault();
        if (!inputLocked) appendSymbol("-");
      } else if (key === "Backspace") {
        e.preventDefault();
        if (!inputLocked && userBuffer.length) {
          userBuffer = userBuffer.slice(0, -1);
          renderBuffer();
        }
      } else if (key === "Enter" || key === " ") {
        e.preventDefault();
        if (!inputLocked && userBuffer.length) evaluate();
      } else if (key === "r" || key === "R") {
        e.preventDefault();
        playCurrent();
      } else if (key === "n" || key === "N") {
        e.preventDefault();
        nextPrompt();
      }
    });
  }

  function appendSymbol(sym) {
    if (!currentMorse) return;
    userBuffer += sym;
    renderBuffer();

    if (!currentMorse.startsWith(userBuffer)) {
      // wrong already; mark and evaluate
      $("#buffer").classList.add("wrong-prefix");
      evaluate();
    } else if (userBuffer.length === currentMorse.length) {
      evaluate();
    }
  }

  // ---- prompt cycle -------------------------------------------------------

  async function nextPrompt() {
    promptToken++;
    const myToken = promptToken;
    MT.Audio.stop();
    inputLocked = true;
    evaluating = false;
    userBuffer = "";
    renderBuffer();
    $("#feedback").textContent = "";
    $("#feedback").className = "feedback";

    currentChar = MT.SRS.pickNextChar(lastChar);
    if (!currentChar) {
      $("#prompt").textContent = "—";
      currentMorse = "";
      return;
    }
    lastChar = currentChar;
    currentMorse = MT.charToMorse(currentChar);

    renderPrompt();

    // Optional: speak the letter first.
    if (state.settings.speakLetter) {
      await MT.Audio.speakLetter(currentChar);
      if (myToken !== promptToken) return;
    }

    // Audio aid: play the morse if adaptive thresholds say so.
    if (MT.SRS.shouldUseAudioAid(currentChar)) {
      await MT.Audio.playMorse(currentMorse);
      if (myToken !== promptToken) return;
    }

    promptStartTime = performance.now();
    inputLocked = false;
  }

  function renderPrompt() {
    $("#prompt").textContent = MT.displayLabel(currentChar);
    const visAid = MT.SRS.shouldUseVisualAid(currentChar);
    $("#morseVisual").textContent = visAid ? formatMorseVisual(currentMorse) : "";
    $("#morseVisual").classList.toggle("hidden-aid", !visAid);
    refreshAidStatus();
  }

  function refreshAidStatus() {
    if (!currentChar) { $("#aidStatus").textContent = ""; return; }
    const aud = MT.SRS.shouldUseAudioAid(currentChar) ? "audio: on" : "audio: off";
    const vis = MT.SRS.shouldUseVisualAid(currentChar) ? "visual: on" : "visual: off";
    const acc = Math.round(MT.SRS.recentAccuracy(currentChar) * 100);
    $("#aidStatus").textContent = `${aud} · ${vis} · recent ${acc}%`;
  }

  function formatMorseVisual(s) {
    return s
      .split("")
      .map((c) => (c === "." ? "·" : c === "-" ? "−" : c))
      .join("  ");
  }

  function playCurrent() {
    if (!currentMorse) return;
    MT.Audio.playMorse(currentMorse);
  }

  function renderBuffer() {
    const div = $("#buffer");
    div.classList.remove("wrong-prefix");
    div.textContent = userBuffer.length
      ? userBuffer.split("").map((c) => (c === "." ? "·" : "−")).join("  ")
      : " ";
  }

  function evaluate() {
    if (evaluating) return;
    evaluating = true;
    inputLocked = true;
    const correct = userBuffer === currentMorse;
    const elapsed = performance.now() - promptStartTime;
    MT.SRS.recordAttempt(currentChar, correct, elapsed);
    showFeedback(correct);
    renderProgressTable();
    MT.Audio.blip(correct);
    setTimeout(nextPrompt, correct ? 600 : 1400);
  }

  function showFeedback(correct) {
    const fb = $("#feedback");
    if (correct) {
      fb.textContent = `✓  ${MT.displayLabel(currentChar)}   ${formatMorseVisual(currentMorse)}`;
      fb.className = "feedback ok";
    } else {
      const got = userBuffer ? formatMorseVisual(userBuffer) : "(nothing)";
      fb.textContent = `✗  you sent ${got}   →   ${MT.displayLabel(currentChar)} is ${formatMorseVisual(currentMorse)}`;
      fb.className = "feedback bad";
    }
  }

  // ---- progress panel -----------------------------------------------------

  function renderProgressTable() {
    const wrap = $("#progress");
    if (!wrap) return;

    const headerRow = `<tr>
      <th>ch</th><th>morse</th><th>trials</th><th>recent</th><th>lifetime</th><th>aids</th>
    </tr>`;

    const rows = state.activeChars.map((ch) => {
      const p = state.progress[ch] || { trials: 0, correct: 0, recent: [] };
      const rec = p.recent.length ? Math.round(MT.SRS.recentAccuracy(ch) * 100) : null;
      const life = p.trials ? Math.round((p.correct / p.trials) * 100) : null;
      const aud = MT.SRS.shouldUseAudioAid(ch);
      const vis = MT.SRS.shouldUseVisualAid(ch);
      const aidLabel = aud || vis
        ? `${aud ? "🔊" : ""}${vis ? "👁" : ""}`
        : "<span class='muted'>off</span>";
      return `<tr>
        <td><b>${escapeHtml(MT.displayLabel(ch))}</b></td>
        <td><code>${formatMorseVisual(MT.charToMorse(ch))}</code></td>
        <td>${p.trials}</td>
        <td>${rec === null ? "—" : rec + "%"}</td>
        <td>${life === null ? "—" : life + "%"}</td>
        <td title="audio aid · visual aid">${aidLabel}</td>
      </tr>`;
    }).join("");

    const remaining = MT.KOCH_ORDER.length - state.activeChars.length;
    wrap.innerHTML = `
      <table>
        <thead>${headerRow}</thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="meta">
        active ${state.activeChars.length} · remaining in Koch ${remaining} · attempts ${state.stats.totalAttempts || 0}
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---- boot ---------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
