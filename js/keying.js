window.MT = window.MT || {};

// Keying-practice mode: the user keys morse with no target prompt; the
// module accumulates dits/dahs into a buffer and uses inter-symbol silence
// to decide letter and word boundaries. Decoded characters are reported to
// app.js via callbacks so the DOM stays in app.js.
//
// AIDEV-NOTE: Silent-gap timer cascade.
//   States: none → char-pending → word-pending.
//   Every recordSymbol() cancels BOTH timers and reschedules charTimer.
//   When charTimer fires it commits the buffer and schedules wordTimer.
//   When wordTimer fires it emits a word space and clears state.
//
//   Timing is measured from tone-END, not tone-START. recordSymbol() is
//   called when the tone STARTS, so the schedule is elementMs(sym) +
//   silenceMs — that way the silence we measure is real silence after
//   the audio stops. Without the elementMs term, a 3-unit dah at the
//   canonical 3-unit silence threshold would fire the timer right when
//   the *next* dah is starting, splitting "M" into "TT". This bug was
//   reported in practice; do not remove the elementMs term.
//
//   Silence threshold uses the Farnsworth (effective) WPM, not the
//   character WPM. That gives users one knob — Effective WPM in
//   Practice mode's Farnsworth slider — to lengthen their thinking
//   time without slowing the elements they hear/key.
//
//   Floors are deliberately generous (600/600 ms) because this is a
//   beginner-facing tool. At a typical 18/13 WPM that's well above the
//   3*effUnit (~277 ms) canonical threshold; the floor only matters
//   for the edge case where Farnsworth is set very high, which would
//   otherwise produce uncomfortably short windows. A held iambic dah
//   stream cycles every ~343 ms at 14 WPM (257 ms tone + 86 ms gap),
//   so any threshold below ~350 ms misclassifies "M"/"O"/"5" as runs
//   of "T"/"E".
//
//   Holding a paddle through the boundary does NOT truncate the letter:
//   the iambic keyer's repeated appendSymbol → recordSymbol keeps
//   cancelling and rescheduling charTimer, so commit only happens
//   silenceCharMs() after the LAST emitted element ends.
//
//   Reverse map is built from the full MT.MORSE table (not state.activeChars)
//   so the user can key any known letter regardless of training progress.
MT.Keying = (function () {
  let running = false;
  let buffer = "";
  let charTimer = null;
  let wordTimer = null;
  let onSymbol = null;          // (buffer) => render in-progress dits/dahs
  let onCharComplete = null;    // (char) => append to transcript ("?" on miss)
  let onSpace = null;           // () => append a word space to transcript
  let onStateChange = null;     // (running) => app.js can react to start/stop

  const MORSE_TO_CHAR = (function () {
    const m = Object.create(null);
    for (const ch in MT.MORSE) {
      if (Object.prototype.hasOwnProperty.call(MT.MORSE, ch)) {
        m[MT.MORSE[ch]] = ch;
      }
    }
    return m;
  })();

  function charUnitMs() { return 1200 / MT.Audio.getCharWpm(); }
  function effUnitMs() { return 1200 / MT.Audio.getEffWpm(); }
  function elementMs(sym) { return (sym === "-" ? 3 : 1) * charUnitMs(); }
  function silenceCharMs() { return Math.max(3 * effUnitMs(), 600); }
  function silenceWordMs() { return Math.max(4 * effUnitMs(), 600); }

  function clearTimers() {
    if (charTimer !== null) { clearTimeout(charTimer); charTimer = null; }
    if (wordTimer !== null) { clearTimeout(wordTimer); wordTimer = null; }
  }

  function emitInProgress() {
    if (onSymbol) onSymbol(buffer);
  }

  function commitChar() {
    charTimer = null;
    if (!buffer) return;
    const ch = MORSE_TO_CHAR[buffer] || "?";
    buffer = "";
    emitInProgress();
    if (onCharComplete) onCharComplete(ch);
  }

  function commitSpace() {
    wordTimer = null;
    if (onSpace) onSpace();
  }

  function recordSymbol(sym) {
    if (!running) return;
    if (sym !== "." && sym !== "-") return;
    buffer += sym;
    emitInProgress();
    // Any new symbol means we are NOT at a word boundary.
    if (wordTimer !== null) { clearTimeout(wordTimer); wordTimer = null; }
    if (charTimer !== null) clearTimeout(charTimer);
    // Schedule = tone duration + silence threshold. recordSymbol fires at
    // tone-START, so without elementMs(sym) the timer would tick during
    // the tone itself and a held iambic stream would commit between
    // emissions (the M→TT bug). Silence portion uses the Farnsworth
    // effective WPM so the user's Practice-mode "thinking time" knob
    // also lengthens Keying boundaries.
    charTimer = setTimeout(() => {
      commitChar();
      if (wordTimer !== null) clearTimeout(wordTimer);
      wordTimer = setTimeout(commitSpace, silenceWordMs());
    }, elementMs(sym) + silenceCharMs());
  }

  function start() {
    running = true;
    buffer = "";
    clearTimers();
    emitInProgress();
    if (onStateChange) onStateChange(true);
  }

  function stop() {
    running = false;
    // Drop any in-progress char (do not commit) — matches Practice's behavior
    // where a half-finished userBuffer is also discarded on prompt change.
    buffer = "";
    clearTimers();
    emitInProgress();
    if (onStateChange) onStateChange(false);
  }

  function clear() {
    buffer = "";
    clearTimers();
    emitInProgress();
  }

  function isRunning() { return running; }

  function setHandlers(h) {
    onSymbol = h && h.onSymbol ? h.onSymbol : null;
    onCharComplete = h && h.onCharComplete ? h.onCharComplete : null;
    onSpace = h && h.onSpace ? h.onSpace : null;
    onStateChange = h && h.onStateChange ? h.onStateChange : null;
  }

  return { start, stop, clear, recordSymbol, isRunning, setHandlers };
})();
