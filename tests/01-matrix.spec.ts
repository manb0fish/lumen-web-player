import { expect, test, type Page } from '@playwright/test';
import {
  audioLevel,
  destroyPlayer,
  expectNoErrors,
  load,
  manifest,
  openApp,
  readFrame,
  stats,
  waitForTime,
  type MediaFile,
} from './helpers';

/**
 * The whole container x codec matrix, on automatic routing.
 *
 * For every synthesised file we assert that it actually plays: time advances, the picture is not
 * black, the frame counter burned into the video agrees with the audio clock (so the *right* frames
 * are on screen, not merely some frames), audio is audible on the output bus, and the router picked
 * a route that makes sense for what the browser can and cannot decode.
 */

const videos = manifest.files.filter((f) => f.video && !f.long && !f.colors && !f.perf);
const audios = manifest.files.filter((f) => !f.video);

function expectedRoute(f: MediaFile, mode: string, tier: string): void {
  if (f.container === 'avi' || f.container === 'flv') {
    // No JS demuxer for these containers: FFmpeg-WASM has to be involved.
    expect(tier, `${f.file} must use the FFmpeg tier`).toBe('wasm');
    if (f.video === 'mpeg4') expect(mode).toBe('wasm-sw');
    else expect(['wasm-remux-mse', 'wasm-transcode-mse', 'wasm-sw']).toContain(mode);
    return;
  }
  if (f.audio === 'ac3') {
    // No browser decodes AC-3: audio has to come from FFmpeg-WASM, video may stay on WebCodecs.
    expect(['webcodecs+wasm-audio', 'wasm-sw', 'wasm-transcode-mse']).toContain(mode);
    return;
  }
  expect(['webcodecs', 'mse', 'wasm']).toContain(tier);
}

test.describe.configure({ mode: 'serial' });

test.describe('media matrix (auto routing)', () => {
  let page: Page;
  let errors: string[];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    errors = await openApp(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  for (const f of videos) {
    test(`${f.file}  [${f.container} / ${f.video}${f.bitDepth === 10 ? ' 10-bit' : ''} / ${f.audio}]`, async () => {
      errors.length = 0;
      // The server must send media as-is. A server that gzips a clip while answering range
      // requests for it uncompressed lets the browser cache mix the two into a damaged download.
      const served = await page.request.get(`/media/${f.file}`, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
      expect(served.headers()['content-type'] ?? '', `${f.file} has a content type`).not.toBe('');
      expect(served.headers()['content-encoding'], `${f.file} is served uncompressed`).toBeUndefined();

      await load(page, f.file, { autoplay: true });
      await waitForTime(page, 1.4);

      const st = await stats(page);
      const s = await page.evaluate(() => window.player.store.state);
      expect(s.status).toBe('playing');
      expect(s.error).toBeNull();
      expectedRoute(f, s.mode, s.tier);

      // Not black, and not a flat colour.
      const fs = await page.evaluate(() => window.player.debug.frameStats());
      expect(fs.mean, 'mean luma').toBeGreaterThan(25);
      expect(fs.stdev, 'luma spread').toBeGreaterThan(20);

      // The frame on screen is the frame the clock says should be on screen (±2 frames).
      const fps = f.fps ?? 30;
      const r = await readFrame(page);
      expect(r.contrast, 'frame-counter strip readable').toBeGreaterThan(80);
      expect(Math.abs(r.frame - r.time * fps), `frame ${r.frame} at clock ${r.time.toFixed(3)}s`).toBeLessThanOrEqual(2.5);

      expect(st.pipeline.presented).toBeGreaterThan(15);
      expect(await audioLevel(page), 'audio level on the output bus').toBeGreaterThan(0.02);

      // Still advancing after the checks, i.e. no stall.
      const t0 = await page.evaluate(() => window.player.currentTime);
      await waitForTime(page, t0 + 0.5);
      test.info().annotations.push({ type: 'route', description: `${s.mode} / ${s.renderer}` });
      expectNoErrors(errors);
    });
  }

  for (const f of audios) {
    test(`${f.file}  [audio only / ${f.audio}]`, async () => {
      errors.length = 0;
      await load(page, f.file, { autoplay: true });
      await waitForTime(page, 1.2);
      const s = await page.evaluate(() => window.player.store.state);
      expect(s.status).toBe('playing');
      expect(s.mediaInfo.video).toBeNull();
      expect(await audioLevel(page)).toBeGreaterThan(0.02);
      // The visualizer takes over the stage when there is no picture.
      await expect(page.locator('.lp-root')).toHaveAttribute('data-has-video', 'false');
      expectNoErrors(errors);
    });
  }

  test('every VideoFrame and GPU texture is released after the matrix', async () => {
    const res = await destroyPlayer(page);
    expect(res.frames.opened).toBeGreaterThan(200);
    expect(res.frames.opened - res.frames.closed, 'VideoFrames still open').toBe(0);
    expect(res.textures.created - res.textures.destroyed, 'GPU textures still alive').toBe(0);
    expect(res.audioState).toBe('none');
  });
});
