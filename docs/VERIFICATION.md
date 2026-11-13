# Verification results

Recorded 2026-11-12 on Windows 11 with Microsoft Edge 157 (headless) on a six-core desktop PC
with a discrete GPU (the sync and rendering measurements below are from the 2026-11-11 run). Reproduce with `npm run media` followed by `npm test` (dev server) or
`npm run test:preview` (production build).

| Run | Result |
| --- | --- |
| Dev server | **186 / 186 passed**, 0 flaky, 12.4 min |
| Production build (`vite build` + `vite preview`) | **186 / 186 passed**, 0 flaky, 12.1 min |

| Spec | Tests |
| --- | --- |
| `01-matrix` — every container × codec on automatic routing | 25 |
| `02-tiers` — forced WebCodecs / MSE / FFmpeg-WASM / native play-through | 24 |
| `03-renderers` — WebGPU / WebGL2 / Canvas 2D, colour accuracy, HDR, shaders | 20 |
| `04-sync` — A/V sync, speed, pitch, downmix | 12 |
| `05-subtitles` — ASS / SRT / WebVTT / PGS, fonts, frame accuracy | 13 |
| `06-ui` — skins, key bindings, stats, public API | 8 |
| `07-stress` — seeking, stepping, teardown, leaks | 9 |
| `08-fallbacks` — degraded environments | 10 |
| `09-mobile` — double-click, touch gestures, small screens | 9 |
| `10-streaming` — network input, threads, cross-origin isolation | 9 |
| `unit` — AudioWorklet DSP, input block cache and pure logic, in Node | 47 |

## Test media (synthesised with ffmpeg `lavfi`, 33 clips)

- Containers: MP4, MKV, WebM, MPEG-TS, AVI, FLV (+ MP3, FLAC, Ogg, M4A audio-only)
- Video: H.264, HEVC (8 and 10 bit), VP9 (8 and 10 bit), AV1 (8 and 10 bit), MPEG-4 ASP
- Audio: AAC, Opus, MP3, AC-3 (stereo and 5.1), FLAC
- Colour: BT.709 and BT.601 patches in 8/10 bit, BT.2020 PQ patches and PQ luminance steps
- Subtitles: torture ASS (animation, `\move`, `\org` rotation, `\p1` béziers, clip-strip gradient,
  `\k`/`\kf`/`\ko`), deterministic sync ASS, SRT, WebVTT, PGS; an MKV with three ASS tracks, an
  SRT track, a PGS track and an attached TTF

Every video clip carries a 12-bit binary frame counter and a flash synchronised with a beep, so
tests read the frame number back from rendered pixels and compare it with the audio clock.

Two more clips exist for benchmarks only: 20 s of 1080p with film-grain-like noise, as H.264 at
8 Mbit/s (20.5 MB) and as 10-bit HEVC at 6 Mbit/s.

## Automatic routing over the matrix (this machine)

| Route | Clips |
| --- | --- |
| `webcodecs` | 14 |
| `webcodecs+wasm-audio` (AC-3) | 3 |
| `wasm-remux-mse` (FLV) | 1 |
| `wasm-transcode-mse` (AVI, MP3 → AAC) | 1 |
| `wasm-sw` (MPEG-4 ASP in AVI) | 1 |

All of them rendered through WebGPU.

## Measurements

| Check | Result | Limit asserted |
| --- | --- | --- |
| Clock − PTS at presentation, WebCodecs | avg 4.4 ms, max 8.6 ms | avg < 22, max < 60 |
| Clock − PTS at presentation, FFmpeg WASM | avg 4.4 ms, max 8.7 ms | avg < 22, max < 60 |
| Frame on screen vs. audio clock (pixel truth), all tiers | mean 0.25–0.27 frames, worst 0.70 | within −2.3 … +1.5 frames |
| Flash on screen vs. beep audible, WebCodecs | mean −6.5 ms, worst 12.9 ms | each < 45, mean < 25 |
| Flash on screen vs. beep audible, FFmpeg WASM | mean −3.4 ms, worst 9.1 ms | each < 45, mean < 25 |
| 60 fps clip | 149 frames on 149 refreshes in 2.5 s, 2 skipped | ≥ 93 % of refreshes |
| Longest stall while playing 21 routes end to end | 65 ms | < 900 ms |
| WSOLA pitch at 0.5× … 3× (unit, 220 Hz tone) | 220.0 Hz, full amplitude | ± 0.5 Hz |
| libass on the torture script | 236 frames on 237 refreshes, 0 busy | ≥ 90 %, < 5 % busy |
| 45 rapid seeks, WebCodecs | 585 `VideoFrame`s opened, 585 closed, peak 13 alive | 0 leaked, ≤ 48 alive |
| 18 create/load/seek/destroy cycles | 422 `VideoFrame`s and 39 textures, all released; heap 20.1 → 14.3 MB | 0 leaked, < 12 MB growth |

Headless Edge on this machine delivers only about 35–55 animation frames per second, even on an
idle page, so cadence assertions are expressed relative to the refreshes that actually occurred.
The figures above are from one run and move with that refresh rate: a frame is shown up to one
refresh ahead of the clock, so in a later run at about 40 refreshes per second the largest
picture lead seen was 1.14 frames, inside the 1.5-frame limit.

The same limit shows on the `<video>`-element routes (MSE and native), where the browser's
compositor decides which frames surface: at about 40 refreshes per second it reports 15–25 % of
a 30 fps clip as dropped. Measured on five play-throughs, frames handed to the renderer plus
frames the browser reported as dropped came to 238–240 of 240 every time, so the suite asserts
that accounting (at least 95 % of frames accounted for, at least 55 % rendered) rather than a
fixed frame count. The WebCodecs route, which runs its own frame queue, presented 240 of 240 in
the same measurement.

## Decoding and network (FFmpeg route, 2026-11-12)

The network figures are for the 20.5 MB H.264 benchmark clip served over a simulated link of
20 Mbit/s with 50 ms of latency per request (the dev server's `/slow/` route, which paces all
responses together and counts what it serves).

| Check | Result | Limit asserted |
| --- | --- | --- |
| Decode rate, 1080p 10-bit HEVC, one thread | 41–44 frames per second | — |
| Decode rate, same clip, multi-threaded core (now the default) | 120 frames per second (as fast as the 4× speed test asks for) | > 1.3 × single-thread and > 45 |
| First frame over the link | 1.7 s, after 2.7 MB of the file (published version: 9.1 s, after all of it) | < 5 s and < 60 % of the file |
| Playback over the link | rate 1.000, longest stall 32 ms, 3 requests in all | rate > 0.97, stall < 300 ms, ≤ 8 requests |
| Same without `SharedArrayBuffer` | first frame after 3.2 s and 6.8 MB; then rate 1.000, longest stall 28–35 ms | < 6 s; rate > 0.97; stall < 300 ms |
| Two seeks and a second of playback over an 8 Mbit/s link | exact frames (1002 and 375), a handful of range requests | exact frame; ≤ 8 requests |
| A file opened from disk, three seeks, with and without `SharedArrayBuffer` | exact frames 1002, 75, 1710 | exact |
| One thread at a requested 4× (decoder delivers a third of that) | keeps moving, longest stall about 0.3 s (before the fix: stuck in 3 of 6 runs) | stall < 1.5 s in three runs |
| Unreachable URL | error after about 12 s | < 40 s |

Without `SharedArrayBuffer` and without the network in the way, a decode slice at 1080p now costs
22.6 ms per frame for H.264 (was 38.9) and 47 ms for 10-bit HEVC (was 110): H.264 plays, 10-bit
HEVC still does not keep up on one thread, which is why the demo page isolates itself.

## Pointer and small screens (2026-11-12)

| Check | Result |
| --- | --- |
| Double-click on the picture | binding runs, the paused flag never changes (it used to flip twice) |
| Four skins (three built-in, one loaded package) × 375×812, 320×568, 812×375, 768×1024 | no control outside the player; every button at least 40 px (34 px in the mpv skin); play, seek bar and fullscreen always present |
| Tap / double tap | controls show and hide without pausing; ±10 s on the sides; play/pause in the middle |
| Overflow menu | bottom sheet across the player; submenus and back; toggles keep it open |

Not covered: real phones and tablets. The layout and gestures were exercised with Chromium's
touch and mobile emulation only.

## Defects found and fixed by the suite

- WSOLA silently skipped phase alignment after releasing input (pitch drifted ~13 % at 2×).
- Audio starved behind libavformat's 256 KiB output buffer while video blocked on back-pressure.
- FFmpeg seeks in MPEG-TS could land after the target, losing frames; added decode pre-roll.
- Timeline was rebased onto AAC's negative priming timestamp (every frame 21 ms off round times).
- MSE pipeline could hang on a seek to a position already current, or just before the first frame.
- Forced software decode of a codec the FFmpeg core lacks (AV1) deadlocked in preroll.
- First libass draw after the overlay was created/resized never reached the screen when paused;
  the same happened when a font arrived late.
- Subtitles were rendered twice per refresh, leaving libass busy for 38 % of requests.
- Skin CSS: `url("data:…")` was stripped, comments mentioning `@keyframes` broke hoisting, and
  minified `[data-skin=id]` selectors were double-scoped in production builds.
- pthread FFmpeg core could not start under the dev server, and its failed start poisoned the
  single-thread fallback.
- `vite preview` gzipped media whose file type it did not recognise (MKV, AVI, FLV, PGS) while
  answering range requests for the same file uncompressed under the same ETag. The browser cache
  mixed the two and FFmpeg's download of the file sometimes came back damaged (2 of 24 FLV
  play-throughs in a reproduction loop), so playback ended early without an error. The dev and
  preview servers now send explicit content types, the matrix spec asserts that every clip is
  served uncompressed, and the same loop then completed 30 of 30.
- A double-click paused and resumed the video on its way to fullscreen (click, click, dblclick).
- Below roughly 700 px of width the mpv and Studio skins clipped their buttons off the edge, and on
  a phone several controls could not be reached at all.
- The FFmpeg route downloaded the whole file before starting (9 s for 20 MB at 20 Mbit/s) and then
  read it 32 KiB at a time through a synchronous API.
- After an audio underrun on the FFmpeg route the player could wait for ever: it wanted 0.3 s of
  audio, FFmpeg was blocked on a full picture queue and could deliver 0.29 s.
- A URL that could not be reached was retried without end instead of being reported.
