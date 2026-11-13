# Lumen Player — User and developer guide

Reference material that does not fit in the [README](../README.md): every URL option and keyboard
shortcut, how to embed the player in your own page, how to write a skin, and how the test suite is
organised. For how the player works inside, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Contents

- [URL parameters](#url-parameters)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Mouse and touch](#mouse-and-touch)
- [Phones and tablets](#phones-and-tablets)
- [Playing over a network](#playing-over-a-network)
- [Cross-origin isolation](#cross-origin-isolation)
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
| `threads` | `0` `1` | Force the single-threaded (`0`) or multi-threaded (`1`) FFmpeg build. Default: multi-threaded wherever it can run. |
| `renderer` | `auto` `webgpu` `webgl2` `canvas2d` | Starting renderer. |
| `skin` | `glass` `mpv` `studio` | Starting skin. |
| `nosab` | — | Run the page without cross-origin isolation (no `SharedArrayBuffer`), to exercise the fallback paths. |
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

## Mouse and touch

| Input | Action |
| --- | --- |
| Click on the picture | Play / pause |
| Double-click on the picture | Fullscreen (the `MBTN_LEFT_DBL` binding) |
| Mouse wheel | Volume |
| Tap on the picture | Show or hide the controls |
| Double tap, left or right third | Seek 10 seconds back / forward |
| Double tap, middle | Play / pause |

A click waits a quarter of a second before pausing, to see whether it is the first half of a
double-click; that is what keeps a double-click from pausing and resuming the video on its way to
fullscreen. Skins whose controls never hide (Studio Deck) have nothing to show or hide, so there a
single tap is play / pause.

## Phones and tablets

The player lays itself out by measuring, not by screen size: if a skin's controls do not fit in
the space the player has, it switches to a **compact** layout. Less important controls disappear
from the bar and reappear in a **More** (⋮) menu, menus open as a sheet along the bottom edge, and
a seek bar that shared its row with buttons gets a line of its own. This works the same for the
built-in skins and for skin packages you load, and it follows the player's own size, so an
embedded player in a narrow column behaves like one on a phone.

With touch input the buttons grow to finger size, the seek bar gets a taller touch area, and the
big centre button doubles as a pause button while the controls are visible. In fullscreen on a
phone the screen is turned to landscape where the browser allows it.

The demo page moves its sample list into a drawer on small screens; the tab on the left edge
opens it.

## Playing over a network

Files can be opened from a URL (`?src=…`, or `player.load(url)`) or from disk, including from a
network share. Nothing is downloaded in full before playback starts:

- The WebCodecs and MSE routes read through Mediabunny, which fetches byte ranges as needed.
- The FFmpeg route reads through a block cache that a background worker fills, staying about
  16 MB ahead of the decoder (one long HTTP range request, restarted on a seek). The stats overlay
  shows how the input is being read, for example `FFmpeg input: HTTP range requests, read ahead
  by a worker`.

For this to work well the server should support **range requests** and send media **uncompressed**
with a real `Content-Type`. A server without range support still works, but the FFmpeg route then
has to download the whole file first. If the media is on another origin, that server must allow
cross-origin requests (CORS), and to read the file size it should expose `Content-Range`
(`Access-Control-Expose-Headers: Content-Range`).

A URL that cannot be reached is retried for about twelve seconds and then reported as an error.

## Cross-origin isolation

The FFmpeg route is much faster on a **cross-origin isolated** page, because only there does the
browser provide `SharedArrayBuffer`: that is what allows multi-threaded decoding (three times the
speed on our 1080p 10-bit HEVC test clip), pacing a running decode instead of restarting it in
slices, and a shared read-ahead cache. The stats overlay shows `sab ✓` when the page is isolated.

A page is isolated when its server sends these two headers with it:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`npm run dev` and `npm run preview` already do. Where you cannot set headers (plain static
hosting), the demo page turns isolation on by itself: it registers a small service worker
(`public/lumen-isolation-sw.js`) that adds the headers, and reloads once on the first visit. In
your own page, copy that file next to your page and call it early:

```ts
import { ensureCrossOriginIsolation } from './src';

await ensureCrossOriginIsolation('lumen-isolation-sw.js');
```

Without isolation everything still plays through the browser's own decoders; only the FFmpeg
route is affected. It then runs on one thread, which is enough for 1080p H.264 but not for 1080p
10-bit HEVC.

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
- **Small screens** — give a layout item `"hideNarrow": true` to drop it in the compact layout, and
  add the `more` control so it stays reachable through the overflow menu (`more` only shows in the
  compact layout unless you pass `"always": true`). A `time` control can carry a shorter
  `"compactFormat"`. Skin CSS can key off `.lp-root[data-size='compact']`, `[data-short]` (a low
  player, such as a phone held sideways) and `[data-touch]`.

Load a skin by dropping the `.json` file on the player, from the inspector (skins menu →
**Skin inspector…**, which also edits tokens live and exports the result), or in code with
`ui.loadSkin('/skins/neon.json')` / `ui.loadSkin(object)`.

Built-in skins live in `src/ui/skins/`; `public/skins/neon.json` is a complete external example.
Controls available to layouts: `play`, `big-play`, `stop`, `prev-frame`, `next-frame`, `rewind`,
`forward`, `seekbar`, `time`, `mute`, `volume`, `speed`, `subtitles`, `audio`, `video`, `tier`,
`skins`, `more`, `stats`, `fullscreen`, `open`, `screenshot`, `loop`, `abloop`, `title`, `tier-badge`,
`status-line`, `lcd`, `vu`, `deband`, `normalize`, `sub-toggle`, `button`, `text`, `spacer`,
`separator`, `group`. Add your own with `registerControl(name, factory)`.

Skin packages are treated as untrusted input: icons are reduced to plain SVG shapes, and
`@import` and remote `url()` references are removed from CSS.

## Project scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the development server at <http://127.0.0.1:5173>. |
| `npm run media` | Create the sample/test media with ffmpeg (`--force` to regenerate), including two 1080p clips for benchmarks. |
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
| `02-tiers` | Forced WebCodecs / MSE / FFmpeg-WASM (software decode, stream-copy remux, audio transcode, hybrid audio, multi- and single-threaded core) and native playback each play a clip to the end with no stall; impossible forced routes fail loudly; switching method keeps the position. |
| `03-renderers` | Switching WebGPU → WebGL2 → Canvas 2D at runtime draws real frames (checked on browser screenshots); colour accuracy against known RGB patches for every ingest path; HDR tone mapping; scalers, deband, sharpening. |
| `04-sync` | Audio/video sync measured three ways (clock vs. timestamps, pixels vs. clock, beep heard vs. flash seen), 60 fps cadence, pitch-preserving speed changes, 5.1 downmix, gain, A-B loop. |
| `05-subtitles` | Embedded tracks and fonts are found; ASS events appear on exactly the right frame on all three decoding methods; embedded and user fonts are really used; heavy typesetting keeps up with the display; SRT / WebVTT / PGS; delay and visibility. |
| `06-ui` | Skin switching during playback with zero console errors; custom and URL-loaded skin packages (layout, tokens, command buttons, sanitising); inspector; key bindings; stats overlay; mouse interaction; plugin API, screenshots, thumbnails, `<lumen-player>`. |
| `07-stress` | 45 rapid random seeks with speed and pause changes per method, then landing on an exact frame; long frame-stepping runs; speed sweep; 18 create/load/seek/destroy cycles with nothing leaked. |
| `08-fallbacks` | No `SharedArrayBuffer`, a decoder failing mid-stream, no WebGPU, no WebGL2, a lost GPU context, no WebCodecs, no MSE. |
| `09-mobile` | A double-click runs its binding without ever pausing; a single click still pauses. On four phone and tablet screen sizes, every skin (including a loaded package) keeps all its controls on screen and finger-sized. Tap, double-tap seek and double-tap pause; the overflow menu as a bottom sheet with submenus; the demo page's drawer. |
| `10-streaming` | On a simulated 20 Mbit/s link: the FFmpeg route starts within seconds having fetched a fraction of the file, plays without stalling, and seeks with a handful of requests, with and without `SharedArrayBuffer`. Files opened from disk go through the same cache, byte-exact. A server without range support, an unreachable URL, multi- versus single-threaded decode speed, a decoder that cannot keep up (it must stutter, never hang), and isolation through the service worker. |
| `unit/` | The real AudioWorklet module run in Node (bit-exact passthrough, pitch within ±0.5 Hz, downmix coefficients, sample-exact seeking, clock behaviour), plus the command bus, key bindings, subtitle parsers, Matroska scanner, PGS round trip, colour math, routing, the skin sanitiser and the input block cache. |

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
public/lumen-isolation-sw.js   service worker that makes a statically hosted page cross-origin isolated
```

`index.html` is the demo application; `harness.html` is a bare page without UI that the leak and
teardown tests drive. The dev and preview servers also serve `/slow/<kbit-per-second>/<latency-ms>/…`,
a deliberately throttled copy of `public/` that the network tests measure against.

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
