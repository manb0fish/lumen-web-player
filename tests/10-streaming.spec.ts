import { expect, test, type Page } from '@playwright/test';
import { statSync } from 'node:fs';
import { expectNoErrors, openApp, readFrame, seekPaused, trackErrors, waitForStatus, waitForTime } from './helpers';

/**
 * The FFmpeg tier's input and decode performance.
 *
 * Network behaviour is measured against the dev server's /slow/<kbit>/<latency>/ route, which
 * honours range requests, delays every response, paces all bodies together to the given rate,
 * and counts what it serves. The file under test is a 20 s, 1080p, 8 Mbit/s clip of about 20 MB,
 * on a 20 Mbit/s link with 50 ms latency: the first version of the player needed 9 s before the
 * first frame there, because it downloaded the file in full before handing it to FFmpeg.
 */

const CLIP = 'perf_1080p_h264.mp4';
const CLIP_BYTES = statSync(`public/media/${CLIP}`).size;
const LINK = '/slow/20000/50/media';

interface Served {
  requests: number;
  bytes: number;
  ranges: string[];
}
const served = async (page: Page): Promise<Served> => (await page.request.get('/slow/stats')).json();
const notes = (page: Page): Promise<string[]> => page.evaluate(() => window.player.getStats().notes);
const loadUrl = (page: Page, url: string, opts: Record<string, unknown> = { autoplay: true }) =>
  page.evaluate(([u, o]) => window.player.load(u as string, o as object), [url, opts] as const);

/** Watch the clock for a while: achieved rate and the longest time it stood still. */
function watch(page: Page, seconds: number): Promise<{ rate: number; maxStallMs: number; status: string }> {
  return page.evaluate(async (seconds) => {
    const p = window.player;
    const c0 = p.currentTime;
    const w0 = performance.now();
    let last = c0;
    let lastChange = w0;
    let maxStall = 0;
    while (performance.now() - w0 < seconds * 1000) {
      await new Promise((r) => setTimeout(r, 25));
      const t = p.currentTime;
      if (t > last + 0.001) {
        maxStall = Math.max(maxStall, performance.now() - lastChange);
        last = t;
        lastChange = performance.now();
      }
    }
    maxStall = Math.max(maxStall, performance.now() - lastChange);
    return { rate: (p.currentTime - c0) / ((performance.now() - w0) / 1000), maxStallMs: maxStall, status: p.store.state.status };
  }, seconds);
}

test.describe('FFmpeg tier over a 20 Mbit/s link', () => {
  test('starts within seconds without downloading the file, then plays without stalling', async ({ page }) => {
    const errors = await openApp(page, { tier: 'wasm' });
    await page.request.get('/slow/reset');
    const t0 = Date.now();
    await loadUrl(page, `${LINK}/${CLIP}`);
    await waitForTime(page, 0.3, 30_000);
    const startMs = Date.now() - t0;
    const atStart = await served(page);
    expect(startMs, 'time to the first moving frame, ms').toBeLessThan(5000);
    expect(atStart.bytes, `bytes fetched before playback started (file: ${CLIP_BYTES})`).toBeLessThan(CLIP_BYTES * 0.6);

    const w = await watch(page, 6);
    expect(w.rate, 'playback rate over the slow link').toBeGreaterThan(0.97);
    expect(w.maxStallMs, 'longest stall, ms').toBeLessThan(300);

    const n = (await notes(page)).join('\n');
    expect(n).toContain('FFmpeg core ready (pthreads');
    expect(n).toContain('FFmpeg input: HTTP range requests, read ahead by a worker');
    // One long download, not a request per read.
    const after = await served(page);
    expect(after.requests, `requests: ${after.ranges.join(', ')}`).toBeLessThanOrEqual(8);
    test.info().annotations.push({
      type: 'network',
      description: `first frame after ${startMs} ms and ${(atStart.bytes / 1e6).toFixed(1)} of ${(CLIP_BYTES / 1e6).toFixed(1)} MB; ${after.requests} requests; longest stall ${w.maxStallMs.toFixed(0)} ms`,
    });
    expectNoErrors(errors);
  });

  test('without SharedArrayBuffer the download still runs in the background, between decode slices', async ({ page }) => {
    const errors = await openApp(page, { tier: 'wasm', nosab: true });
    await page.request.get('/slow/reset');
    const t0 = Date.now();
    await loadUrl(page, `${LINK}/${CLIP}`);
    await waitForTime(page, 0.3, 30_000);
    const startMs = Date.now() - t0;
    const atStart = await served(page);
    expect(startMs, 'time to the first moving frame, ms').toBeLessThan(6000);
    expect(atStart.bytes, `bytes fetched before playback started (file: ${CLIP_BYTES})`).toBeLessThan(CLIP_BYTES * 0.6);
    // Blocks from the worker only become visible between two slices, so each slice waits for its
    // data before it starts rather than stopping to fetch in the middle. Playback then has to be
    // as steady as with shared memory, right from the start.
    const w = await watch(page, 9);
    expect(w.rate, 'playback rate over the slow link').toBeGreaterThan(0.97);
    expect(w.maxStallMs, 'longest stall, ms').toBeLessThan(300);
    test.info().annotations.push({
      type: 'network',
      description: `first frame after ${startMs} ms and ${(atStart.bytes / 1e6).toFixed(1)} of ${(CLIP_BYTES / 1e6).toFixed(1)} MB; rate ${w.rate.toFixed(3)}, longest stall ${w.maxStallMs.toFixed(0)} ms`,
    });
    const n = (await notes(page)).join('\n');
    expect(n).toContain('segmented, no SharedArrayBuffer');
    expect(n).toContain('FFmpeg input: HTTP range requests, read ahead between segments');
    expect(n).toContain('not cross-origin isolated');
    expectNoErrors(errors);
  });

  test('a seek is one new range request at the right place, and lands on the exact frame', async ({ page }) => {
    const file = 'h264_aac_long.mp4';
    const size = statSync(`public/media/${file}`).size;
    const errors = await openApp(page, { tier: 'wasm' });
    await loadUrl(page, `/slow/8000/50/media/${file}`);
    await waitForTime(page, 0.5, 30_000);
    await page.request.get('/slow/reset');

    // Far ahead of anything read so far (the read-ahead window is 16 MiB, the file is smaller, so
    // make the jump while little has arrived).
    await seekPaused(page, 33.4);
    expect((await readFrame(page)).frame, 'frame on screen after seeking to 33.4 s').toBe(1002);
    await seekPaused(page, 12.5);
    expect((await readFrame(page)).frame, 'frame on screen after seeking back to 12.5 s').toBe(375);

    await page.evaluate(() => window.player.play());
    await waitForTime(page, 13.5, 30_000);
    const s = await served(page);
    expect(s.requests, `requests for two seeks: ${s.ranges.join(', ')}`).toBeLessThanOrEqual(8);
    // Nothing asked for the file from the beginning again.
    expect(s.bytes, 'bytes fetched for two seeks and a second of playback').toBeLessThan(size * 1.2);
    expectNoErrors(errors);
  });

  test('a server without range support is detected and the file is read from memory instead', async ({ page }) => {
    // Software decode is forced: left to itself the router would repackage this file for MSE.
    const errors = await openApp(page, { tier: 'wasm', wasm: 'sw' });
    await loadUrl(page, '/slow/60000/10/media/h264_aac_long.mp4?noranges');
    await waitForTime(page, 0.5, 30_000);
    expect((await notes(page)).join('\n')).toContain('FFmpeg input: downloaded in full (no HTTP range support)');
    await seekPaused(page, 33.4);
    expect((await readFrame(page)).frame).toBe(1002);
    expectNoErrors(errors);
  });
});

test('a file opened from disk (a Blob) is streamed through the same cache, byte-exact across seeks', async ({ page }) => {
  for (const params of [{ tier: 'wasm' }, { tier: 'wasm', nosab: true }]) {
    const errors = await openApp(page, params);
    await page.evaluate(async () => {
      const blob = await (await fetch('/media/h264_aac_long.mp4')).blob();
      await window.player.load(new File([blob], 'h264_aac_long.mp4'), { autoplay: true });
    });
    await waitForTime(page, 0.5);
    const n = (await notes(page)).join('\n');
    expect(n).toContain(params.nosab ? 'FFmpeg input: block reads, read ahead between segments' : 'FFmpeg input: read ahead by a worker');
    for (const [t, frame] of [
      [33.4, 1002],
      [2.5, 75],
      [57.0, 1710],
    ] as const) {
      await seekPaused(page, t);
      expect((await readFrame(page)).frame, `${params.nosab ? 'no SAB' : 'SAB'}: frame at ${t} s`).toBe(frame);
    }
    expectNoErrors(errors);
  }
});

test('an unreachable URL fails with an error instead of retrying for ever', async ({ page }) => {
  trackErrors(page);
  await openApp(page);
  const t0 = Date.now();
  // Nothing listens on this port: every request is refused.
  const message = await page.evaluate(() =>
    window.player.load('http://127.0.0.1:9/missing.mp4').then(
      () => null,
      (e: Error) => e.message || 'failed',
    ),
  );
  expect(message, 'load() must reject').not.toBeNull();
  expect(Date.now() - t0, 'time until the failure is reported, ms').toBeLessThan(40_000);
  await waitForStatus(page, 'error');
});

test('threads: the multi-threaded core decodes 1080p 10-bit HEVC well above real time, the single-threaded one barely', async ({
  page,
}) => {
  // Ask for 4x speed, far more than either core delivers, and count the frames that come out.
  const capacity = async (threads: 0 | 1) => {
    await openApp(page, { tier: 'wasm', wasm: 'sw', threads });
    await page.evaluate(() => window.player.load('/media/perf_1080p_hevc10.mkv', { autoplay: true }));
    await waitForTime(page, 0.3);
    return page.evaluate(async () => {
      const p = window.player;
      p.command('set speed 4');
      await new Promise((r) => setTimeout(r, 1200));
      const a = { ...p.getStats().pipeline };
      const w0 = performance.now();
      await new Promise((r) => setTimeout(r, 3500));
      const b = p.getStats().pipeline;
      return (b.presented - a.presented + b.dropped - a.dropped) / ((performance.now() - w0) / 1000);
    });
  };
  const single = await capacity(0);
  const multi = await capacity(1);
  test.info().annotations.push({
    type: 'decode',
    description: `frames per second out of the decoder: ${single.toFixed(0)} single-threaded, ${multi.toFixed(0)} multi-threaded`,
  });
  expect(multi, `multi-threaded ${multi.toFixed(1)} fps vs single-threaded ${single.toFixed(1)} fps`).toBeGreaterThan(single * 1.3);
  expect(multi, 'multi-threaded decode rate, frames per second (the clip is 30 fps)').toBeGreaterThan(45);

  // And at normal speed, with the default settings, it simply plays.
  const errors = await openApp(page, { tier: 'wasm' });
  await page.evaluate(() => window.player.load('/media/perf_1080p_hevc10.mkv', { autoplay: true }));
  await waitForTime(page, 0.5);
  const w = await watch(page, 6);
  expect(w.rate).toBeGreaterThan(0.97);
  expect(w.maxStallMs, 'longest stall at 1x, ms').toBeLessThan(200);
  expect((await notes(page)).join('\n')).toContain('FFmpeg core ready (pthreads');
  expectNoErrors(errors);
});

test('a decoder that cannot keep up with the requested speed stutters but never hangs', async ({ page }) => {
  // One thread, 1080p 10-bit HEVC, 4x speed: the decoder manages a third of what is asked. Audio
  // runs dry again and again, and each time the clock has to restart. It used to get stuck there
  // about every other run: the player waited for 0.3 s of audio while FFmpeg, blocked on a full
  // picture queue, could deliver 0.29 s.
  for (let round = 0; round < 3; round++) {
    const errors = await openApp(page, { tier: 'wasm', wasm: 'sw', threads: 0 });
    await page.evaluate(() => window.player.load('/media/perf_1080p_hevc10.mkv', { autoplay: true }));
    await waitForTime(page, 0.3);
    await page.evaluate(() => window.player.command('set speed 4'));
    const w = await watch(page, 5);
    expect(w.maxStallMs, `round ${round}: longest time without progress, ms`).toBeLessThan(1500);
    expect(w.rate, `round ${round}: achieved rate at a requested 4x`).toBeGreaterThan(0.7);
    expectNoErrors(errors);
  }
});

test('a host without the isolation headers gets them from the service worker after one reload', async ({ page }) => {
  const errors = trackErrors(page);
  // `noheaders` makes the dev server behave like plain static hosting.
  await page.goto('/?noheaders=1&persist=0&sidebar=0&tier=wasm');
  // The page registers the worker and reloads itself; wait for the isolated incarnation.
  await expect
    .poll(() => page.evaluate(() => globalThis.crossOriginIsolated === true && !!window.player && !!window.ui).catch(() => false), {
      timeout: 30_000,
    })
    .toBe(true);
  expect(await page.evaluate(() => window.player.capabilities.sab)).toBe(true);
  await page.evaluate(() => window.player.load('/media/hevc10_aac.mkv', { autoplay: true }));
  await waitForTime(page, 1);
  expect((await notes(page)).join('\n')).toContain('FFmpeg core ready (pthreads, SharedArrayBuffer flow control)');
  // Range requests and streaming still work through the worker.
  await seekPaused(page, 5);
  expect((await readFrame(page)).frame).toBe(150);

  // `nosab` still means what it says, even with the worker installed.
  await page.goto('/?noheaders=1&nosab=1&persist=0&sidebar=0');
  await page.waitForFunction(() => !!window.player && !!window.ui);
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(false);
  expectNoErrors(errors);
});
