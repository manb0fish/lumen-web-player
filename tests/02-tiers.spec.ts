import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, load, openApp, readFrame, seekPaused, state, stats, trackErrors, waitForTime } from './helpers';

/**
 * Forced decoder routing: WebCodecs -> MSE -> FFmpeg WASM.
 * Each tier must play a clip from the first frame to "ended" without ever stalling.
 */

interface Progress {
  ended: boolean;
  maxStallMs: number;
  finalTime: number;
  duration: number;
  samples: number;
  backwards: number;
}

/** Start playback and watch the clock until the stream ends; report the longest period without progress. */
async function playThrough(page: Page, file: string, timeoutMs = 45_000): Promise<Progress> {
  return page.evaluate(
    async ([file, timeoutMs]) => {
      const p = window.player;
      await p.load(`/media/${file}`, { autoplay: true });
      const duration = p.duration;
      let last = p.currentTime;
      let lastChange = performance.now();
      let maxStall = 0;
      let samples = 0;
      let backwards = 0;
      let started = false;
      const t0 = performance.now();
      while (performance.now() - t0 < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
        const s = p.store.state;
        if (s.status === 'ended' || s.status === 'error') break;
        const t = p.currentTime;
        samples++;
        if (t < last - 0.05) backwards++;
        if (t > last + 0.001) {
          if (started) maxStall = Math.max(maxStall, performance.now() - lastChange);
          started = true;
          lastChange = performance.now();
          last = t;
        }
      }
      return { ended: p.store.state.status === 'ended', maxStallMs: maxStall, finalTime: p.currentTime, duration, samples, backwards };
    },
    [file, timeoutMs] as const,
  );
}

const cases: Array<{ name: string; file: string; params: Record<string, string>; tier: string; mode: string; note?: string }> = [
  { name: 'Tier 1 WebCodecs', file: 'h264_aac.mp4', params: { tier: 'webcodecs' }, tier: 'webcodecs', mode: 'webcodecs' },
  { name: 'Tier 2 MSE (on-the-fly fMP4 remux)', file: 'h264_aac.mp4', params: { tier: 'mse' }, tier: 'mse', mode: 'mse-remux' },
  { name: 'Tier 2 MSE from Matroska', file: 'h264_opus.mkv', params: { tier: 'mse' }, tier: 'mse', mode: 'mse-remux' },
  { name: 'Tier 2 MSE from MPEG-TS', file: 'h264_aac.ts', params: { tier: 'mse' }, tier: 'mse', mode: 'mse-remux' },
  {
    name: 'Tier 3 FFmpeg WASM software decode (8-bit H.264)',
    file: 'h264_aac.mp4',
    params: { tier: 'wasm' },
    tier: 'wasm',
    mode: 'wasm-sw',
  },
  {
    name: 'Tier 3 FFmpeg WASM software decode (10-bit HEVC)',
    file: 'hevc10_aac.mkv',
    params: { tier: 'wasm' },
    tier: 'wasm',
    mode: 'wasm-sw',
  },
  {
    name: 'Tier 3 FFmpeg WASM pthread core is the default (multi-threaded software decode, 10-bit HEVC)',
    file: 'hevc10_aac.mkv',
    params: { tier: 'wasm' },
    tier: 'wasm',
    mode: 'wasm-sw',
    note: 'FFmpeg core ready (pthreads',
  },
  {
    name: 'Tier 3 FFmpeg WASM single-thread core on request',
    file: 'h264_opus.mkv',
    params: { tier: 'wasm', threads: '0' },
    tier: 'wasm',
    mode: 'wasm-sw',
    note: 'FFmpeg core ready (single-thread, SharedArrayBuffer flow control)',
  },
  {
    name: 'Tier 3 FFmpeg WASM software decode (VP9 in WebM)',
    file: 'vp9_opus.webm',
    params: { tier: 'wasm' },
    tier: 'wasm',
    mode: 'wasm-sw',
  },
  { name: 'Tier 2 MSE: VP9 10-bit from WebM', file: 'vp9_10bit_opus.webm', params: { tier: 'mse' }, tier: 'mse', mode: 'mse-remux' },
  { name: 'Tier 2 MSE: AV1 from Matroska', file: 'av1_opus.mkv', params: { tier: 'mse' }, tier: 'mse', mode: 'mse-remux' },
  {
    name: 'Tier 1 WebCodecs: AV1 10-bit',
    file: 'av1_10bit_opus.webm',
    params: { tier: 'webcodecs' },
    tier: 'webcodecs',
    mode: 'webcodecs',
  },
  { name: 'Tier 1 WebCodecs: HEVC 10-bit', file: 'hevc10_aac.mkv', params: { tier: 'webcodecs' }, tier: 'webcodecs', mode: 'webcodecs' },
  {
    name: 'Tier 3 FFmpeg WASM software decode (HEVC + AC-3 in MPEG-TS)',
    file: 'hevc_ac3.ts',
    params: { tier: 'wasm' },
    tier: 'wasm',
    mode: 'wasm-sw',
  },
  {
    name: 'Tier 3 FFmpeg WASM stream-copy remux -> MSE (MP4 source)',
    file: 'h264_aac.mp4',
    params: { tier: 'wasm', wasm: 'remux' },
    tier: 'wasm',
    mode: 'wasm-remux-mse',
  },
  { name: 'Tier 3 FFmpeg WASM remux of FLV -> MSE', file: 'h264_aac.flv', params: {}, tier: 'wasm', mode: 'wasm-remux-mse' },
  {
    name: 'Tier 3 FFmpeg WASM AVI: copy video, transcode MP3 -> AAC -> MSE',
    file: 'h264_mp3.avi',
    params: {},
    tier: 'wasm',
    mode: 'wasm-transcode-mse',
  },
  { name: 'Tier 3 FFmpeg WASM legacy MPEG-4 ASP in AVI', file: 'mpeg4_mp3.avi', params: {}, tier: 'wasm', mode: 'wasm-sw' },
  {
    name: 'Tier 1 + 3 hybrid: WebCodecs video with FFmpeg WASM AC-3 audio',
    file: 'h264_ac3.mkv',
    params: {},
    tier: 'webcodecs',
    mode: 'webcodecs+wasm-audio',
  },
  { name: 'Tier 1 + 3 hybrid: 5.1 AC-3 downmix', file: 'h264_ac3_51.mkv', params: {}, tier: 'webcodecs', mode: 'webcodecs+wasm-audio' },
  { name: 'Native <video> last resort', file: 'h264_aac.mp4', params: { tier: 'native' }, tier: 'native', mode: 'native' },
];

for (const c of cases) {
  test(`${c.name} plays ${c.file} to the end without stalling`, async ({ page }) => {
    const errors = await openApp(page, c.params);
    const r = await playThrough(page, c.file);
    const s = await state(page);
    expect(s.error).toBeNull();
    expect(s.tier).toBe(c.tier);
    expect(s.mode).toBe(c.mode);
    expect(r.ended, `reached the end (stopped at ${r.finalTime.toFixed(2)} / ${r.duration.toFixed(2)})`).toBe(true);
    expect(r.finalTime).toBeGreaterThan(r.duration - 0.6);
    expect(r.backwards, 'clock never jumps backwards').toBe(0);
    expect(r.maxStallMs, 'longest gap without clock progress').toBeLessThan(900);
    const st = await stats(page);
    // Frames must keep reaching the renderer for the whole clip.
    if (c.mode.includes('mse') || c.mode === 'native') {
      // <video>-element tiers: the browser's compositor decides which frames surface (through
      // requestVideoFrameCallback), so the absolute count depends on the machine. Headless Edge
      // composites at roughly 40 Hz and reports 15-25 % of a 30 fps clip as dropped. What must
      // hold everywhere is the accounting: every frame was either handed to our renderer or
      // reported dropped by the browser itself, so the pipeline lost none along the way.
      const frames = await page.evaluate(() => {
        const p = window.player;
        return Math.round(p.duration * (p.store.state.mediaInfo?.video?.fps ?? 30));
      });
      const { presented, dropped } = st.pipeline;
      expect(presented, `renderer saw ${presented} of ${frames} frames`).toBeGreaterThan(frames * 0.55);
      expect(presented + dropped, `presented ${presented} + browser-dropped ${dropped} of ${frames} frames`).toBeGreaterThan(frames * 0.95);
    } else {
      // Tiers with their own frame queue present every frame themselves (240; 200 in the AVI clips).
      expect(st.pipeline.presented).toBeGreaterThan(c.file.endsWith('.avi') ? 150 : 200);
    }
    if (c.note) expect(st.notes.join('\n')).toContain(c.note);
    test.info().annotations.push({ type: 'stall', description: `${r.maxStallMs.toFixed(0)} ms max` });
    expectNoErrors(errors);
  });
}

/**
 * Stream copy has to leave every picture at its own presentation time, also in a stream that
 * begins in the middle of the file, which is what a seek outside the buffer starts. The MP4 clip
 * has B-frames: there the fMP4 muxer used to place pictures later by the decode-to-presentation
 * delay (two frames). The FLV clip guards the start-time handling that shares the same flags.
 */
const remuxSeeks: Array<{
  name: string;
  file: string;
  params: Record<string, string>;
  /** Open the file at this position, so that even the first stream begins mid-file. */
  start?: number;
  /** Presentation time of the first picture on the player timeline. */
  origin: number;
  seeks: number[];
}> = [
  {
    name: 'MP4 with B-frames',
    file: 'h264_aac_long.mp4',
    params: { tier: 'wasm', wasm: 'remux' },
    origin: 0,
    // On frame boundaries and between them; 20.02 lies inside what the seek to 12.5 buffered,
    // the others each start a new stream at the key frame before them.
    seeks: [33.4, 12.5, 20.02, 2.0, 47.77],
  },
  {
    name: 'FLV',
    file: 'h264_aac.flv',
    params: {},
    start: 5.3732,
    // FLV stamps whole milliseconds, and this clip's audio leads its first picture by one AAC
    // frame (1024 samples at 44.1 kHz); the timeline starts with the audio.
    origin: 0.023,
    seeks: [5.3732, 2.04, 7.005, 0.3732],
  },
];

for (const c of remuxSeeks) {
  test(`Tier 3 FFmpeg WASM stream-copy remux -> MSE shows the exact frame after seeks (${c.name})`, async ({ page }) => {
    const errors = await openApp(page, c.params);
    await load(page, c.file, c.start ? { startTime: c.start } : {});
    expect((await state(page)).mode).toBe('wasm-remux-mse');
    const fps = 30;
    for (const [i, t] of c.seeks.entries()) {
      await seekPaused(page, t);
      const r = await readFrame(page);
      expect(r.contrast, `frame counter readable at ${t} s`).toBeGreaterThan(80);
      expect(r.frame, `picture on screen at ${t} s (reported PTS ${r.pts.toFixed(4)})`).toBe(Math.floor((t - c.origin) * fps + 1e-6));
      expect(Math.abs(r.pts - (c.origin + r.frame / fps)), `reported PTS matches the picture at ${t} s`).toBeLessThan(0.002);
      if (i === 0) {
        // The stream this picture came from began at the key frame before the target, not at 0.
        const from = await page.evaluate(() => {
          const b = document.querySelector<HTMLVideoElement>('video.lp-native-video')!.buffered;
          return b.length ? b.start(0) : -1;
        });
        expect(from, 'start of the buffered stream').toBeGreaterThan(t - 3);
        expect(from).toBeLessThanOrEqual(t);
      }
    }
    expect((await state(page)).error).toBeNull();
    expectNoErrors(errors);
  });
}

test('a forced tier that cannot handle the file fails loudly instead of silently rerouting', async ({ page }) => {
  trackErrors(page);
  await openApp(page, { tier: 'mse' });
  // MP3-in-MP4 is not an MSE-supported combination in Chromium.
  const message = await page.evaluate(() =>
    window.player.load('/media/h264_mp3.mp4').then(
      () => null,
      (e: Error) => e.message,
    ),
  );
  expect(message).toContain('"mse" tier cannot play');
  expect((await state(page)).status).toBe('error');
});

test('a codec the FFmpeg core cannot software-decode is reported, not left hanging', async ({ page }) => {
  // The prebuilt core carries no libdav1d, so software AV1 is the one hole in tier 3.
  trackErrors(page);
  await openApp(page, { tier: 'wasm' });
  const message = await page.evaluate(() =>
    window.player.load('/media/av1_opus.mkv').then(
      () => null,
      (e: Error) => e.message,
    ),
  );
  expect(message).toContain('no software decoder for av1');
  expect((await state(page)).status).toBe('error');
});

test('switching tiers at runtime keeps the playback position', async ({ page }) => {
  const errors = await openApp(page);
  await load(page, 'h264_aac_long.mp4', { autoplay: true });
  await waitForTime(page, 2);
  for (const tier of ['mse', 'wasm', 'webcodecs'] as const) {
    const before = await page.evaluate(() => window.player.currentTime);
    await page.evaluate((t) => window.player.setTier(t), tier);
    await waitForTime(page, before + 0.8);
    const s = await state(page);
    expect(s.tier).toBe(tier);
    expect(s.status).toBe('playing');
    const r = await readFrame(page);
    expect(r.time).toBeGreaterThan(before);
    expect(r.time - before, 'resumed near where it left off').toBeLessThan(4);
    expect(Math.abs(r.frame - r.time * 30), `frame ${r.frame} at ${r.time.toFixed(3)}s on ${tier}`).toBeLessThanOrEqual(2.5);
  }
  expectNoErrors(errors);
});
