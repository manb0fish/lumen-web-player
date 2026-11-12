# Lumen Player — User and developer guide

Reference material that does not fit in the [README](../README.md): every URL option and keyboard
shortcut, how to embed the player in your own page, how to write a skin, and how the test suite is
organised. For how the player works inside, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Contents

- [URL parameters](#url-parameters)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Using Lumen in your own page](#using-lumen-in-your-own-page)
- [Skins](#skins)
- [Project scripts](#project-scripts)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Good to know](#good-to-know)

## URL parameters

Add these to the address of the demo page, for example
`http://127.0.0.1:5173/?src=/media/h264_aac.mp4&skin=mpv`.

| Parameter | Values | Effect |
| --- | --- | --- |
| `src` | URL | Load this file on start. `autoplay=0` keeps it paused, `t=<seconds>` sets the start position, `sub=<url>` adds an external subtitle. |
| `tier` | `auto` `webcodecs` `mse` `wasm` `native` | Force a decoding method. Strict: if the forced method cannot play the file you get an error instead of a silent switch. |
| `wasm` | `auto` `sw` `remux` | Force an FFmpeg strategy (software decode, or repackage into MSE). |
| `threads` | `1` | Use the multi-threaded FFmpeg build. |
| `renderer` | `auto` `webgpu` `webgl2` `canvas2d` | Starting renderer. |
| `skin` | `glass` `mpv` `studio` | Starting skin. |
| `nosab` | — | Serve the page without cross-origin isolation (no `SharedArrayBuffer`), to exercise the fallback paths. |
| `sidebar=0` | — | Hide the sample list. |
| `persist=0` | — | Do not read or write `localStorage`. |

## Keyboard shortcuts

The bindings use mpv's `input.conf` syntax and can be edited live: skins menu → **Key bindings…**.

| Key | Action |
| --- | --- |
| `Space`, `p`, `k` | Play / pause |
| `←` `→` | Seek 5 seconds back / forward |
| `↑` `↓` | Seek 60 seconds forward / back |
| `Shift+←` `Shift+→` | Seek exactly 1 second |
| `Home` `End` | Jump to the start / end |
| `,` `.` | Step one frame back / forward |
| `[` `]` | Speed ÷1.1 / ×1.1 |
| `{` `}` | Speed ÷2 / ×2 |
| `Backspace` | Speed back to 1× |
| `9` `0` (also `/` `*`) | Volume down / up |
| `m` | Mute |
| `n` | Volume normalisation on / off |
| `Ctrl+p` | Keep the pitch when the speed changes, on / off |
| `z` `x` | Subtitle delay −100 ms / +100 ms |
| `v` | Show / hide subtitles |
| `j` `J` | Next / previous subtitle track |
| `#` | Next audio track |
| `l` | A-B loop: set A, set B, clear |
| `L` | Loop the whole file |
| `u` | Cycle scaler: bilinear → bicubic → Lanczos → FSR |
| `b` | Deband on / off |
| `Ctrl+s` | Sharpen strength |
| `Ctrl+d` | Dithering on / off |
| `t` | HDR tone-mapping curve |
| `g` | Scale in linear light |
| `r` | Cycle renderer: WebGPU → WebGL2 → Canvas 2D |
| `Ctrl+r` | Cycle decoding method |
| `K` | Next skin |
| `i` | Stats for nerds |
| `s` | Save a screenshot |
| `f`, `Enter` | Fullscreen |
| `Esc` | Leave fullscreen |

Every shortcut runs a command, and you can type the same commands yourself, e.g.
`player.command('seek 30 absolute')` in the browser console.

## Using Lumen in your own page

The core has no user interface of its own; the bundled UI is an optional layer on top.

```ts
import { Player, mountUI } from './src';

const player = new Player({ container }); // headless core
const ui = mountUI(player, container, { skin: 'glass' }); // optional UI
await player.load(fileOrUrl, { autoplay: true });

// mpv-style commands and properties
player.command('seek 30 absolute');
player.command('cycle-values scale bilinear bicubic lanczos fsr');

// reactive state
player.store.watch(['status', 'tier'], (s) => console.log(s.status, s.tier));

// events
player.events.on('fallback', ({ from, to, reason }) => console.warn(from.mode, '→', to.mode, reason));

// plugins
player.use({
  name: 'my-plugin',
  install(p) {
    return p.commands.register('hello', ([who]) => p.osd(`hello ${who}`));
  },
});
```

Or declaratively, as a custom element:

```html
<lumen-player src="movie.mkv" skin="studio" autoplay></lumen-player>
```

The page must be served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` to unlock `SharedArrayBuffer` (used for FFmpeg flow
control and threads). Without those headers everything still works through a slower fallback.

## Skins

A skin is a JSON package: design tokens, a layout, icons and optional CSS.

```json
{
  "id": "mine",
  "name": "Mine",
  "tokens": { "--lp-accent": "#39ff14", "--lp-radius": "2px" },
  "layout": {
    "bottom": [
      [
        "play",
        "seekbar",
        { "control": "time", "format": "{current} · {remaining}" },
        { "control": "button", "command": "cycle-values speed 1 1.5 2", "label": "TURBO" },
        "subtitles",
        "video",
        "skins",
        "fullscreen"
      ]
    ]
  },
  "css": ".lp-btn { border: 1px solid var(--lp-border); }",
  "osd": { "position": "center" },
  "autohide": 1800
}
```

- **`tokens`** — CSS custom properties (`--lp-accent`, `--lp-bg`, `--lp-radius`, …). The full list
  is at the top of `src/ui/base.css`.
- **`layout`** — regions (`top`, `center`, `bottom`) made of rows. Each item is a control name or
  an object with options. `{ "control": "button", "command": "…" }` creates a button bound to any
  player command.
- **`icons`** — replace built-in icons with your own 24×24 SVG shapes.
- **`css`** / **`stylesheet`** — extra rules; they are scoped to your skin automatically.
- **`osd`**, **`autohide`**, **`dock`** — where on-screen messages appear, how fast the controls
  hide, and whether the control bar sits under the picture instead of over it.

Load a skin by dropping the `.json` file on the player, from the inspector (skins menu →
**Skin inspector…**, which also edits tokens live and exports the result), or in code with
`ui.loadSkin('/skins/neon.json')` / `ui.loadSkin(object)`.

Built-in skins live in `src/ui/skins/`; `public/skins/neon.json` is a complete external example.
Controls available to layouts: `play`, `big-play`, `stop`, `prev-frame`, `next-frame`, `rewind`,
`forward`, `seekbar`, `time`, `mute`, `volume`, `speed`, `subtitles`, `audio`, `video`, `tier`,
`skins`, `stats`, `fullscreen`, `open`, `screenshot`, `loop`, `abloop`, `title`, `tier-badge`,
`status-line`, `lcd`, `vu`, `deband`, `normalize`, `sub-toggle`, `button`, `text`, `spacer`,
`separator`, `group`. Add your own with `registerControl(name, factory)`.

Skin packages are treated as untrusted input: icons are reduced to plain SVG shapes, and
`@import` and remote `url()` references are removed from CSS.

## Project scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the development server at <http://127.0.0.1:5173>. |
| `npm run media` | Create the sample/test media with ffmpeg (`--force` to regenerate). |
| `npm run build` | Build the production bundle into `dist/`. |
| `npm run preview` | Serve the production bundle at <http://127.0.0.1:4173>. |
| `npm run lint` | Type-check (strict, including unused code) and check formatting. |
| `npm run format` | Format the code with Prettier. |
| `npm test` | Run the whole test suite against the development server. |
| `npm run test:preview` | Run the whole test suite against the production build. |
| `npm run test:unit` | Run only the tests that do not need a browser. |
| `npm run test:headed` | Run the tests in a visible browser window. |
| `npm run probe -- <file> [tier] [renderer]` | Print routing and sync statistics for one clip (needs `npm run dev` running). |

## Tests

The end-to-end tests need the generated media (`npm run media`) and an installed Chromium-based
browser with H.264/AAC support — Microsoft Edge by default; set `LUMEN_BROWSER_CHANNEL=chrome` to
use Google Chrome. The test runner starts the development server itself.

| Spec | What it proves |
| --- | --- |
| `01-matrix` | Every container × codec clip plays on automatic routing: time advances, the picture is not black, the frame number burned into the pixels matches the audio clock, audio is audible, and every `VideoFrame` and GPU texture is released afterwards. |
| `02-tiers` | Forced WebCodecs / MSE / FFmpeg-WASM (software decode, stream-copy remux, audio transcode, hybrid audio, multi-threaded core) and native playback each play a clip to the end with no stall; impossible forced routes fail loudly; switching method keeps the position. |
| `03-renderers` | Switching WebGPU → WebGL2 → Canvas 2D at runtime draws real frames (checked on browser screenshots); colour accuracy against known RGB patches for every ingest path; HDR tone mapping; scalers, deband, sharpening. |
| `04-sync` | Audio/video sync measured three ways (clock vs. timestamps, pixels vs. clock, beep heard vs. flash seen), 60 fps cadence, pitch-preserving speed changes, 5.1 downmix, gain, A-B loop. |
| `05-subtitles` | Embedded tracks and fonts are found; ASS events appear on exactly the right frame on all three decoding methods; embedded and user fonts are really used; heavy typesetting keeps up with the display; SRT / WebVTT / PGS; delay and visibility. |
| `06-ui` | Skin switching during playback with zero console errors; custom and URL-loaded skin packages (layout, tokens, command buttons, sanitising); inspector; key bindings; stats overlay; mouse interaction; plugin API, screenshots, thumbnails, `<lumen-player>`. |
| `07-stress` | 45 rapid random seeks with speed and pause changes per method, then landing on an exact frame; long frame-stepping runs; speed sweep; 18 create/load/seek/destroy cycles with nothing leaked. |
| `08-fallbacks` | No `SharedArrayBuffer`, a decoder failing mid-stream, no WebGPU, no WebGL2, a lost GPU context, no WebCodecs, no MSE. |
| `unit/` | The real AudioWorklet module run in Node (bit-exact passthrough, pitch within ±0.5 Hz, downmix coefficients, sample-exact seeking, clock behaviour), plus the command bus, key bindings, subtitle parsers, Matroska scanner, PGS round trip, colour math, routing and the skin sanitiser. |

Recorded results are in [VERIFICATION.md](VERIFICATION.md).

## Project layout

```
src/core        headless player, state store, command bus, key bindings
src/pipeline    routing, WebCodecs/MSE worker, FFmpeg worker, A/V sync engine
src/audio       AudioWorklet (clock, time-stretch, downmix, normalizer) and audio graph
src/render      WebGPU / WebGL2 / Canvas 2D renderers and their shader chains
src/subs        libass integration, Matroska scanner, SRT/VTT conversion, PGS decoder
src/ui          skin engine, controls, overlays, built-in skins
scripts         sample-media synthesis (ffmpeg), ASS and PGS generators, helpers
tests           Playwright end-to-end specs and Node unit tests
docs            guide, architecture, verification results, translations
public/skins    an example external skin package
```

`index.html` is the demo application; `harness.html` is a bare page without UI that the leak and
teardown tests drive.

## Good to know

- The FFmpeg WebAssembly build (about 32 MB) is downloaded only when a file actually needs it.
- Software AV1 decoding is not available in the prebuilt FFmpeg build; AV1 plays through the
  browser's own decoder instead. The reasoning is in the trade-off table of
  [ARCHITECTURE.md](ARCHITECTURE.md).
- Embedded text subtitles are read from Matroska (`.mkv`, `.webm`) files only; for other
  containers, load the subtitle file separately.
- HDR video is tone-mapped to standard dynamic range.
- If you host media on your own server, make sure it sends video and audio files as they are:
  with a real `Content-Type`, support for range requests, and no gzip/brotli compression. A
  server that compresses a file but answers range requests for it uncompressed can leave the
  browser with a damaged copy, and playback then stops early. The bundled dev and preview
  servers are already set up this way (see `vite.config.ts`).
