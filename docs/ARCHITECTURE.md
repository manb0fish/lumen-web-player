# Lumen Player — Architecture

Lumen is a web media player built the way `mpv` is built: a headless core that owns timing and
decoding, a GPU video-output chain, a libass subtitle renderer, and a UI that is only a client of
the core. This document describes how the pieces fit, and records the engineering trade-offs that
were made along the way.

## 1. System overview

```
                                        ┌──────────────────────────────────────────────┐
   File / Blob / URL ──► PROBE ──► ROUTER (capability probing, ordered plan + fallbacks) │
                                        └───────┬───────────────┬───────────────┬──────┘
                                                │               │               │
                              ┌─────────────────▼──┐  ┌─────────▼────────┐  ┌───▼─────────────────────┐
                              │ TIER 1  WebCodecs  │  │ TIER 2  MSE      │  │ TIER 3  FFmpeg WASM     │
                              │ media-worker       │  │ media-worker     │  │ ffmpeg-worker           │
                              │  mediabunny demux  │  │  mediabunny      │  │  custom char devices    │
                              │  VideoDecoder      │  │  demux → fMP4    │  │  /dev/lumen_{v,a,m}     │
                              │  AudioDecoder      │  │  remux           │  │  sw decode │ remux      │
                              └───┬───────────┬────┘  └────────┬─────────┘  └──┬───────┬───────┬──────┘
                       VideoFrame │       PCM │         fMP4   │    YUV planes │   PCM │  fMP4 │
                    (transferred) │ (MessagePort, no main thread)              │       │       │
                                  │           │                │               │       │       │
                    ┌─────────────▼───────────┼────────────────┼───────────────▼──┐    │       │
                    │   FRAME PIPELINE  (sync engine)          │                  │    │       │
                    │   PTS-sorted queue · hold/preroll state  │   ELEMENT        │    │       │
                    │   machine · drop/late accounting         │   PIPELINE ◄─────┼────┼───────┘
                    └─────────────┬───────────▲────────────────┤   <video> + MSE  │    │
                                  │           │ clock          │   rVFC frames    │    │
                                  │   ┌───────┴────────────────▼──────────────────▼────▼──────┐
                                  │   │ AUDIO ENGINE   AudioWorklet = PCM sink + MASTER CLOCK │
                                  │   │ ring buffer · WSOLA time-stretch · resampler ·        │
                                  │   │ ITU downmix → normalizer → gain → analyser → output   │
                                  │   └───────────────────────────────────────────────────────┘
                                  │ MediaFrame (VideoFrame | YUV planes | <video>)
                    ┌─────────────▼──────────────────────────────────────────────────────────┐
                    │ RENDERER      WebGPU  ──►  WebGL2  ──►  Canvas 2D   (auto-degrading)   │
                    │ ingest (external | planar YUV, PQ/HLG, tone map, gamut) → deband →     │
                    │ scale (bicubic | Lanczos-3 | EASU) → RCAS sharpen + dither             │
                    └─────────────┬──────────────────────────────────────────────────────────┘
                                  │ same rect, same timestamp
                    ┌─────────────▼──────────────────────────────────────────────────────────┐
                    │ SUBTITLES   libass (JASSUB, WASM worker → OffscreenCanvas) · PGS       │
                    │ Matroska scanner (tracks, cues, font attachments) · SRT/VTT → ASS      │
                    └────────────────────────────────────────────────────────────────────────┘

   ═══════════════════════ headless core boundary ═══════════════════════════════════════════════
     Player:  Store (reactive state) · CommandBus (mpv commands/properties) · Events · Plugins
   ═══════════════════════════════════════════════════════════════════════════════════════════════
     UI (optional):  SkinEngine (JSON manifest + CSS tokens) · control registry · OSD · stats ·
                     inspector · KeyBindings (input.conf)
```

## 2. Module map

| Path | Responsibility |
| --- | --- |
| `src/core/player.ts` | The headless `Player`: load/route/fallback orchestration, renderer management, transport, mpv property + command definitions, plugin host, stats, debug hooks. |
| `src/core/store.ts` | `Store` (batched reactive state) and `Emitter`. |
| `src/core/commands.ts` | mpv-style command bus: `set`, `add`, `multiply`, `cycle`, `cycle-values`, typed properties, OSD hooks. |
| `src/core/keybindings.ts` | `input.conf` parser, DOM key → mpv key names, default map. |
| `src/pipeline/router.ts` | Capability detection and route planning (ordered plan = primary + runtime fallbacks). |
| `src/pipeline/media-worker.ts` | Worker: mediabunny demux, WebCodecs decode loops with back-pressure, on-the-fly fMP4 remux for MSE, key-frame thumbnails. |
| `src/pipeline/ffmpeg-worker.ts` | Worker hosting the FFmpeg WASM core; turns the blocking CLI into streams through custom Emscripten devices. |
| `src/pipeline/sources.ts` | `FrameSource` adapters (`WebCodecsSource`, `FfmpegSource`) the sync engine consumes. |
| `src/pipeline/frame-pipeline.ts` | A/V sync engine for frame-push tiers. |
| `src/pipeline/element-pipeline.ts` | `<video>`-based pipeline (MSE fed by mediabunny or FFmpeg; native `src`). |
| `src/audio/worklet.js`, `engine.ts` | AudioWorklet processors and the Web Audio graph / clock facade. |
| `src/render/*` | Renderer interface, WebGPU (`wgsl.ts`), WebGL2 (`glsl.ts`), Canvas 2D, shared colour math. |
| `src/subs/*` | Subtitle manager (JASSUB), Matroska scanner, SRT/VTT conversion, PGS decoder. |
| `src/ui/*` | Skin engine, control registry, menus, overlays, three built-in skins. |
| `src/element.ts` | `<lumen-player>` custom element. |
| `scripts/gen-*.mjs` | Test-media synthesis (ffmpeg lavfi), torture ASS generator, PGS writer. |
| `tests/` | Playwright end-to-end suite + Node-level unit tests. |

## 3. Decode tiers and routing

Every load starts with a **probe** in the media worker (container, tracks, codec strings, colour
metadata, and `VideoDecoder/AudioDecoder.isConfigSupported` for the actual decoder configs). The
router turns that into an *ordered plan*; the first entry is used and the rest are runtime
fallbacks if a pipeline fails fatally (verified by injecting a decoder fault mid-stream).

| Situation | Route (`mode`) |
| --- | --- |
| Container readable in JS, both codecs decodable | `webcodecs` |
| …but WebCodecs missing or it rejects a track, MSE can take it | `mse-remux` (mediabunny → fragmented MP4 → `SourceBuffer`) |
| Video decodable, audio codec foreign (AC-3, E-AC-3, DTS…) | `webcodecs+wasm-audio` — hardware video stays, FFmpeg decodes only the audio |
| Video codec foreign (e.g. HEVC without a platform decoder, MPEG-4 ASP) | `wasm-sw` — FFmpeg software decode → YUV planes + PCM |
| Container not readable in JS (AVI, FLV…), codecs fine | `wasm-remux-mse` — FFmpeg stream copy → fMP4 → MSE |
| …same, audio codec not MSE-able | `wasm-transcode-mse` — copy video, transcode audio to AAC |
| Nothing else | `native` (`<video src>`) |

A forced tier (`tier=webcodecs|mse|wasm`) is *strict*: if it cannot play the file the load fails
with an explanatory error instead of silently rerouting.

### Tier 3: streaming out of a blocking CLI

`@ffmpeg/core` exposes FFmpeg as a synchronous `exec()`. Three techniques make it a streaming
decoder:

1. **Custom character devices.** `/dev/lumen_v`, `/dev/lumen_a`, `/dev/lumen_m` are registered with
   Emscripten's FS. FFmpeg writes rawvideo, f32le PCM or fMP4 to them and each `write()` lands in
   JS *while `exec()` is still running*, where it is framed and posted out immediately.
2. **Exact timestamps from `showinfo`.** The filter logs each frame's PTS synchronously just before
   the frame reaches the muxer, so raw frames are paired with their true timestamps (VFR-safe).
3. **Flow control with `Atomics`.** With SharedArrayBuffer, device callbacks block on
   `Atomics.wait` until the presentation queue has room / the clock has advanced, and abort the
   run when the generation counter changes (seek). One `exec()` covers the rest of the file.
   **Without SAB** the worker is unreachable during `exec()`, so the client requests short,
   self-terminating segments (`-ss T -t D`) and paces them itself.

Details that mattered in practice:

- libavformat buffers 256 KiB per "file" output, which starved audio while video blocked on
  back-pressure → `-flush_packets 1`.
- For stream-copy into MSE the muxer must keep source timestamps so fragments land at their real
  position: `-copyts -start_at_zero -avoid_negative_ts disabled -movflags +frag_discont`. With the
  shift disabled the muxer stays in its edit-list mode, where a fragment starts at the presentation
  time of its first packet and an edit list is expected to take the B-frame delay back out; an
  empty `moov` has none, so `+negative_cts_offsets` is needed as well, or every picture of a stream
  with B-frames is shown that delay too late (two frames for typical H.264).
- A stream copy that FFmpeg aborts on (video without presentation timestamps, such as B-frames in
  AVI) leaves the core unusable: the worker is replaced before the player falls back.
- Containers without a key-frame index (MPEG-TS…) can seek *past* the target; those get a 3 s
  decode pre-roll that is trimmed with `trim/atrim`.
- The core is probed for its decoder list at start-up; a codec it cannot software-decode is
  reported up front rather than discovered as a stall.

### Threads

The multi-threaded core (`@ffmpeg/core-mt`) is the default wherever it can run: a cross-origin
isolated page on a machine with at least four logical cores. Measured on the 1080p benchmark
clips, the decoder alone manages about 42 frames per second of 10-bit HEVC on one thread (barely
above real time, so any hiccup shows) and more than 110 with threads; H.264 goes from about 70 to
more than 110. If the threaded core fails to start, the single-thread core takes over.

### Reading the input

FFmpeg pulls its input through synchronous `read()` calls of about 32 KiB, on the thread that
demuxes and decodes. Handing those straight to a `File` on a network share, or downloading a URL
in full before starting (what the first version did), either stalls the decoder on every read or
delays the first frame by the length of the download. Reads therefore go through a block cache
(`ffmpeg-io.ts`, 256 KiB blocks, 48 MiB):

- A **read-ahead worker** (`io-worker.ts`) streams the source — one HTTP range request, or a
  stream over the `Blob` — and keeps a 16 MiB window of blocks ready in front of the reader. It
  follows the reader by the position the reader publishes; when the first missing block is not
  where the current stream is heading, the stream is reopened there. A seek costs one request;
  steady playback is one long download that pauses, by not reading, when the window is full.
- **With SharedArrayBuffer** the cache is shared memory. The worker writes blocks into slots it
  has claimed (free → filling → ready), and only the reader frees ready slots, so a slot's bytes
  never change while the reader can see it and no lock is needed. FFmpeg's `read()` becomes a
  `memcpy`; it waits (on `Atomics.wait`, abortable by a seek) only when it overtakes the network.
- **Without it** nothing can reach a worker that is inside `exec()`, but a second worker can still
  download in parallel. It posts the blocks, and they are picked up between two `exec()` calls.
  Each slice therefore waits (asynchronously, before it starts) until the read-ahead worker has
  brought in the part of the file it is about to decode, estimated from its position, and then
  decodes without stopping; anything still missing is fetched synchronously in small pieces. The
  read-ahead worker cannot see the decoder's cache in this mode, so the decoder tells it exactly
  which blocks it evicted and which it fetched itself. Guessing instead made the download jump
  back and forth between the file header, which every slice re-reads, and the data.
- A server that ignores range requests is detected at open; the file is then downloaded once and
  read from memory as before.

Eviction is least-recently-used but never touches the window around the reader, so read-ahead
cannot push out blocks that have not been read yet.

### Without cross-origin isolation

No SharedArrayBuffer means no threads and no way to pace a running `exec()`, so decoding happens
in self-contained slices. A slice that starts in the middle of a GOP must decode from the previous
key frame again, which is why slices are made as long as memory allows (about 192 MB of frames on
machines with 8 GB or more). This path is a fallback: 1080p H.264 plays, 10-bit HEVC at 1080p does
not keep up on one thread. The demo page therefore turns isolation on by itself where the server
does not (see "Cross-origin isolation" in the guide).

## 4. A/V sync

- The **AudioWorklet is the master clock**. It reports `(mediaTime, contextTime, rate)`; the main
  thread converts that to "media time audible at instant *t*" with `getOutputTimestamp()`, so
  output latency is already accounted for. The context↔performance offset is low-pass filtered
  because the raw pair jitters by a few milliseconds.
- Video is scheduled against the **vsync-aligned rAF timestamp plus one refresh** (when the frame
  actually reaches the glass), not against "now". This removed cadence beating at 60 fps.
- A source that decodes audio and video in one process (FFmpeg) delivers them in file order and
  stops when the picture queue is full. After an audio underrun that used to be a standoff: the
  player wanted 0.3 s of audio before restarting the clock, the ten 1080p frames that fill the
  queue come with about 0.29 s, and no more could arrive because the queue was full and the clock
  stopped. While audio is short and the queue is full, the pipeline now lets extra pictures
  through (up to about three seconds or 256 MB) and takes the allowance back once audio is
  plentiful. Files that interleave audio and video coarsely need the same slack.
- The clock is **held** (not just the picture) during preroll and whenever video or audio runs
  dry, so the two cannot drift while rebuffering. A watchdog reports a decoder that never
  produces a frame instead of waiting forever.
- Seeks bump a generation counter; every frame, PCM chunk and worker job is tagged with it and
  stale ones are discarded at each boundary.
- The timeline origin is the first *presentable* sample: late container starts (MPEG-TS at
  1.4 s) are rebased, negative priming timestamps are trimmed rather than rebased.

## 5. Rendering

One `MediaFrame` abstraction, three sources: a `VideoFrame` (zero-copy `importExternalTexture`
on WebGPU), raw **planar YUV** (R8, or little-endian 16-bit packed into RG8 so linear filtering
still works), or a `<video>` element. The pass chain is identical in WGSL and GLSL ES 3.00:

```
ingest ──► [deband] ──► [scale: bicubic | Lanczos-3 | EASU-style] ──► RCAS sharpen + dither ──► canvas
```

The planar ingest shader does range expansion, BT.601/709/2020 matrices, PQ and HLG EOTFs, tone
mapping (BT.2390, Hable, Reinhard, clip) and BT.2020/P3 → BT.709 gamut conversion. Intermediates
are RGBA16F. Canvas 2D is the compatibility floor (CPU YUV→RGB for planar frames).

Renderer creation degrades WebGPU → WebGL2 → Canvas 2D; a lost GPU context triggers the same
chain at runtime.

## 6. Subtitles

ASS/SSA is rendered by **libass** via JASSUB (WASM in a worker, drawing to an OffscreenCanvas),
driven in manual mode by the player's own clock. SRT and WebVTT are converted to ASS so a single
engine renders all text. PGS bitmaps are decoded and composited by a small in-house decoder.

mediabunny does not expose subtitle tracks, so a compact **streaming Matroska scanner** extracts
subtitle `TrackEntry`s, their blocks, and font **attachments**; events are streamed into libass
with `ass_process_chunk` semantics while a large file is still being scanned.

Frame accuracy: the subtitle time is the audio clock clamped to the interval of the frame
currently on screen, so animation runs at display rate but an event never appears a frame early
or late. Exactly one subtitle render is issued per display refresh, right after the picture.

## 7. Headless core and UI

The core has no UI. Everything is reachable through:

- `player.store` — reactive state (`subscribe`, `watch`);
- `player.commands` — mpv vocabulary (`seek 5 exact`, `cycle pause`, `add sub-delay -0.1`,
  `multiply speed 1.1`, `cycle-values scale bilinear bicubic lanczos fsr`, …) and typed
  properties;
- `player.events` — `loaded`, `ended`, `osd`, `fallback`, `frame`, …;
- `player.use(plugin)` — plugins register commands, properties and (through the UI's
  `registerControl`) new widgets.

A **skin** is a JSON package: CSS custom-property tokens, a declarative layout (regions → rows →
control names or `{control, …options}` objects, including buttons bound to arbitrary commands),
icon overrides, optional CSS (auto-scoped with native nesting, `@keyframes` hoisted) and OSD /
auto-hide / docking options. Packages are validated and sanitised (icons reduced to inert SVG
shapes, imports and remote URLs stripped). Three skins ship: **Modern Glass**, **mpv OSC** and
**Studio Deck**; an external example lives in `public/skins/neon.json`.

## 8. Engineering decisions and trade-offs

| Decision | Why | Cost / limitation |
| --- | --- | --- |
| **Prebuilt `@ffmpeg/core` instead of a custom lean libav build** | A custom Emscripten build needs a Linux toolchain (no WSL/Docker on the build machine). Hosting the core directly — bypassing the `@ffmpeg/ffmpeg` wrapper — still gives full control (own worker, custom devices, SAB flow control, compiled-module cache). | ~32 MB, loaded lazily and only when tier 3 is actually needed. No libdav1d, so **software AV1 is unavailable in tier 3** (AV1 plays through WebCodecs/MSE). A custom build would fix both. |
| **CLI + devices rather than libav API bindings** | Works with the stock binary; exact PTS via `showinfo`. | Seek cancellation relies on SAB (or on short segments without it); per-seek re-open cost. |
| **Per-track hybrid routing** | AC-3/DTS audio should not force software *video* decode. | Two sources on one clock; inexact (key-frame) seeks are promoted to exact ones in hybrid mode. |
| **Single-thread FFmpeg core by default, pthread core opt-in** (`wasmThreads` / `?threads=1`) | The pthread core spins up a 32-worker pool at start; the single-thread core already exceeds real time on the test matrix. | Large software-decoded streams benefit from enabling threads. |
| **mediabunny for demux/remux** | Maintained, streaming, covers MP4/MOV/MKV/WebM/TS/Ogg/MP3/FLAC/WAV, and can write fragmented MP4 for the MSE tier. | No AVI/FLV (→ FFmpeg), no subtitle tracks (→ own Matroska scanner). |
| **JASSUB (libass WASM)** for ASS | Real libass = real compatibility with complex typesetting. | The first draw after the overlay is created or resized does not reach the screen unless another frame follows; the manager issues confirming repaints when paused. |
| **External textures for SDR, own shaders for planar/HDR** | Zero-copy where the browser's conversion is correct; full control where it matters. | Hardware-decoded HDR frames whose pixel format cannot be read back use the browser's conversion; software-decoded HDR goes through our tone mapping. |
| **Matroska scan reads the file sequentially** | No index for subtitle blocks. | For URL sources the file is fetched once in the background to scan it. |
| **Skin CSS scoping via native CSS nesting** | No build step for skin authors. | Requires browsers with CSS nesting (all current engines). |

## 9. Known limits

- Software AV1 decode in the FFmpeg tier (see above).
- MP4 `tx3g` / non-Matroska embedded text subtitles are not extracted (external files work).
- Pixel aspect ratio other than 1:1 is not applied by the canvas renderers.
- HDR is tone-mapped to SDR; there is no HDR canvas output path yet.
- FLV and AVI files whose video has B-frames do not start at position 0 on the FFmpeg routes:
  FFmpeg aims its seek a little before the target, these two demuxers fail a seek to before the
  start, and reading resumes at the second key frame. Opened or sought further in, they play.
- Without cross-origin isolation the FFmpeg tier is single-threaded and decodes in slices: fine
  for 1080p H.264, not fast enough for 1080p 10-bit HEVC.
