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
  let advanceTimer = null;      // setTimeout id for auto-advance after evaluate()

  // AIDEV-NOTE: Iambic keyer state. Holding a paddle generates dits/dahs at the
  // trainer's WPM (not the OS typematic rate); squeezing both alternates. See
  // CLAUDE.md → "Iambic keyer" for the design rationale and Mode A semantics.
  let ditDown = false;
  let dahDown = false;
  let lastElement = null;       // "." | "-" | null — last element emitted, for squeeze alternation
  let keyerRunning = false;
  let keyerTimer = null;        // setTimeout id for the next keyer decision

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
    $("#iambic").checked = !!s.iambicMode;
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
    $("#iambic").addEventListener("change", (e) => {
      state.settings.iambicMode = e.target.checked;
      MT.SRS.save();
      // Any in-flight keyer state belongs to the prior mode; clear it so the new
      // mode starts from a clean slate.
      resetKeyer();
    });
    $("#ditKey").addEventListener("change", (e) => updateKeyBinding("ditKey", e.target.value));
    $("#dahKey").addEventListener("change", (e) => updateKeyBinding("dahKey", e.target.value));

    $("#replay").addEventListener("click", triggerReplay);
    $("#skip").addEventListener("click", () => nextPrompt());

    // Touch paddles drive the same iambic keyer as the keyboard. pointerdown/up
    // toggle the corresponding paddle flag; setPointerCapture keeps pointerup
    // firing even if the finger slides off the button. The click handler covers
    // keyboard activation (Tab + Space/Enter on the focused paddle): a
    // synchronous down→up emits exactly one element via the keyer's first
    // synchronous tick.
    function bindPaddle(id, onDown, onUp) {
      const btn = $("#" + id);
      if (!btn) return;
      let handled = false;
      btn.addEventListener("pointerdown", (e) => {
        if (!started || inputLocked) return;
        e.preventDefault();
        handled = true;
        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        onDown();
        btn.blur();   // don't leave focus on the paddle so keyboard play continues to work
      });
      btn.addEventListener("pointerup", () => { onUp(); });
      btn.addEventListener("pointercancel", () => { onUp(); });
      btn.addEventListener("click", () => {
        if (handled) { handled = false; return; }
        if (!started || inputLocked) return;
        onDown();
        onUp();
      });
    }
    bindPaddle("ditButton",
      () => {
        if (state.settings.iambicMode) { ditDown = true; startKeyerIfNeeded(); }
        else { appendSymbol("."); }
      },
      () => { ditDown = false; },
    );
    bindPaddle("dahButton",
      () => {
        if (state.settings.iambicMode) { dahDown = true; startKeyerIfNeeded(); }
        else { appendSymbol("-"); }
      },
      () => { dahDown = false; },
    );
    $("#reset").addEventListener("click", () => {
      if (confirm("Reset all progress? This wipes saved stats and active characters.")) {
        state = MT.SRS.reset();
        applySettingsToUI();
        applySettingsToAudio();
        renderProgressTable();
        nextPrompt();
      }
    });

    function updateKeyBinding(field, raw) {
      const previous = state.settings[field];
      const candidate = typeof raw === "string" && raw.length ? raw[0] : "";
      const otherField = field === "ditKey" ? "dahKey" : "ditKey";
      const valid = MT.SRS.isValidKeyChar(candidate) && candidate !== state.settings[otherField];
      const final = valid ? candidate : previous;
      state.settings[field] = final;
      $("#" + field).value = final;
      MT.SRS.save();
      // If a paddle is held when its binding changes, the future keyup will be
      // for the *old* key and won't match the new ditKey/dahKey, leaving the
      // flag stuck. Reset to keep state consistent with the new binding.
      if (final !== previous) resetKeyer();
      const status = $("#keyBindingStatus");
      if (status) {
        if (!valid && raw) {
          status.textContent = `Rejected — must be a single non-reserved character, distinct from the other paddle.`;
          status.classList.add("bad");
        } else {
          status.textContent = "";
          status.classList.remove("bad");
        }
      }
    }

    $("#startOverlay button").addEventListener("click", () => {
      MT.Audio.ensureCtx();      // unlock audio under user gesture
      started = true;
      hideStartOverlay();
      nextPrompt();
    });
  }

  // ---- keyboard input -----------------------------------------------------

  // AIDEV-NOTE: Anything that handles its own activation keys natively must be
  // exempt — otherwise pressing Space on a focused button or Enter on a focused
  // <summary> would be eaten by our handler and the user couldn't activate it.
  function isInteractiveTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (tag === "button" || tag === "summary" || tag === "a") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function bindKeys() {
    document.addEventListener("keydown", (e) => {
      if (isInteractiveTarget(e.target)) return;

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
        if (e.repeat) return;        // OS auto-repeat is suppressed regardless of iambic mode
        if (inputLocked) return;
        if (state.settings.iambicMode) {
          ditDown = true;
          startKeyerIfNeeded();
        } else {
          appendSymbol(".");          // straight-key style: one element per press
        }
      } else if (key === dah) {
        e.preventDefault();
        if (e.repeat) return;
        if (inputLocked) return;
        if (state.settings.iambicMode) {
          dahDown = true;
          startKeyerIfNeeded();
        } else {
          appendSymbol("-");
        }
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
        triggerReplay();
      } else if (key === "n" || key === "N") {
        e.preventDefault();
        nextPrompt();
      }
    });

    // Track paddle release for the iambic keyer. Not gated on isInteractiveTarget
    // or `started` — keyup is purely a "sync state to physical reality" hook,
    // and clearing an already-false flag is harmless.
    document.addEventListener("keyup", (e) => {
      if (e.key === state.settings.ditKey) {
        ditDown = false;
      } else if (e.key === state.settings.dahKey) {
        dahDown = false;
      }
    });
  }

  // ---- iambic keyer -------------------------------------------------------

  // Mode A: at each decision point, look at current paddle state. If both held,
  // alternate from lastElement; if one held, repeat that paddle; if neither,
  // exit. The first element fires synchronously on initial press for
  // tap-responsiveness; subsequent elements are paced by the trainer's WPM.
  function scheduleNextElement() {
    if (inputLocked) { keyerRunning = false; return; }

    let next;
    if (ditDown && dahDown) {
      next = lastElement === "." ? "-" : ".";
    } else if (ditDown) {
      next = ".";
    } else if (dahDown) {
      next = "-";
    } else {
      keyerRunning = false;
      return;
    }

    keyerRunning = true;
    lastElement = next;
    appendSymbol(next);

    // appendSymbol may trigger evaluate() (buffer match or divergence), which
    // calls resetKeyer() and sets inputLocked. In that case, bail out without
    // scheduling another tick.
    if (inputLocked) return;

    const unit = 1200 / MT.Audio.getCharWpm();
    const elementMs = next === "." ? unit : 3 * unit;
    const gap = unit;
    keyerTimer = setTimeout(() => {
      keyerTimer = null;
      scheduleNextElement();
    }, elementMs + gap);
  }

  function startKeyerIfNeeded() {
    if (keyerRunning) return;
    if (inputLocked) return;
    scheduleNextElement();
  }

  function resetKeyer() {
    if (keyerTimer !== null) {
      clearTimeout(keyerTimer);
      keyerTimer = null;
    }
    keyerRunning = false;
    ditDown = false;
    dahDown = false;
    lastElement = null;
  }

  function appendSymbol(sym) {
    if (!currentMorse) return;
    MT.Audio.playSymbol(sym);
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

  function clearAdvanceTimer() {
    if (advanceTimer !== null) {
      clearTimeout(advanceTimer);
      advanceTimer = null;
    }
  }

  async function nextPrompt() {
    promptToken++;
    const myToken = promptToken;
    clearAdvanceTimer();
    MT.Audio.stop();
    resetKeyer();
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

    // Audio aid: play the morse if adaptive thresholds say so. Input stays
    // locked only while the audio is actually playing — once it finishes the
    // user can key immediately (no hidden post-prompt lockout).
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
    const morseVisual = $("#morseVisual");
    morseVisual.textContent = visAid ? formatMorseVisual(currentMorse) : "";
    morseVisual.classList.toggle("hidden-aid", !visAid);
    morseVisual.classList.remove("wrong-answer");   // clear any leftover red from the previous prompt
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

  // Pronounceable form for the aria-live feedback ("dah dit dah") so screen
  // readers get the answer, not just the visual symbols in #morseVisual.
  function morseSpoken(s) {
    return s
      .split("")
      .map((c) => (c === "." ? "dit" : c === "-" ? "dah" : c))
      .join(" ");
  }

  function playCurrent() {
    if (!currentMorse) return;
    MT.Audio.playMorse(currentMorse);
  }

  // Single entry point for "replay the current prompt". If a post-evaluate
  // auto-advance is pending, the user is staying with the current prompt to
  // hear it again — cancel the auto-advance so the replay isn't cut off.
  // resetKeyer() so any in-flight keying doesn't leak its sidetone into the
  // replay; the user must release-and-repress to resume keying afterwards.
  function triggerReplay() {
    if (advanceTimer !== null) clearAdvanceTimer();
    resetKeyer();
    playCurrent();
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
    resetKeyer();
    const correct = userBuffer === currentMorse;
    const elapsed = performance.now() - promptStartTime;
    MT.SRS.recordAttempt(currentChar, correct, elapsed);
    showFeedback(correct);
    renderProgressTable();
    MT.Audio.blip(correct);
    // The Farnsworth gap is applied here, BEFORE the next prompt appears — so
    // by the time a new letter is shown the user can key immediately. We only
    // add it when audio actually played for this prompt: cadence training has
    // no meaning in letter-only mode (where mastered chars run silently and the
    // user is doing pure recall, not copy).
    clearAdvanceTimer();
    const baseDelay = correct ? 600 : 1400;
    const audioWasOn = MT.SRS.shouldUseAudioAid(currentChar);
    const fwGap = audioWasOn ? Math.round(MT.Audio.farnsworthGapMs()) : 0;
    advanceTimer = setTimeout(() => {
      advanceTimer = null;
      nextPrompt();
    }, baseDelay + fwGap);
  }

  function showFeedback(correct) {
    const fb = $("#feedback");
    const morseVisual = $("#morseVisual");
    if (correct) {
      fb.textContent = `✓  ${MT.displayLabel(currentChar)}`;
      fb.className = "feedback ok";
    } else {
      // Surface the correct morse where the visual aid normally lives, in red.
      // Works whether or not the aid was on for this prompt — when wrong, the
      // user needs to see the answer regardless of mastery state.
      morseVisual.textContent = formatMorseVisual(currentMorse);
      morseVisual.classList.remove("hidden-aid");
      morseVisual.classList.add("wrong-answer");
      // The morseVisual itself isn't aria-live (it'd be too noisy on every
      // prompt change), so include the pronounceable morse in the feedback
      // region so screen readers get the answer, not just the letter.
      fb.textContent = `✗  ${MT.displayLabel(currentChar)}  is  ${morseSpoken(currentMorse)}`;
      fb.className = "feedback bad";
    }
  }

  // ---- progress panel -----------------------------------------------------

  // AIDEV-NOTE: Built with DOM APIs (textContent only) because progress entries
  // come from localStorage, which is treated as untrusted (a corrupted/crafted
  // entry like {trials: "<img onerror=...>"} must not be able to inject HTML).
  function renderProgressTable() {
    const wrap = $("#progress");
    if (!wrap) return;

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["ch", "morse", "trials", "recent", "lifetime", "aids"]) {
      const th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const ch of state.activeChars) {
      const p = state.progress[ch] || { trials: 0, correct: 0, recent: [] };
      const recent = p.recent && p.recent.length
        ? Math.round(MT.SRS.recentAccuracy(ch) * 100) + "%"
        : "—";
      const lifetime = p.trials
        ? Math.round((p.correct / p.trials) * 100) + "%"
        : "—";
      const aud = MT.SRS.shouldUseAudioAid(ch);
      const vis = MT.SRS.shouldUseVisualAid(ch);

      const tr = document.createElement("tr");

      const tdCh = document.createElement("td");
      const b = document.createElement("b");
      b.textContent = MT.displayLabel(ch);
      tdCh.appendChild(b);
      tr.appendChild(tdCh);

      const tdMorse = document.createElement("td");
      const code = document.createElement("code");
      code.textContent = formatMorseVisual(MT.charToMorse(ch) || "");
      tdMorse.appendChild(code);
      tr.appendChild(tdMorse);

      const tdTrials = document.createElement("td");
      tdTrials.textContent = String(Number(p.trials) || 0);
      tr.appendChild(tdTrials);

      const tdRecent = document.createElement("td");
      tdRecent.textContent = recent;
      tr.appendChild(tdRecent);

      const tdLife = document.createElement("td");
      tdLife.textContent = lifetime;
      tr.appendChild(tdLife);

      const tdAids = document.createElement("td");
      tdAids.title = "audio aid · visual aid";
      if (aud || vis) {
        tdAids.textContent = `${aud ? "🔊" : ""}${vis ? "👁" : ""}`;
      } else {
        const span = document.createElement("span");
        span.className = "muted";
        span.textContent = "off";
        tdAids.appendChild(span);
      }
      tr.appendChild(tdAids);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const meta = document.createElement("div");
    meta.className = "meta";
    const remaining = MT.KOCH_ORDER.length - state.activeChars.length;
    const attempts = Number(state.stats.totalAttempts) || 0;
    meta.textContent = `active ${state.activeChars.length} · remaining in Koch ${remaining} · attempts ${attempts}`;

    wrap.replaceChildren(table, meta);
  }

  // ---- boot ---------------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
