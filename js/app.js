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
    $("#listenSource").value = s.listenSource;
    $("#listenPauseMs").value = s.listenPauseMs;
    $("#listenPauseVal").textContent = formatPauseLabel(s.listenPauseMs);
  }

  // Render a millisecond pause as a friendly seconds label, e.g. 1000 → "1.0 s".
  function formatPauseLabel(ms) {
    return (Number(ms) / 1000).toFixed(2).replace(/0$/, "") + " s";
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
    const ditDownHandler = () => {
      if (state.settings.iambicMode) { ditDown = true; startKeyerIfNeeded(); }
      else { appendSymbol("."); }
    };
    const ditUpHandler = () => { ditDown = false; };
    const dahDownHandler = () => {
      if (state.settings.iambicMode) { dahDown = true; startKeyerIfNeeded(); }
      else { appendSymbol("-"); }
    };
    const dahUpHandler = () => { dahDown = false; };

    bindPaddle("ditButton", ditDownHandler, ditUpHandler);
    bindPaddle("dahButton", dahDownHandler, dahUpHandler);
    // Keying-mode paddles share the same handlers — input dispatch happens
    // downstream in appendSymbol() based on which panel is visible.
    bindPaddle("keyingDitButton", ditDownHandler, ditUpHandler);
    bindPaddle("keyingDahButton", dahDownHandler, dahUpHandler);
    $("#reset").addEventListener("click", () => {
      if (confirm("Reset all progress? This wipes saved stats and active characters.")) {
        state = MT.SRS.reset();
        applySettingsToUI();
        applySettingsToAudio();
        renderProgressTable();
        // showPanel("practice") restarts the prompt cycle AND clears any
        // listen-mode or keying-mode state — important if the user is on a
        // non-Practice tab when they reset, otherwise practice would silently
        // restart behind a hidden panel.
        showPanel("practice");
        // Keying transcript is session-only (not persisted), but "Reset all
        // progress" should match the user's mental model of a clean slate.
        MT.Keying.clear();
        $("#keyingTranscript").textContent = "";
        $("#keyingMorseLive").textContent = "";
      }
    });

    // Listen-mode controls
    $("#listenPlay").addEventListener("click", () => MT.Listen.start());
    $("#listenPause").addEventListener("click", () => MT.Listen.stop());
    $("#listenSource").addEventListener("change", (e) => {
      state.settings.listenSource = e.target.value === "review" ? "review" : "srs";
      MT.SRS.save();
    });
    // Bind both `input` (live drag) and `change` (commit-on-release) so a slider
    // works on touch devices / browsers that don't fire `input` reliably during
    // a drag — without this the displayed value can appear "stuck" at the
    // initial value while the slider thumb moves.
    const onListenPauseChange = (e) => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v)) return;
      if (state.settings.listenPauseMs === v) return;   // skip the trailing change-after-input no-op
      state.settings.listenPauseMs = v;
      $("#listenPauseVal").textContent = formatPauseLabel(v);
      MT.SRS.save();
    };
    $("#listenPauseMs").addEventListener("input", onListenPauseChange);
    $("#listenPauseMs").addEventListener("change", onListenPauseChange);

    // Keying-mode controls
    $("#keyingClear").addEventListener("click", () => {
      $("#keyingTranscript").textContent = "";
      $("#keyingMorseLive").textContent = "";
      MT.Keying.clear();
    });

    // Tab strip — click activates, ARIA roving tabindex w/ arrow keys
    $("#tabPractice").addEventListener("click", () => showPanel("practice"));
    $("#tabListen").addEventListener("click", () => showPanel("listen"));
    $("#tabKeying").addEventListener("click", () => showPanel("keying"));
    bindTabKeyNav();

    // Wire MT.Listen → DOM. onPrompt is called on every iteration; onStateChange
    // toggles the Start/Pause button visibility.
    MT.Listen.setHandlers({
      onPrompt: renderListenPrompt,
      onStateChange: (running) => {
        $("#listenPlay").hidden = running;
        $("#listenPause").hidden = !running;
      },
    });

    // Wire MT.Keying → DOM. Transcript and live in-progress display are both
    // built via textContent only — letters are bounded to the MT.MORSE keys
    // plus "?", but stay within the same untrusted-content discipline used
    // elsewhere in the app.
    //
    // Transcript is capped at TRANSCRIPT_MAX chars and trimmed from the front
    // so a long session can't grow the DOM without bound. The element is an
    // aria-live region (`additions text`), so trimming the prefix doesn't
    // re-announce existing content — only the appended chars are spoken.
    const TRANSCRIPT_MAX = 500;
    function appendToTranscript(s) {
      const t = $("#keyingTranscript");
      const next = t.textContent + s;
      t.textContent = next.length > TRANSCRIPT_MAX ? next.slice(-TRANSCRIPT_MAX) : next;
    }
    MT.Keying.setHandlers({
      onSymbol: (buf) => {
        $("#keyingMorseLive").textContent = MT.formatMorseVisual(buf);
      },
      onCharComplete: (ch) => { appendToTranscript(ch); },
      onSpace: () => { appendToTranscript(" "); },
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

  // ---- mode tabs ----------------------------------------------------------

  // AIDEV-NOTE: Modes are an ordered list so adding/removing a tab is
  // mechanical. Tab strip uses ARIA roving tabindex; only the active tab
  // is in the focus order.
  const MODES = [
    { name: "practice", tab: "#tabPractice", panel: "#panelPractice" },
    { name: "listen",   tab: "#tabListen",   panel: "#panelListen"   },
    { name: "keying",   tab: "#tabKeying",   panel: "#panelKeying"   },
  ];

  function currentMode() {
    for (const m of MODES) {
      if ($(m.tab).getAttribute("aria-selected") === "true") return m.name;
    }
    return "practice";
  }

  // Switch between Practice / Listen / Keying.
  //
  // AIDEV-NOTE: Switching away from Practice MUST bump promptToken —
  // nextPrompt() may be awaiting TTS or playMorse, and MT.Audio.stop()
  // resolves those Promises via onerror. Without invalidating the token,
  // Practice's post-await guards (myToken !== promptToken) pass and the
  // stale prompt continues to the next step, racing the new mode.
  // Tab buttons themselves are interactive — leaving focus on a tab after
  // switch-to-Practice or switch-to-Keying means the global keydown
  // handler treats paddle keys as belonging to an interactive target and
  // suppresses them, so we move focus off the tab before unlocking input.
  function showPanel(which) {
    const from = currentMode();
    if (from === which) return;

    for (const m of MODES) {
      const isActive = m.name === which;
      const tabEl = $(m.tab);
      tabEl.setAttribute("aria-selected", isActive ? "true" : "false");
      tabEl.tabIndex = isActive ? 0 : -1;
      $(m.panel).hidden = !isActive;
    }

    // Leave the previous mode (cleanup specific to from-mode).
    if (from === "listen") MT.Listen.stop();
    if (from === "keying") MT.Keying.stop();

    const blurTabIfFocused = () => {
      const ae = document.activeElement;
      for (const m of MODES) {
        if (ae === $(m.tab)) { ae.blur(); return; }
      }
    };

    if (which === "practice") {
      blurTabIfFocused();
      if (started) nextPrompt();
    } else if (which === "listen") {
      promptToken++;
      MT.Audio.stop();
      resetKeyer();
      clearAdvanceTimer();
      inputLocked = true;
      // After click, focus on play so Space/Enter starts; for keyboard users
      // arriving via arrow-key tab nav, focus is already on #tabListen — the
      // explicit focus shift here mirrors the click case.
      $("#listenPlay").focus();
    } else if (which === "keying") {
      promptToken++;
      MT.Audio.stop();
      clearAdvanceTimer();
      resetKeyer();
      inputLocked = false;             // dit/dah keys work immediately
      MT.Keying.start();
      blurTabIfFocused();
    }
  }

  // ARIA APG tablist: ArrowLeft/Right cycle focus through the tabs (with
  // wrap); Home/End jump to first/last. Each cycle activates the new tab.
  function bindTabKeyNav() {
    for (let i = 0; i < MODES.length; i++) {
      const tabEl = $(MODES[i].tab);
      tabEl.addEventListener("keydown", (e) => {
        let target = -1;
        if (e.key === "ArrowLeft")       target = (i - 1 + MODES.length) % MODES.length;
        else if (e.key === "ArrowRight") target = (i + 1) % MODES.length;
        else if (e.key === "Home")       target = 0;
        else if (e.key === "End")        target = MODES.length - 1;
        else return;
        e.preventDefault();
        $(MODES[target].tab).focus();
        showPanel(MODES[target].name);
      });
    }
  }

  // Render a Listen prompt: letter + (optional) morse-visual + aid status.
  // Reuses the same per-character adaptive aid logic as Practice so a
  // mastered character will fade its visual and skip its morse audio
  // (the latter happens in MT.Listen, not here).
  function renderListenPrompt(ch, morse) {
    $("#listenPrompt").textContent = MT.displayLabel(ch);
    const visAid = MT.SRS.shouldUseVisualAid(ch);
    const v = $("#listenMorseVisual");
    v.textContent = visAid ? MT.formatMorseVisual(morse) : "";
    v.classList.toggle("hidden-aid", !visAid);

    const aud = MT.SRS.shouldUseAudioAid(ch) ? "audio: on" : "audio: off";
    const vis = visAid ? "visual: on" : "visual: off";
    const acc = Math.round(MT.SRS.recentAccuracy(ch) * 100);
    $("#listenAidStatus").textContent = `${aud} · ${vis} · recent ${acc}%`;
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

      // Don't intercept browser/system shortcuts. Cmd/Ctrl+R is reload,
      // Cmd+Shift+R is hard-reload, Cmd+N is new window, etc. — without
      // this check our R/N handlers would eat them. Shift alone is fine
      // (it's how we get capital letters); only Ctrl/Meta/Alt matter.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // start overlay: any key dismisses it
      if (!started) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          $("#startOverlay button").click();
        }
        return;
      }

      // Listen panel: Space/Enter toggle play/pause; all other practice
      // shortcuts (dit/dah/R/N/Backspace) are scoped to Practice and
      // would either no-op (gated by inputLocked) or do something wrong
      // (R/N target practice's currentMorse) — short-circuit them here.
      if (!$("#panelListen").hidden) {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          if (MT.Listen.isRunning()) MT.Listen.stop();
          else MT.Listen.start();
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
      } else if (!$("#panelKeying").hidden) {
        // Keying mode: dit/dah are the only meaningful inputs (handled above).
        // Suppress the practice-only shortcuts so they don't trigger browser
        // defaults like Backspace navigating back.
        if (key === "Backspace" || key === "Enter" || key === " " ||
            key === "r" || key === "R" || key === "n" || key === "N") {
          e.preventDefault();
        }
        return;
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

    // AIDEV-NOTE: focus-loss kill switch. If the user switches tabs or alt-tabs
    // mid-keypress, the matching keyup is often delivered to a different focus
    // target and our ditDown/dahDown flags stay stuck. In Practice that's
    // self-limiting (evaluate() locks input), but Keying mode has no natural
    // stop and would emit sidetone forever, growing the transcript and burning
    // CPU. Resetting the keyer here clears flags and the in-flight timer; the
    // MT.Keying buffer is left intact so anything already keyed still commits
    // via its own silence timer.
    const stopKeyerOnFocusLoss = () => { resetKeyer(); };
    window.addEventListener("blur", stopKeyerOnFocusLoss);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopKeyerOnFocusLoss();
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
    // AIDEV-NOTE: Keying-mode dispatch must precede the practice-mode
    // currentMorse guard below — keying has no target prompt and would
    // otherwise be silently dropped here.
    if (!$("#panelKeying").hidden) {
      MT.Audio.playSymbol(sym);
      MT.Keying.recordSymbol(sym);
      return;
    }
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
    morseVisual.textContent = visAid ? MT.formatMorseVisual(currentMorse) : "";
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
      morseVisual.textContent = MT.formatMorseVisual(currentMorse);
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
      code.textContent = MT.formatMorseVisual(MT.charToMorse(ch) || "");
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
