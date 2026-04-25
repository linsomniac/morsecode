# Morse Trainer

A single-page web app for learning Morse code. No build step, no server,
no dependencies — just open `index.html` in a browser.

## What it does

Shows you a letter, plays its Morse code, and waits for you to key it back.
As you get faster and more accurate, it adds new characters and starts
fading out the audio and visual aids so you're working from memory.

It uses the **Koch method** for character order (K, M, U, R, E, S, …) and
a lightweight **spaced-repetition system** that picks weak characters more
often than mastered ones.

## Features

- **Adaptive character set.** Starts with K and M. After ~8 attempts each
  at ≥90% recent accuracy, the next Koch character is added. If a newly
  added character drops below 40% accuracy, it's pulled back out (with a
  cooldown so it doesn't immediately re-promote).
- **Adaptive aids.** Audio playback and the visual `· − ·` representation
  fade out per-character once you hit ≥85% recent accuracy. You can force
  them on or off in settings.
- **Adjustable speed.** Character WPM (5–35) plus a separate Farnsworth
  effective WPM (the inter-prompt gap). Both persist across reloads.
- **Tone control.** 300–1000 Hz sine sidetone.
- **Optional letter announcement.** Speaks the letter aloud before the
  Morse plays (uses the browser's Web Speech API).
- **Multiple input methods.** Keyboard (`[` dit, `]` dah by default),
  on-screen touch paddles, and USB Morse keys that emulate a keyboard
  (configurable dit/dah characters).
- **Progress table.** Per-character trial count, recent accuracy,
  lifetime accuracy, and current aid status.
- **Local persistence.** Settings, progress, and active character set
  live in `localStorage` under `morsetrainer.v1`.
- **Reset.** One button wipes all stored progress.

## Running it

Open `index.html` directly in a modern browser, or serve the directory
with anything (`python3 -m http.server`, etc.). Browsers gate audio on a
user gesture, so you'll get a "Start training" overlay first.

Tested in Firefox and Chromium. Speech synthesis quality depends on the
browser/OS voices.

## Controls

| Key | Action |
| --- | --- |
| `[` | Send dit (`.`) |
| `]` | Send dah (`-`) |
| `Space` / `Enter` | Submit the current Morse buffer |
| `Backspace` | Erase last symbol |
| `R` | Replay the current Morse |
| `N` | Skip to next prompt |

The dit/dah keys are remappable in **Settings → Key bindings** if your
USB Morse key emits different characters. Reserved keys (Space, Enter,
Backspace, R, N, Tab, Escape) and using the same key for both paddles
are rejected.

Auto-submit fires as soon as the buffer either matches the target or
diverges from it (no need to hit `Enter` for normal play).

## Settings

- **Character speed (WPM).** Speed of the dits and dahs themselves.
- **Effective WPM (Farnsworth).** Stretches the gap *between* prompts so
  characters are sent at full speed but you get more thinking time. Must
  be ≤ Character WPM (clamped automatically).
- **Tone (Hz).** Sidetone frequency.
- **Speak the letter before the Morse.** Uses speech synthesis to say
  the letter aloud right before the Morse plays. Useful when first
  introducing a character.
- **Audio aid / Visual aid.** `adaptive` (default), `always`, or
  `never`. Adaptive fades out per-character once you're consistently
  getting it right.

## Data storage

Everything lives in `localStorage` under the key `morsetrainer.v1`. To
fully reset, either click **Reset all progress** or clear the site's
storage in browser devtools.

The persisted shape is validated and clamped on load — corrupted or
hand-edited state won't break the app, it'll just be normalized to safe
defaults.

## Files

```
index.html       markup + start overlay
style.css        dark/light auto theme, layout, animations
js/morse.js      Morse table + Koch teaching order
js/audio.js      Web Audio sidetone, Farnsworth gap, speech synthesis
js/srs.js        localStorage persistence, weighted picker, Koch promote/drop
js/app.js        UI orchestration, prompt cycle, input handling
```

No frameworks, no bundler, no package.json. Loaded as classic
`<script>` tags so it works over `file://`.

## Accessibility

- Feedback uses `aria-live="polite"` and includes a pronounceable form
  of the Morse ("dah dit dah") on wrong answers, so screen readers get
  the answer rather than just the visual `−·−`.
- Wrong-answer state has both a color change *and* a `✗` prefix, so it
  reads correctly without color perception.
- All interactive controls are keyboard-reachable; `:focus-visible`
  outlines are styled.
- Respects `prefers-color-scheme` for dark/light themes.
