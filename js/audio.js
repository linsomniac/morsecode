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

      t += dur + charUnit; // 1-unit intra-character gap between dits/dahs
    }

    const totalSec = t - startAt;
    return new Promise((resolve) => {
      const id = setTimeout(resolve, totalSec * 1000 + 30);
      scheduledTimers.push(id);
    });
  }

  // After-character pause. Honors Farnsworth: stretches the "between characters"
  // gap so the effective overall WPM matches effWpm even though dits/dahs are at charWpm.
  // Standard inter-character gap is 3 units at char speed; Farnsworth scales it up.
  function interCharPause() {
    const charUnit = unitMs(charWpm);
    const effUnit = unitMs(effWpm);
    // PARIS analysis: a single character contributes ~10 units intra-char+gap at char speed,
    // but at effective speed it should be 1200/effWpm * 10. Add the difference as extra gap.
    // Simpler approximation: standard 3-unit gap, plus extra to hit effective WPM.
    const standardGap = 3 * charUnit;
    if (effWpm >= charWpm) return new Promise((r) => setTimeout(r, standardGap));
    const extra = (effUnit - charUnit) * 19; // matches common Farnsworth formulas
    const total = Math.max(standardGap, standardGap + extra);
    return new Promise((r) => setTimeout(r, total));
  }

  function speakLetter(letter) {
    if (!("speechSynthesis" in window)) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        const u = new SpeechSynthesisUtterance(String(letter));
        u.rate = 0.9;
        u.pitch = 1.0;
        u.volume = 1.0;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
        // safety timeout in case onend never fires
        setTimeout(resolve, 2500);
      } catch (e) {
        resolve();
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
    ensureCtx, playMorse, speakLetter, stop, interCharPause, blip,
    setWPM, setFarnsworth, setFrequency,
    getCharWpm, getEffWpm,
  };
})();
