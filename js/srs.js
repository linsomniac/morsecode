window.MT = window.MT || {};

MT.SRS = (function () {
  const STORAGE_KEY = "morsetrainer.v1";

  // Tuneable thresholds.
  const RECENT_WINDOW = 10;     // attempts kept per character for recent accuracy
  const ADD_THRESHOLD = 0.9;    // need >= 90% recent on every active char to add a new one
  const ADD_MIN_TRIALS = 8;     // and at least this many recent attempts each
  const DROP_THRESHOLD = 0.4;   // newest active char dropping below 40% gets pulled
  const DROP_MIN_TRIALS = 8;
  const FADE_AID_THRESHOLD = 0.85;  // when to start hiding the audio/visual aid
  const FADE_AID_MIN_TRIALS = 10;
  const DROP_COOLDOWN_TRIALS = 12;  // after a drop, require this many attempts before re-promoting

  function defaultState() {
    return {
      version: 1,
      settings: {
        wpm: 18,
        farnsworthWpm: 13,
        frequencyHz: 600,
        speakLetter: false,
        audioAid: "adaptive",   // adaptive | always | never
        visualAid: "adaptive",  // adaptive | always | never
        ditKey: "[",
        dahKey: "]",
        autoSubmit: true,       // auto-evaluate when buffer length matches target
      },
      progress: {},             // ch -> { trials, correct, recent: number[], timesMs: number[] }
      activeChars: ["K", "M"],
      kochIndex: 2,             // next index in KOCH_ORDER to introduce
      dropCooldown: 0,          // attempts remaining before another promotion is allowed
      stats: { totalAttempts: 0, sessionStart: new Date().toISOString() },
      history: [],              // last N add/drop events: { ts, type, char }
    };
  }

  let state = null;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const def = defaultState();
        state = Object.assign({}, def, parsed);
        state.settings = Object.assign({}, def.settings, parsed.settings || {});
        state.stats = Object.assign({}, def.stats, parsed.stats || {});
        state.history = Array.isArray(parsed.history) ? parsed.history : [];
        state.progress = parsed.progress || {};
        state.activeChars = Array.isArray(parsed.activeChars) && parsed.activeChars.length
          ? parsed.activeChars : def.activeChars.slice();
        if (typeof state.kochIndex !== "number") state.kochIndex = def.kochIndex;
        if (typeof state.dropCooldown !== "number") state.dropCooldown = 0;
      } else {
        state = defaultState();
      }
    } catch (e) {
      console.warn("morsetrainer: failed to load state, resetting", e);
      state = defaultState();
    }
    for (const ch of state.activeChars) ensureProgress(ch);
    return state;
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn("morsetrainer: save failed", e); }
  }

  function reset() {
    state = defaultState();
    save();
    return state;
  }

  function getState() { return state; }

  function ensureProgress(ch) {
    if (!state.progress[ch]) {
      state.progress[ch] = { trials: 0, correct: 0, recent: [], timesMs: [] };
    }
    return state.progress[ch];
  }

  function recentAccuracy(ch) {
    const p = state.progress[ch];
    if (!p || p.recent.length === 0) return 0;
    let s = 0;
    for (const v of p.recent) s += v;
    return s / p.recent.length;
  }

  function recordAttempt(ch, correct, timeMs) {
    const p = ensureProgress(ch);
    p.trials++;
    if (correct) p.correct++;
    p.recent.push(correct ? 1 : 0);
    if (p.recent.length > RECENT_WINDOW) p.recent.shift();
    p.timesMs.push(Math.round(timeMs));
    if (p.timesMs.length > RECENT_WINDOW) p.timesMs.shift();
    state.stats.totalAttempts = (state.stats.totalAttempts || 0) + 1;
    const change = maybeAdjustActiveSet();
    save();
    return change;
  }

  function maybeAdjustActiveSet() {
    // Tick down the drop cooldown so promotion can resume after a settling period.
    if (state.dropCooldown > 0) state.dropCooldown--;

    // Promotion: every active char meets accuracy + min-trials => introduce next Koch char.
    // Skipped while the cooldown is active so a freshly-dropped char isn't re-added on the next attempt.
    if (state.dropCooldown <= 0) {
      const allMastered = state.activeChars.every((ch) => {
        const p = state.progress[ch];
        return p && p.recent.length >= ADD_MIN_TRIALS && recentAccuracy(ch) >= ADD_THRESHOLD;
      });
      if (allMastered && state.kochIndex < MT.KOCH_ORDER.length) {
        const next = MT.KOCH_ORDER[state.kochIndex];
        if (!state.activeChars.includes(next)) {
          state.activeChars.push(next);
          state.kochIndex++;
          ensureProgress(next);
          state.history.push({ ts: Date.now(), type: "add", char: next });
          if (state.history.length > 50) state.history.shift();
          return { added: next };
        }
      }
    }

    // Demotion: the most recently added char is struggling => drop it back.
    // Floor at 2 chars so we always have something to practice.
    if (state.activeChars.length > 2) {
      const newest = state.activeChars[state.activeChars.length - 1];
      const p = state.progress[newest];
      if (p && p.recent.length >= DROP_MIN_TRIALS && recentAccuracy(newest) < DROP_THRESHOLD) {
        state.activeChars.pop();
        state.kochIndex = Math.max(2, state.kochIndex - 1);
        // Reset its recent buffer so it gets a clean shot when reintroduced.
        p.recent = [];
        state.dropCooldown = DROP_COOLDOWN_TRIALS;
        state.history.push({ ts: Date.now(), type: "drop", char: newest });
        if (state.history.length > 50) state.history.shift();
        return { dropped: newest };
      }
    }
    return null;
  }

  function pickNextChar(lastCh) {
    const chars = state.activeChars.slice();
    if (chars.length === 0) return null;
    if (chars.length === 1) return chars[0];

    // Weighting: weaker chars (lower recent accuracy) get higher weight.
    // Brand-new chars also get a novelty boost so they're tried often early.
    const weights = chars.map((ch) => {
      const p = state.progress[ch] || { trials: 0, recent: [] };
      const acc = recentAccuracy(ch);
      const novelty = p.trials < 5 ? 0.6 : 0;
      const weakness = 1 - acc;        // 0..1
      const base = 0.25;               // floor so mastered chars still appear
      return base + weakness + novelty;
    });
    // Avoid immediate repeats when possible.
    if (lastCh) {
      const idx = chars.indexOf(lastCh);
      if (idx >= 0) weights[idx] *= 0.25;
    }

    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < chars.length; i++) {
      r -= weights[i];
      if (r <= 0) return chars[i];
    }
    return chars[chars.length - 1];
  }

  function shouldUseAudioAid(ch) {
    const mode = state.settings.audioAid;
    if (mode === "always") return true;
    if (mode === "never") return false;
    const p = state.progress[ch];
    if (!p || p.recent.length < FADE_AID_MIN_TRIALS) return true;
    return recentAccuracy(ch) < FADE_AID_THRESHOLD;
  }

  function shouldUseVisualAid(ch) {
    const mode = state.settings.visualAid;
    if (mode === "always") return true;
    if (mode === "never") return false;
    const p = state.progress[ch];
    if (!p || p.recent.length < FADE_AID_MIN_TRIALS) return true;
    return recentAccuracy(ch) < FADE_AID_THRESHOLD;
  }

  return {
    load, save, reset, getState,
    ensureProgress, recordAttempt, recentAccuracy,
    pickNextChar, shouldUseAudioAid, shouldUseVisualAid,
    constants: { RECENT_WINDOW, ADD_THRESHOLD, ADD_MIN_TRIALS, DROP_THRESHOLD, DROP_MIN_TRIALS, FADE_AID_THRESHOLD },
  };
})();
