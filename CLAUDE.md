# CLAUDE.md — Morse Trainer

Notes for future Claude sessions working on this repo. Things you can't
derive in a glance from the code.

## Shape of the project

Vanilla JS / HTML / CSS, no build step, no package.json, no framework.
Loaded as classic `<script>` tags in `index.html` so it works over
`file://`. Four JS files attach themselves to a single global namespace:

```
window.MT.MORSE / KOCH_ORDER / charToMorse / displayLabel   (morse.js)
window.MT.Audio                                              (audio.js)
window.MT.SRS                                                (srs.js)
(no export from app.js — it's the IIFE that wires things up)
```

Every module is an IIFE that returns a small object. Don't introduce ES
modules or a bundler unless asked — the "open the file in a browser"
property is intentional.

## Module responsibilities

- **`js/morse.js`** — Morse table for A–Z, 0–9, and `. , ? = /`. Koch
  teaching order. Tiny pure helpers only.
- **`js/audio.js`** — Web Audio sidetone (oscillator + gain envelope),
  Farnsworth gap calculation, speech synthesis for letter announcement,
  positive/negative feedback blip. Owns the `AudioContext`. Tracks
  scheduled oscillators so `stop()` can cancel mid-playback.
- **`js/srs.js`** — All localStorage I/O, schema normalization, the
  weighted picker (`pickNextChar`), and Koch promote/drop logic. Owns
  the `state` object.
- **`js/app.js`** — UI orchestration. Prompt cycle, input handling,
  feedback rendering, progress table, settings binding. Reads/writes
  state through `MT.SRS` and audio through `MT.Audio`.

## Non-obvious design decisions

### State is mutated in place across `load()` / `reset()`

`MT.SRS.reset()` and `load()` both call `replaceState(next)` which
*deletes all keys from the existing `state` object and Object.assigns
the new ones in place*, instead of reassigning the local variable.

This exists because `app.js` does `state = MT.SRS.load()` once at init
and then holds that reference for the lifetime of the page. If
`replaceState` reassigned `state` inside srs.js, the app's cached
reference would silently go stale and any subsequent writes to
`state.settings.…` would vanish on the next `save()`. See the
`AIDEV-NOTE` at `js/srs.js:209`.

If you ever add a *new* path that grabs a fresh state reference (rather
than mutating the existing one), be aware of this and don't break the
contract.

### `promptToken` invalidates stale async work

`nextPrompt()` is async because it `await`s speech synthesis and Morse
playback. If the user hits Skip, Replay, or types the right answer
mid-playback, a new `nextPrompt()` starts while the old one is still
suspended. Each prompt captures `promptToken++` into `myToken` and
checks it after every `await`, bailing out if it no longer matches.
Don't drop those guards.

### `MT.Audio.stop()` also cancels speech synthesis

`speechSynthesis` is global state independent of our oscillators, so
`stop()` calls `window.speechSynthesis.cancel()` too. Otherwise a queued
"K" would talk over the next prompt.

### Farnsworth gap lives in the *inter-prompt* window, not after audio

Real Farnsworth stretches inter-character gaps. With one character per
prompt there is no audible inter-character gap, so we surface it as the
delay *between* feedback and the next letter (in `evaluate()`, not
after `playMorse()`). This is intentional UX: the moment a new letter
appears, the user can key — there is no silent post-prompt lockout.
This is gated on `audioWasOn` because cadence training has no meaning
when audio is off and the user is doing pure visual recall.

If a user complains that "the timer is ignoring my early input," that
regression has likely been re-introduced. See the AIDEV-NOTE at
`js/audio.js:92`.

### `triggerReplay()` is the single entry point for Replay

Both the Replay button click and the `R` key go through
`triggerReplay()`, which cancels any pending auto-advance before
replaying. If you wire up another way to replay (touch gesture,
external trigger), route it through `triggerReplay`, not `playCurrent`,
or the auto-advance can cut off the replay.

### Iambic keyer (WPM-locked, Mode A)

Holding a paddle key generates dits or dahs at the trainer's *own* WPM,
not whatever the OS typematic delay/rate would do. Squeezing both
paddles alternates. This is implemented as a small state machine in
`js/app.js` (`scheduleNextElement`, `startKeyerIfNeeded`, `resetKeyer`)
sitting on top of `appendSymbol` — every emitted element still goes
through the same buffer/eval path as a tap.

Why we don't just trust `keydown`:

- OS typematic is ~500 ms initial delay then ~30 ms repeat. Neither
  matches WPM, and a stuck-down key dumps a flurry of dits the moment
  the typematic threshold is crossed.
- `keydown` events with `event.repeat === true` are dropped. The keyer
  paces its own elements via `setTimeout(elementMs + gap)` where
  `elementMs` and `gap` come from `1200 / MT.Audio.getCharWpm()`.

Mode A semantics (no Mode B "memory"):

- At each timer tick, look at current `ditDown` / `dahDown`. If both
  held, alternate from `lastElement`; if one held, repeat that paddle;
  if neither, exit.
- Tap-and-release within one element duration: emits exactly one
  element (the synchronous first tick), then exits.
- Sending `W` (`.--`): hold dit, press dah while holding, release dit
  during the dah, release dah after the second dah. The release-dit
  step lets the keyer see only-dah-held at the next decision and stop
  alternating.

Lock-transition reset:

`resetKeyer()` clears the timer AND resets `ditDown` / `dahDown` /
`lastElement`. It's called from `nextPrompt`, `evaluate`, and
`triggerReplay`. Why also reset paddle flags (not just the timer)? If
the user is physically holding a paddle when a prompt boundary lands,
we don't want to silently auto-fill the next prompt — fresh keydown
required. This matches the pre-iambic contract (where holding through
a prompt boundary also did nothing useful, since OS typematic doesn't
carry across either).

If you add a new way to lock input (a new pause overlay, etc.),
remember to call `resetKeyer()` at the lock transition or you'll get a
stuck timer that fires sidetone into a locked UI.

The `appendSymbol → evaluate → resetKeyer` re-entry path is real:
`scheduleNextElement` calls `appendSymbol`, which can call `evaluate`,
which calls `resetKeyer`. After that returns, `scheduleNextElement`
checks `inputLocked` and bails before scheduling the next tick. Don't
remove that check — without it you'll schedule a timer that
immediately exits, harmless but ugly.

### Wrong-answer rendering reuses `#morseVisual`

When the user gets it wrong, `showFeedback(false)` puts the correct
Morse into `#morseVisual` (visible regardless of whether the visual
aid is on for that character) with the `wrong-answer` class for red
+ a `::before` ✗ prefix. The `#feedback` element gets a pronounceable
form ("dah dit dah") because `#morseVisual` isn't `aria-live` (it'd
fire on every prompt and be unbearable).

`renderPrompt()` strips the `wrong-answer` class on the next prompt.
If you ever change which element holds the answer, remember the
aria-live split.

## Input handling

- The global `keydown` handler in `bindKeys()` exits early if
  `isInteractiveTarget(e.target)` is true — buttons, summaries, inputs,
  selects, textareas, anchors, contenteditable. Without that exemption,
  pressing Space on a focused button would be eaten and the user
  couldn't activate it. See the AIDEV-NOTE in `js/app.js`.
- Both keyboard and touch paddles drive the **iambic keyer state
  machine** (`ditDown` / `dahDown` flags + `scheduleNextElement`); they
  do not call `appendSymbol` directly any more. See the "Iambic keyer"
  subsection above.
- Touch paddles use `pointerdown` + `pointerup` + `pointercancel` with
  `setPointerCapture`, plus a `click` listener (gated by a `handled`
  flag) so keyboard activation of a focused paddle button still emits
  exactly one element via a synchronous down→up.
- `appendSymbol()` evaluates as soon as the buffer either matches or
  diverges from the target. Auto-submit is the default; the
  `state.settings.autoSubmit` field exists in storage but isn't UI-bound
  yet.
- Reserved keys (Space, Enter, Backspace, R, N, Tab, Escape) cannot be
  rebound to dit/dah, and the two paddles must differ. Validation lives
  in `MT.SRS.isValidKeyChar` and is enforced in `updateKeyBinding()`
  with inline error feedback at `#keyBindingStatus`.

## Persistence and trust

`localStorage` is treated as **untrusted user-controlled data** — a
user (or a bug, or a future migration) could put anything in there.
Every load goes through `normalizeSettings`, `normalizeActiveChars`,
`normalizeProgress`, `normalizeStats`, `normalizeHistory`. The progress
map uses `Object.create(null)` and explicitly skips `__proto__`,
`constructor`, `prototype` keys to prevent prototype pollution.

The progress table in `app.js` is built with `document.createElement` +
`textContent` only — no `innerHTML`, no template strings into the DOM.
A crafted entry like `{trials: "<img onerror=...>"}` must not be able
to inject HTML. See AIDEV-NOTE at `js/app.js:392`.

If you add new persisted fields, add a normalizer for them. Don't trust
the JSON.

## SRS tuning constants (in `js/srs.js`)

```
RECENT_WINDOW        = 10   attempts kept per character
ADD_THRESHOLD        = 0.9  recent accuracy needed to promote
ADD_MIN_TRIALS       = 8    min recent attempts before promotion eligible
DROP_THRESHOLD       = 0.4  newest char drops below this → demoted
DROP_MIN_TRIALS      = 8
FADE_AID_THRESHOLD   = 0.85 audio/visual aid fades at/above this
FADE_AID_MIN_TRIALS  = 10
DROP_COOLDOWN_TRIALS = 12   gate after a drop before re-promotion
```

`dropCooldown` exists because of a real bug encountered during
development: after dropping a struggling char, the remaining (mastered)
chars all still passed the threshold, so the next attempt would
immediately re-promote the same character into a tight loop. The
cooldown gives the active set time to re-stabilize first. Don't remove
it without a replacement.

## Active char floor

`maybeAdjustActiveSet()` will not drop the active set below 2
characters. The picker also handles `chars.length === 1` cleanly. If
you change the floor, audit the picker.

## Testing

There's no unit test runner. Verification is browser-based; the Chrome
DevTools MCP tools were used during development to:

- `take_snapshot` / `take_screenshot` for visual checks
- `evaluate_script` to drive `MT.SRS.recordAttempt()` repeatedly to
  verify promote/drop transitions without typing them by hand
- `press_key` / `click` to verify keyboard and pointer paths
- `list_console_messages` for runtime errors

For UI changes, actually load `index.html` and exercise the feature.
Type checking and linting won't catch UX regressions like the
post-prompt input lockout.

## Workflow conventions

- The `/codex-review` skill (configured globally) was used after each
  significant commit during initial development to get an external
  review pass. It found real issues each time (XSS, prototype pollution,
  race conditions, accessibility gaps, transition rule replacement,
  replay/key parity). Worth running again on substantive changes.
- Commits so far have used short imperative subjects (`Add Morse trainer
  web app`, `Move Farnsworth pause into the inter-prompt gap`,
  `Address codex review: …`). Match that style.
- The `prompt` file at the repo root is the user's original brief. Don't
  delete it; it's helpful context for future feature requests.

## AIDEV anchors to know about

```
js/app.js   ditDown/dahDown/keyer state — why a WPM-locked keyer instead of trusting OS keyrepeat
js/app.js   isInteractiveTarget — why the global key handler exempts buttons/summaries
js/app.js   renderProgressTable — why DOM APIs only, no innerHTML
js/srs.js   makeProgressMap — why null-prototype map for untrusted data
js/srs.js   replaceState — why mutate in place, not reassign
js/audio.js farnsworthGapMs — why Farnsworth lives in the inter-prompt gap
```

`grep -rn 'AIDEV-' js/ style.css` to see them all. Don't remove these
without an explicit reason — they exist because something subtle was
once wrong. (Line numbers intentionally omitted — they drift; grep is
the source of truth.)

## Things to ask before changing

- Adding a build step / framework / dependency.
- Changing the storage key (`morsetrainer.v1`) — would orphan everyone's
  saved progress.
- Changing the Koch order — users have built mental models around it.
- Removing the start overlay — it exists because browsers gate
  `AudioContext` on a user gesture.
- Changing default dit/dah keys (`[` / `]`) — these were chosen
  deliberately for non-shifted, single-key access on US layouts.
