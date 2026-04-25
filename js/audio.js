window.MT = window.MT || {};

MT.Audio = (function () {
  let ctx = null;
  let frequency = 600;
  let charWpm = 18;       // PARIS WPM for the dits/dahs themselves
  let effWpm = 13;        // Farnsworth: effective overall WPM (<= charWpm)

  // Track scheduled oscillators so we can cancel a playback (replay/skip mid-prompt).
  let scheduled = [];
  let scheduledTimers = [];

  function ensureCtx() {
    if (!ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function unitMs(wpm) { return 1200 / wpm; }

  function setWPM(w) { charWpm = w; if (effWpm > w) effWpm = w; }
  function setFarnsworth(w) { effWpm = Math.min(w, charWpm); }
  function setFrequency(hz) { frequency = hz; }
  function getCharWpm() { return charWpm; }
  function getEffWpm() { return effWpm; }

  function stop() {
    const c = ctx;
    if (c) {
      for (const o of scheduled) {
        try { o.stop(0); } catch (_) {}
        try { o.disconnect(); } catch (_) {}
      }
    }
    scheduled = [];
    for (const t of scheduledTimers) clearTimeout(t);
    scheduledTimers = [];
    // Cancel any in-flight TTS so a new prompt isn't talked over.
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
  }

  // Schedule playback of a Morse symbol string ("." and "-").
  // Returns a Promise that resolves when the last symbol finishes (or on stop()).
  function playMorse(symbols) {
    stop();
    const c = ensureCtx();
    if (!c) return Promise.resolve();

    const charUnit = unitMs(charWpm) / 1000;  // seconds
    const ATTACK = 0.005, RELEASE = 0.005;
    const startAt = c.currentTime + 0.05;
    let t = startAt;
    let lastToneEnd = startAt;       // resolve based on actual last tone, not the trailing gap

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      let dur;
      if (sym === ".") dur = charUnit;
      else if (sym === "-") dur = 3 * charUnit;
      else continue;

      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.frequency.value = frequency;
      osc.type = "sine";
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + ATTACK);
      gain.gain.setValueAtTime(0.35, t + dur - RELEASE);
      gain.gain.linearRampToValueAtTime(0, t + dur);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
      scheduled.push(osc);

      lastToneEnd = t + dur;
      t += dur + charUnit;            // intra-character gap; only used between symbols, not as a tail
    }

    const totalSec = lastToneEnd - startAt;
    return new Promise((resolve) => {
      const id = setTimeout(resolve, totalSec * 1000 + 30);
      scheduledTimers.push(id);
    });
  }

  // AIDEV-NOTE: Farnsworth in single-character training.
  // Real Farnsworth stretches inter-character/word gaps so effective WPM is lower
  // than character WPM. With one char per prompt there is no audible inter-char gap,
  // so we surface Farnsworth as the inter-prompt cadence delay (applied between
  // feedback and the next letter, so the lockout is invisible to the user). Returns ms.
  function farnsworthGapMs() {
    const charUnit = unitMs(charWpm);
    const effUnit = unitMs(effWpm);
    const standardGap = 3 * charUnit;          // standard inter-character gap
    if (effWpm >= charWpm) return standardGap;
    // Common Farnsworth formula: extra delay distributed across the 19 "missing" units
    // implied by the gap between actual char speed and effective speed.
    const extra = (effUnit - charUnit) * 19;
    return Math.max(standardGap, standardGap + extra);
  }

  function speakLetter(letter) {
    if (!("speechSynthesis" in window)) return Promise.resolve();
    return new Promise((resolve) => {
      let safety = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (safety !== null) clearTimeout(safety);
        resolve();
      };
      try {
        const u = new SpeechSynthesisUtterance(String(letter));
        u.rate = 0.9;
        u.pitch = 1.0;
        u.volume = 1.0;
        u.onend = finish;
        u.onerror = finish;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
        safety = setTimeout(finish, 2500);
      } catch (e) {
        finish();
      }
    });
  }

  // Brief blip used as positive/negative feedback (optional UX nicety).
  function blip(ok) {
    const c = ensureCtx();
    if (!c) return;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = ok ? 880 : 220;
    const t = c.currentTime;
    const dur = 0.08;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.005);
    gain.gain.setValueAtTime(0.25, t + dur - 0.01);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  return {
    ensureCtx, playMorse, speakLetter, stop, farnsworthGapMs, blip,
    setWPM, setFarnsworth, setFrequency,
    getCharWpm, getEffWpm,
  };
})();
