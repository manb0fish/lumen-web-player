import { expect, test, type Page } from '@playwright/test';
import { audioLevel, expectNoErrors, load, openApp, readFrame, seekPaused, state, stats, waitForStatus, waitForTime } from './helpers';

/**
 * Graceful degradation. Each test removes a capability and checks the player routes around it:
 * no SharedArrayBuffer, no WebGPU, no WebGL2, no WebCodecs, no MSE, a decoder dying mid-stream,
 * a GPU context being lost.
 */

async function notes(page: Page): Promise<string[]> {
  return (await stats(page)).notes;
}

test.describe('without SharedArrayBuffer (page not cross-origin isolated)', () => {
  test('FFmpeg WASM software decode runs in bounded segments and still plays to the end', async ({ page }) => {
    const errors = await openApp(page, { nosab: true, tier: 'wasm' });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
    expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('undefined');
    const r = await page.evaluate(async () => {
      const p = window.player;
      await p.load('/media/h264_aac.mp4', { autoplay: true });
      let last = 0;
      let lastChange = performance.now();
      let maxStall = 0;
      let started = false;
      const t0 = performance.now();
      while (performance.now() - t0 < 40000 && p.store.state.status !== 'ended' && p.store.state.status !== 'error') {
        await new Promise((res) => setTimeout(res, 50));
        const t = p.currentTime;
        if (t > last + 0.001) {
          if (started) maxStall = Math.max(maxStall, performance.now() - lastChange);
          started = true;
          lastChange = performance.now();
          last = t;
        }
      }
      return { status: p.store.state.status, time: p.currentTime, maxStall };
    });
    expect(r.status).toBe('ended');
    expect(r.time).toBeGreaterThan(7.4);
    expect(r.maxStall, 'longest stall across segment boundaries, ms').toBeLessThan(1200);
    const s = await state(page);
    expect(s.mode).toBe('wasm-sw');
    expect((await notes(page)).join('\n')).toContain('segmented, no SharedArrayBuffer');
    expectNoErrors(errors);
  });

  test('segment boundaries are seamless: the right frame is on screen throughout, and seeks are exact', async ({ page }) => {
    const errors = await openApp(page, { nosab: true, tier: 'wasm' });
    await load(page, 'h264_aac_long.mp4', { autoplay: true });
    await waitForTime(page, 0.8);
    for (let i = 0; i < 22; i++) {
      const r = await readFrame(page);
      expect(Math.abs(r.frame - r.time * 30), `frame ${r.frame} at ${r.time.toFixed(3)}s`).toBeLessThanOrEqual(2.5);
      await page.waitForTimeout(160);
    }
    expect(await audioLevel(page)).toBeGreaterThan(0.05);
    await seekPaused(page, 33.4);
    expect((await readFrame(page)).frame).toBe(1002);
    expectNoErrors(errors);
  });

  test('remux / transcode into MSE and the hybrid audio path also work', async ({ page }) => {
    const errors = await openApp(page, { nosab: true });
    for (const [file, mode] of [
      ['h264_aac.flv', 'wasm-remux-mse'],
      ['h264_mp3.avi', 'wasm-transcode-mse'],
      ['h264_ac3.mkv', 'webcodecs+wasm-audio'],
    ] as const) {
      await load(page, file, { autoplay: true });
      await waitForTime(page, 2.2);
      const s = await state(page);
      expect(s.mode).toBe(mode);
      expect(s.status).toBe('playing');
      const r = await readFrame(page);
      expect(Math.abs(r.frame - r.time * 30), `${file}: frame ${r.frame} at ${r.time.toFixed(3)}s`).toBeLessThanOrEqual(3);
      expect(await audioLevel(page), `${file} audio`).toBeGreaterThan(0.03);
    }
    expectNoErrors(errors);
  });
});

test('a WebCodecs decoder failing mid-stream falls back to the next tier and playback continues', async ({ page }) => {
  const errors = await openApp(page, { fault: 50 });
  await page.evaluate(() => {
    (window as any).__fallbacks = [];
    window.player.events.on('fallback', (e: any) => (window as any).__fallbacks.push(`${e.from.mode}->${e.to.mode}: ${e.reason}`));
  });
  await load(page, 'h264_aac_long.mp4', { autoplay: true });
  expect((await state(page)).tier).toBe('webcodecs');
  // ~50 frames in, the decoder "dies"
  await page.waitForFunction(() => window.player.store.state.tier === 'mse' && window.player.store.state.status === 'playing', null, {
    timeout: 30_000,
  });
  const fallbacks: string[] = await page.evaluate(() => (window as any).__fallbacks);
  expect(fallbacks).toEqual(['webcodecs->mse-remux: injected WebCodecs decoder fault']);
  const t = await page.evaluate(() => window.player.currentTime);
  expect(t, 'resumed where it failed, not from the start').toBeGreaterThan(1);
  await waitForTime(page, t + 1.5);
  const r = await readFrame(page);
  expect(Math.abs(r.frame - r.time * 30)).toBeLessThanOrEqual(2.5);
  expect((await state(page)).error).toBeNull();
  expect((await notes(page)).join('\n')).toContain('injected WebCodecs decoder fault');
  // The injected failure is logged as a note, never as a console error.
  expectNoErrors(errors);
});

test.describe('renderer degradation', () => {
  test('no WebGPU -> WebGL2', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
    });
    const errors = await openApp(page, { renderer: 'webgpu' });
    await load(page, 'h264_aac.mp4', { autoplay: true });
    await waitForTime(page, 1);
    expect((await state(page)).renderer).toBe('webgl2');
    expect((await notes(page)).join('\n')).toContain('renderer webgpu unavailable');
    const fs = await page.evaluate(() => window.player.debug.frameStats());
    expect(fs.stdev).toBeGreaterThan(20);
    expectNoErrors(errors);
  });

  test('no WebGPU and no WebGL2 -> Canvas 2D', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: any[]) {
        if (type === 'webgl2' || type === 'webgpu') return null;
        return (original as any).call(this, type, ...rest);
      } as any;
    });
    const errors = await openApp(page);
    for (const [file, params] of [
      ['h264_aac.mp4', {}],
      ['hevc10_aac.mkv', { tier: 'wasm' }], // software 10-bit planes converted on the CPU
    ] as const) {
      await page.evaluate((t) => window.player.store.set({ tierRequest: t ?? 'auto' }), (params as any).tier);
      await load(page, file, { autoplay: true });
      await waitForTime(page, 1);
      const s = await state(page);
      expect(s.renderer).toBe('canvas2d');
      const r = await readFrame(page);
      expect(r.contrast).toBeGreaterThan(80);
      expect(Math.abs(r.frame - r.time * 30), `${file} on canvas2d`).toBeLessThanOrEqual(2.5);
    }
    expect((await notes(page)).length).toBeGreaterThan(0);
    expectNoErrors(errors);
  });

  test('a lost WebGL context is replaced by the next renderer without stopping playback', async ({ page }) => {
    const errors = await openApp(page, { renderer: 'webgl2' });
    await load(page, 'h264_aac_long.mp4', { autoplay: true });
    await waitForTime(page, 0.8);
    expect((await state(page)).renderer).toBe('webgl2');
    await page.evaluate(() => {
      const gl: WebGL2RenderingContext = (window.player as any).renderer.gl;
      gl.getExtension('WEBGL_lose_context')!.loseContext();
    });
    await expect.poll(async () => (await state(page)).renderer).toBe('canvas2d');
    const t = await page.evaluate(() => window.player.currentTime);
    await waitForTime(page, t + 1);
    const r = await readFrame(page);
    expect(Math.abs(r.frame - r.time * 30)).toBeLessThanOrEqual(2.5);
    expect((await notes(page)).join('\n')).toContain('context lost');
    expect((await state(page)).status).toBe('playing');
    // Chromium logs its own "context lost" warning; our code must not add errors.
    expectNoErrors(errors.filter((e) => !/CONTEXT_LOST|context lost/i.test(e)));
  });
});

test.describe('decoder capability probing', () => {
  test('no WebCodecs -> automatic route is MSE', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as any).VideoDecoder;
      delete (window as any).AudioDecoder;
    });
    const errors = await openApp(page);
    expect(await page.evaluate(() => window.player.capabilities.webcodecs)).toBe(false);
    await load(page, 'h264_aac.mp4', { autoplay: true });
    await waitForTime(page, 1.2);
    const s = await state(page);
    expect(s.tier).toBe('mse');
    expect(s.mode).toBe('mse-remux');
    const r = await readFrame(page);
    expect(Math.abs(r.frame - r.time * 30)).toBeLessThanOrEqual(2.5);
    expectNoErrors(errors);
  });

  test('no WebCodecs and no MSE -> automatic route is FFmpeg WASM software decode', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as any).VideoDecoder;
      delete (window as any).AudioDecoder;
      delete (window as any).MediaSource;
      delete (window as any).ManagedMediaSource;
    });
    const errors = await openApp(page);
    const caps = await page.evaluate(() => window.player.capabilities);
    expect(caps.webcodecs).toBe(false);
    expect(caps.mse).toBe(false);
    await load(page, 'h264_aac.mp4', { autoplay: true });
    await waitForTime(page, 1.5);
    const s = await state(page);
    expect(s.tier).toBe('wasm');
    expect(s.mode).toBe('wasm-sw');
    const r = await readFrame(page);
    expect(Math.abs(r.frame - r.time * 30)).toBeLessThanOrEqual(2.5);
    expect(await audioLevel(page)).toBeGreaterThan(0.05);
    // AVI needs MSE for the remux route; without it the same file is software-decoded instead.
    await load(page, 'h264_mp3.avi', { autoplay: true });
    await waitForTime(page, 1.2);
    expect((await state(page)).mode).toBe('wasm-sw');
    expectNoErrors(errors);
  });

  test('WebCodecs present but codec unsupported -> per-track fallback (video stays hardware, audio goes to WASM)', async ({ page }) => {
    const errors = await openApp(page);
    await load(page, 'hevc_ac3.ts', { autoplay: true });
    await waitForStatus(page, 'playing');
    await waitForTime(page, 1.2);
    const s = await state(page);
    const st = await stats(page);
    // HEVC is decodable only where the platform has a decoder; AC-3 never is.
    if (s.mode === 'webcodecs+wasm-audio') {
      expect(s.routeReason).toContain('ac3 audio is not supported natively');
    } else {
      expect(s.mode).toBe('wasm-sw');
    }
    expect(st.audio).toContain('ac3');
    expect(await audioLevel(page)).toBeGreaterThan(0.05);
    expectNoErrors(errors);
  });
});
