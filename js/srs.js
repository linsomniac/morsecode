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

  // Allowed UI ranges; load() clamps to these.
  const SETTING_RANGES = {
    wpm: { min: 5, max: 35, default: 18 },
    farnsworthWpm: { min: 5, max: 35, default: 13 },
    frequencyHz: { min: 300, max: 1000, default: 600 },
    listenPauseMs: { min: 250, max: 5000, default: 1000 },
  };
  const AID_MODES = new Set(["adaptive", "always", "never"]);
  // Reserved by the input handler; cannot be used as a dit/dah key.
  const RESERVED_KEYS = new Set([" ", "Enter", "Backspace", "r", "R", "n", "N", "Tab", "Escape"]);

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
        iambicMode: true,
        autoSubmit: true,
        listenSource: "srs",   // listen mode picker: "srs" (weighted) | "review" (uniform)
        listenPauseMs: 1000,   // pause between letters in listen mode
      },
      progress: makeProgressMap(),
      activeChars: ["K", "M"],
      kochIndex: 2,             // next index in KOCH_ORDER to introduce
      dropCooldown: 0,          // attempts remaining before another promotion is allowed
      stats: { totalAttempts: 0, sessionStart: new Date().toISOString() },
      history: [],              // last N add/drop events: { ts, type, char }
    };
  }

  // AIDEV-NOTE: Persisted progress is treated as untrusted user-controlled data.
  // We use a null-prototype map and only copy own primitive fields per known character.
  function makeProgressMap() { return Object.create(null); }

  function clampInt(v, range) {
    const n = Number(v);
    if (!Number.isFinite(n)) return range.default;
    const i = Math.round(n);
    if (i < range.min) return range.min;
    if (i > range.max) return range.max;
    return i;
  }

  function isValidKeyChar(s) {
    if (typeof s !== "string" || s.length !== 1) return false;
    if (RESERVED_KEYS.has(s)) return false;
    // Reject control chars; require something printable.
    return s.charCodeAt(0) >= 0x20;
  }

  function normalizeProgressEntry(raw) {
    const out = { trials: 0, correct: 0, recent: [], timesMs: [] };
    if (!raw || typeof raw !== "object") return out;
    if (Number.isFinite(raw.trials)) out.trials = Math.max(0, Math.floor(raw.trials));
    if (Number.isFinite(raw.correct)) out.correct = Math.max(0, Math.floor(raw.correct));
    if (out.correct > out.trials) out.correct = out.trials;
    if (Array.isArray(raw.recent)) {
      out.recent = raw.recent.slice(-RECENT_WINDOW).map((v) => (v ? 1 : 0));
    }
    if (Array.isArray(raw.timesMs)) {
      out.timesMs = raw.timesMs.slice(-RECENT_WINDOW)
        .map((v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0));
    }
    return out;
  }

  function normalizeSettings(raw, def) {
    const out = { ...def };
    if (raw && typeof raw === "object") {
      out.wpm = clampInt(raw.wpm, SETTING_RANGES.wpm);
      out.frequencyHz = clampInt(raw.frequencyHz, SETTING_RANGES.frequencyHz);
      // Farnsworth is clamped to its own range AND must be <= wpm.
      out.farnsworthWpm = Math.min(
        clampInt(raw.farnsworthWpm, SETTING_RANGES.farnsworthWpm),
        out.wpm,
      );
      out.speakLetter = !!raw.speakLetter;
      out.audioAid = AID_MODES.has(raw.audioAid) ? raw.audioAid : def.audioAid;
      out.visualAid = AID_MODES.has(raw.visualAid) ? raw.visualAid : def.visualAid;
      out.ditKey = isValidKeyChar(raw.ditKey) ? raw.ditKey : def.ditKey;
      out.dahKey = isValidKeyChar(raw.dahKey) ? raw.dahKey : def.dahKey;
      if (out.dahKey === out.ditKey) {
        out.ditKey = def.ditKey;
        out.dahKey = def.dahKey;
      }
      out.autoSubmit = raw.autoSubmit === undefined ? def.autoSubmit : !!raw.autoSubmit;
      out.iambicMode = raw.iambicMode === undefined ? def.iambicMode : !!raw.iambicMode;
      out.listenSource = raw.listenSource === "review" ? "review" : def.listenSource;
      out.listenPauseMs = clampInt(raw.listenPauseMs, SETTING_RANGES.listenPauseMs);
    }
    return out;
  }

  function normalizeActiveChars(raw, fallback) {
    if (!Array.isArray(raw)) return fallback.slice();
    const seen = new Set();
    const out = [];
    for (const ch of raw) {
      if (typeof ch !== "string" || ch.length !== 1) continue;
      const up = ch.toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(MT.MORSE, up)) continue;
      if (seen.has(up)) continue;
      seen.add(up);
      out.push(up);
    }
    if (out.length < 2) return fallback.slice();
    return out;
  }

  function normalizeProgress(raw, activeChars) {
    const out = makeProgressMap();
    if (raw && typeof raw === "object") {
      for (const key of Object.keys(raw)) {
        if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        if (!Object.prototype.hasOwnProperty.call(MT.MORSE, key)) continue;
        out[key] = normalizeProgressEntry(raw[key]);
      }
    }
    for (const ch of activeChars) {
      if (!out[ch]) out[ch] = normalizeProgressEntry(null);
    }
    return out;
  }

  function normalizeStats(raw, def) {
    const out = { ...def };
    if (raw && typeof raw === "object") {
      if (Number.isFinite(raw.totalAttempts)) {
        out.totalAttempts = Math.max(0, Math.floor(raw.totalAttempts));
      }
      if (typeof raw.sessionStart === "string") out.sessionStart = raw.sessionStart;
    }
    return out;
  }

  function normalizeHistory(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const ev of raw.slice(-50)) {
      if (!ev || typeof ev !== "object") continue;
      if (ev.type !== "add" && ev.type !== "drop") continue;
      if (typeof ev.char !== "string" || ev.char.length !== 1) continue;
      out.push({
        ts: Number.isFinite(ev.ts) ? ev.ts : Date.now(),
        type: ev.type,
        char: ev.char,
      });
    }
    return out;
  }

  let state = null;

  function load() {
    const def = defaultState();
    let parsed = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch (e) {
      console.warn("morsetrainer: failed to parse stored state, resetting", e);
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      replaceState(def);
      return state;
    }
    const settings = normalizeSettings(parsed.settings, def.settings);
    const activeChars = normalizeActiveChars(parsed.activeChars, def.activeChars);
    const progress = normalizeProgress(parsed.progress, activeChars);
    const kochIndexRaw = Number(parsed.kochIndex);
    let kochIndex = Number.isFinite(kochIndexRaw)
      ? Math.max(2, Math.min(MT.KOCH_ORDER.length, Math.floor(kochIndexRaw)))
      : def.kochIndex;
    if (kochIndex < activeChars.length) kochIndex = activeChars.length;
    const dropCooldownRaw = Number(parsed.dropCooldown);
    const dropCooldown = Number.isFinite(dropCooldownRaw)
      ? Math.max(0, Math.min(100, Math.floor(dropCooldownRaw)))
      : 0;
    replaceState({
      version: 1,
      settings,
      progress,
      activeChars,
      kochIndex,
      dropCooldown,
      stats: normalizeStats(parsed.stats, def.stats),
      history: normalizeHistory(parsed.history),
    });
    return state;
  }

  // AIDEV-NOTE: Callers (app.js) cache `state` after load(). reset()/load() must
  // therefore mutate the existing object in place so cached references stay
  // valid; otherwise writes to the stale reference vanish silently.
  function replaceState(next) {
    if (state) {
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, next);
    } else {
      state = next;
    }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { console.warn("morsetrainer: save failed", e); }
  }

  function reset() {
    replaceState(defaultState());
    save();
    return state;
  }

  function getState() { return state; }

  function ensureProgress(ch) {
    if (!Object.prototype.hasOwnProperty.call(state.progress, ch)) {
      state.progress[ch] = normalizeProgressEntry(null);
    }
    return state.progress[ch];
  }

  function recentAccuracy(ch) {
    const p = state.progress[ch];
    if (!p || !p.recent || p.recent.length === 0) return 0;
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
    isValidKeyChar,
    constants: {
      RECENT_WINDOW, ADD_THRESHOLD, ADD_MIN_TRIALS, DROP_THRESHOLD, DROP_MIN_TRIALS,
      FADE_AID_THRESHOLD, RESERVED_KEYS, SETTING_RANGES,
    },
  };
})();
