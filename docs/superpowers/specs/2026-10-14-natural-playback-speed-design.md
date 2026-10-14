# Natural Playback Speed Design

## Goal

Make speech at non-1× playback speeds sound more natural by preserving its original pitch, while keeping the existing lesson timeline, seeking, sentence looping, dialog boundaries, and desktop subtitles synchronized.

## Current behavior

The player changes `HTMLAudioElement.playbackRate` directly. The browser controls both tempo and pitch processing. The same audio element supplies `currentTime` to sentence highlighting, click-to-seek, loop boundaries, and the desktop subtitle window.

## Proposed design

Use SoundTouchJS's AudioWorklet implementation as a local, same-origin audio output processor. Keep the existing `HTMLAudioElement` as the sole source and playback clock. Create one `AudioContext`, one `MediaElementAudioSourceNode`, and one SoundTouch worklet node after playback is initiated by a user gesture. Route the media element through the worklet to the context destination.

For a selected rate `r`, keep `audio.playbackRate = r` so media time and all existing controls advance at the selected rate. Disable the element's built-in pitch correction while the worklet is active and set the worklet's playback-rate compensation parameter to `r`, with its pitch target fixed at the original pitch. This makes the worklet responsible for pitch compensation rather than stacking browser and worklet correction. At 1×, the same pipeline remains active so switching speeds does not rewire or recreate the media element source.

Bundle the processor and its small main-thread wrapper inside the repository under `assets/vendor/`; do not load runtime code from a CDN. Add license and version notes for the vendored dependency. No audio is uploaded or rewritten.

## Playback lifecycle and fallback

- Initialize and resume the AudioContext from a user-initiated play or sentence-click action.
- Connect the media element only once; repeated play, pause, lesson selection, seeking, and speed changes reuse the same graph.
- Keep the existing media element as the source of `currentTime`, `duration`, `ended`, and range seeking. Existing sentence and dialog playback ranges therefore continue to use the same timeline.
- If AudioWorklet is unavailable, processor loading fails, or the context cannot start, keep playback functional with native `playbackRate`, show a concise status explaining that natural speed processing is unavailable, and avoid leaving the media element disconnected from audible output.
- AudioWorklet is enabled only in a secure browser context (HTTPS or localhost). Other origins use the native fallback.
- Closing the desktop subtitle window does not suspend or disconnect audio. Page teardown closes the AudioContext where supported.

## User-visible behavior

- Preserve existing speed choices (0.5×, 0.75×, 1×, 1.25×, 1.5×, 1.75×, 2×), persistence, and synchronization between the main player and desktop subtitle window.
- Keep the current selected speed and all playback preferences in the user's local browser storage.
- Clearly indicate when native fallback is active; do not change the selected speed silently.

## Scope

Expected files:

- `player.js`: initialize and manage the audio graph; centralize speed updates and fallback status.
- `assets/vendor/`: locally served SoundTouchJS worklet and wrapper, with version/license notice.
- `index.html`: load the local integration module if the wrapper requires a separate entry point and update cache versions.
- `tests/`: test lifecycle, speed propagation, fallback, and preservation of the media-time interactions.
- `README.md`: document secure-context requirements, local dependency, and native fallback.

No server-side audio processing, conversion of the 365 MP3 files, changes to lesson data, or replacement of the media element's seek timeline are in scope.

## Verification

- Unit or browser tests verify a single media-source connection, AudioContext resume on user gesture, rate propagation to both the media element and pitch-preserving processor, and native fallback on unsupported/failed worklet setup.
- Existing tests continue to verify sentence selection, dialog clamping, single-sentence loop, lesson transition, and subtitle synchronization.
- In a supported browser, manually compare the same speech at 1×, 1.25×, 1.5×, and 2×; confirm pitch remains stable and no extra playback gap or repeated audio appears after seeking or looping.
- Verify the app works without external network access after its page and lesson files are loaded.

## Risks and constraints

- Time-stretch algorithms can introduce artifacts at extreme rates; pitch preservation does not guarantee identical sound quality to a commercial player. The design is intended to improve speech quality, particularly around the commonly used 1.25×–1.5× range.
- WebAudio media-element routing can become silent if graph initialization partially fails. Fallback must preserve a direct audible route and must not attempt to create a second `MediaElementAudioSourceNode` for the same element.
- AudioWorklet deployment requires HTTPS or localhost; LAN HTTP remains on the native path.
- Vendored third-party code must retain its license notice and exact version provenance.
