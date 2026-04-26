window.MT = window.MT || {};

// Passive listen mode: announces a letter (optional TTS) and plays its
// morse, pauses (Farnsworth gap), then picks the next letter. Never calls
// MT.SRS.recordAttempt — listen does not affect promotion/demotion.
//
// AIDEV-NOTE: token-invalidation pattern mirrors promptToken in app.js.
// Every await inside loop() is followed by a `if (myToken !== token) return`
// because callers (Pause, tab switch) bump `token` to abort the loop, and
// MT.Audio.stop() resolves any awaited TTS / playMorse via cancel(). Without
// the post-await check, a stale iteration would still schedule the next
// prompt.
MT.Listen = (function () {
  let running = false;
  let token = 0;             // invalidation token; bumped by stop() and at loop entry
  let lastChar = null;
  let onPrompt = null;       // (ch, morse) => render in #panelListen
  let onStateChange = null;  // (isRunning) => app.js refreshes play/pause buttons

  function pickChar() {
    const s = MT.SRS.getState();
    const active = s && s.activeChars ? s.activeChars : [];
    if (active.length === 0) return null;
    if (active.length === 1) return active[0];

    if (s.settings.listenSource === "review") {
      // Uniform random across active set, with no immediate repeat.
      const candidates = active.filter((c) => c !== lastChar);
      const pool = candidates.length ? candidates : active;
      return pool[Math.floor(Math.random() * pool.length)];
    }
    // SRS-weighted picker: weak/novel chars surface more.
    return MT.SRS.pickNextChar(lastChar);
  }

  function sleep(ms, myToken) {
    return new Promise((resolve) => {
      setTimeout(() => {
        // Resolve regardless; the loop's `myToken !== token` check after the
        // await is what actually halts iteration. (The check inside the timer
        // would just defer resolution forever, which is wrong — stop() needs
        // resolution so the awaiter can unwind cleanly.)
        if (myToken === token) resolve(); else resolve();
      }, ms);
    });
  }

  async function loop() {
    const myToken = ++token;
    running = true;
    if (onStateChange) onStateChange(true);

    while (running && myToken === token) {
      const ch = pickChar();
      if (!ch) break;
      lastChar = ch;
      const morse = MT.charToMorse(ch) || "";
      if (onPrompt) onPrompt(ch, morse);

      const s = MT.SRS.getState();
      if (s.settings.speakLetter) {
        await MT.Audio.speakLetter(ch);
        if (myToken !== token) return;
      }
      if (MT.SRS.shouldUseAudioAid(ch)) {
        await MT.Audio.playMorse(morse);
        if (myToken !== token) return;
      }
      const pauseMs = Number(s.settings.listenPauseMs) || 1000;
      await sleep(pauseMs, myToken);
      if (myToken !== token) return;
    }

    running = false;
    if (onStateChange) onStateChange(false);
  }

  function start() {
    if (running) return;
    loop();
  }

  function stop() {
    if (!running && token === 0) return;   // never started; nothing to clear
    running = false;
    token++;
    lastChar = null;          // so a future reset / restart doesn't bias against a stale char
    MT.Audio.stop();
    if (onStateChange) onStateChange(false);
  }

  function setHandlers(h) {
    onPrompt = h && h.onPrompt ? h.onPrompt : null;
    onStateChange = h && h.onStateChange ? h.onStateChange : null;
  }

  function isRunning() { return running; }

  return { start, stop, isRunning, setHandlers };
})();
