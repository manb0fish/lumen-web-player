import { expect, test } from '@playwright/test';
import {
  destroyPlayer,
  expectColorNear,
  expectNoErrors,
  load,
  manifest,
  openApp,
  PATCH_RECTS,
  readFrame,
  screenshotColor,
  seekPaused,
  settle,
  state,
  stats,
  waitForTime,
} from './helpers';

/**
 * Forced renderer switching WebGPU -> WebGL2 -> Canvas2D, colour correctness of every ingest path
 * (browser-converted external frames and our own planar YUV shaders, 8 and 10 bit), the HDR path,
 * and the post-processing passes.
 */

const RENDERERS = ['webgpu', 'webgl2', 'canvas2d'] as const;
const patches = manifest.colorPatches;
const rects = Object.values(PATCH_RECTS);
const names = Object.keys(PATCH_RECTS) as Array<keyof typeof PATCH_RECTS>;

async function setRenderer(page: import('@playwright/test').Page, r: string): Promise<void> {
  await page.evaluate((x) => window.player.setRenderer(x), r);
  await page.waitForTimeout(150);
}

async function samplePatches(page: import('@playwright/test').Page): Promise<number[][]> {
  return page.evaluate((r) => window.player.debug.samplePixels(r), rects);
}

test('runtime switch WebGPU -> WebGL2 -> Canvas2D renders real, non-black frames in each', async ({ page }) => {
  const errors = await openApp(page);
  await load(page, 'h264_aac.mp4', { autoplay: true });
  await waitForTime(page, 0.8);
  for (const r of [...RENDERERS, 'webgl2', 'webgpu'] as const) {
    await setRenderer(page, r);
    const s = await state(page);
    expect(s.renderer, `requested ${r}`).toBe(r); // no silent downgrade
    const before = (await stats(page)).render.framesRendered;
    await page.waitForTimeout(700);
    const st = await stats(page);
    expect(st.render.framesRendered - before, `${r} keeps drawing while playing`).toBeGreaterThan(8);
    const fs = await page.evaluate(() => window.player.debug.frameStats());
    expect(fs.mean, `${r} mean luma`).toBeGreaterThan(25);
    expect(fs.stdev, `${r} luma spread`).toBeGreaterThan(20);
    const f = await readFrame(page);
    expect(f.contrast).toBeGreaterThan(80);
    expect(Math.abs(f.frame - f.time * 30), `${r}: frame ${f.frame} at ${f.time.toFixed(3)}s`).toBeLessThanOrEqual(2.5);
    // And the compositor really shows it: check the browser's own screenshot of the canvas.
    const [shot] = await screenshotColor(page, '.lp-video-canvas', [[0.3, 0.4, 0.4, 0.3]]);
    expect(Math.max(...shot), `${r} screenshot is not black`).toBeGreaterThan(40);
  }
  expect((await state(page)).status).toBe('playing');
  expectNoErrors(errors);
  const res = await destroyPlayer(page);
  expect(res.textures.created - res.textures.destroyed, 'GPU textures alive after 5 renderer switches').toBe(0);
  expect(res.frames.opened - res.frames.closed).toBe(0);
});

test.describe('colour accuracy', () => {
  // Reference: the RGB values the test pattern was authored with.
  for (const r of RENDERERS) {
    test(`${r}: external (browser-converted) frames, H.264 BT.709`, async ({ page }) => {
      const errors = await openApp(page, { renderer: r, tier: 'webcodecs' });
      await load(page, 'colors_h264.mp4');
      await seekPaused(page, 1);
      expect((await state(page)).renderer).toBe(r);
      const px = await samplePatches(page);
      names.forEach((n, i) => expectColorNear(px[i], patches[n], 14, `${r} ${n}`));
      // What the user sees: sample the real screenshot too.
      const shot = await screenshotColor(page, '.lp-video-canvas', rects);
      names.forEach((n, i) => expectColorNear(shot[i], patches[n], 16, `${r} screenshot ${n}`));
      expectNoErrors(errors);
    });

    test(`${r}: planar YUV shader path, 8-bit (FFmpeg software frames)`, async ({ page }) => {
      const errors = await openApp(page, { renderer: r, tier: 'wasm' });
      await load(page, 'colors_h264.mp4');
      await seekPaused(page, 1);
      const st = await stats(page);
      expect(st.mode).toBe('wasm-sw');
      expect(st.chain).toContain('yuv');
      const px = await samplePatches(page);
      names.forEach((n, i) => expectColorNear(px[i], patches[n], 12, `${r} ${n}`));
      expectNoErrors(errors);
    });

    test(`${r}: planar YUV shader path, 10-bit packed (HEVC Main10)`, async ({ page }) => {
      const errors = await openApp(page, { renderer: r, tier: 'wasm' });
      await load(page, 'colors_hevc10.mkv');
      await seekPaused(page, 1);
      const st = await stats(page);
      expect(st.video).toContain('10-bit');
      const px = await samplePatches(page);
      names.forEach((n, i) => expectColorNear(px[i], patches[n], 12, `${r} ${n}`));
      expectNoErrors(errors);
    });

    test(`${r}: BT.601 matrix is honoured`, async ({ page }) => {
      const errors = await openApp(page, { renderer: r, tier: 'wasm' });
      await load(page, 'colors_h264_bt601.mp4');
      await seekPaused(page, 1);
      expect((await stats(page)).colorSpace).toContain('bt601');
      const px = await samplePatches(page);
      names.forEach((n, i) => expectColorNear(px[i], patches[n], 12, `${r} ${n}`));
      expectNoErrors(errors);
    });
  }

  test('all three renderers agree with each other on the same decoded frame', async ({ page }) => {
    await openApp(page, { tier: 'wasm' });
    await load(page, 'colors_hevc10.mkv');
    await seekPaused(page, 1);
    const results: number[][][] = [];
    for (const r of RENDERERS) {
      await setRenderer(page, r);
      await settle(page);
      results.push(await samplePatches(page));
    }
    for (let i = 0; i < rects.length; i++) {
      expectColorNear(results[1][i], results[0][i], 6, `webgl2 vs webgpu ${names[i]}`);
      expectColorNear(results[2][i], results[0][i], 8, `canvas2d vs webgpu ${names[i]}`);
    }
  });
});

test.describe('HDR (BT.2020 PQ) tone mapping in our shaders', () => {
  for (const r of ['webgpu', 'webgl2'] as const) {
    test(`${r}: PQ -> SDR keeps hue and a sane brightness, and every operator differs`, async ({ page }) => {
      const errors = await openApp(page, { renderer: r, tier: 'wasm' });
      await load(page, 'hdr_pq_hevc10.mkv');
      await seekPaused(page, 1);
      const st = await stats(page);
      expect(st.colorSpace).toContain('pq');
      expect(st.colorSpace).toContain('HDR');
      expect(st.chain).toContain('pq→sdr');
      expect(st.chain).toContain('2020→709');
      const seen: Record<string, number[][]> = {};
      for (const op of ['bt2390', 'hable', 'reinhard', 'clip']) {
        await page.evaluate((o) => window.player.command(`set tone-mapping ${o}`), op);
        await page.waitForTimeout(80);
        const px = await samplePatches(page);
        seen[op] = px;
        const [red, green, blue, gray] = px;
        // Hue survives the BT.2020 -> BT.709 gamut conversion.
        expect(red[0], `${op} red patch is red-dominant`).toBeGreaterThan(Math.max(red[1], red[2]) + 40);
        expect(green[1], `${op} green patch is green-dominant`).toBeGreaterThan(Math.max(green[0], green[2]) + 40);
        expect(blue[2], `${op} blue patch is blue-dominant`).toBeGreaterThan(Math.max(blue[0], blue[1]) + 40);
        // Neutral stays neutral and lands in a plausible SDR range.
        expect(Math.max(...gray) - Math.min(...gray), `${op} gray stays neutral`).toBeLessThan(14);
        expect(gray[0], `${op} gray level`).toBeGreaterThan(50);
        expect(gray[0], `${op} gray level`).toBeLessThan(215);
      }
      // "clip" maps SDR-range content 1:1, so the 203-nit-referenced pattern must come back close to the original.
      names.forEach((n, i) => expectColorNear(seen.clip[i], patches[n], 26, `${r} clip ${n}`));
      // BT.2390 only compresses highlights: SDR-range mid-grey passes through untouched ...
      const grayOf = (op: string) => seen[op][3][0];
      expect(Math.abs(grayOf('bt2390') - grayOf('clip')), 'bt2390 leaves mid-tones alone').toBeLessThan(2);
      // ... whereas the filmic curves reshape the whole range.
      expect(Math.abs(grayOf('hable') - grayOf('clip'))).toBeGreaterThan(2);
      expect(Math.abs(grayOf('reinhard') - grayOf('clip'))).toBeGreaterThan(2);
      expect(Math.abs(grayOf('hable') - grayOf('reinhard'))).toBeGreaterThan(2);
      expectNoErrors(errors);
    });

    test(`${r}: highlights above SDR white (100 / 203 / 400 / 1000 nits) are rolled off, not clipped`, async ({ page }) => {
      const errors = await openApp(page, { renderer: r, tier: 'wasm' });
      await load(page, 'hdr_pq_steps.mkv');
      await seekPaused(page, 1);
      // Patches are neutral greys at 100, 203, 400 and 1000 nits (topLeft, topRight, bottomLeft, bottomRight).
      const levels: Record<string, number[]> = {};
      for (const op of ['clip', 'bt2390', 'hable', 'reinhard']) {
        await page.evaluate((o) => window.player.command(`set tone-mapping ${o}`), op);
        await page.waitForTimeout(80);
        const px = await samplePatches(page);
        for (const p of px) expect(Math.max(...p) - Math.min(...p), `${op} stays neutral`).toBeLessThan(10);
        levels[op] = px.map((p) => p[1]);
      }
      const [c100, c203, c400, c1000] = levels.clip;
      // Hard clip: everything at or above reference white is the same flat white.
      expect(c100).toBeLessThan(215);
      expect(c203).toBeGreaterThan(246);
      expect(c400).toBeGreaterThan(250);
      expect(c1000).toBeGreaterThan(250);
      for (const op of ['bt2390', 'hable', 'reinhard']) {
        const [l100, l203, l400, l1000] = levels[op];
        // Detail is preserved: each step is visibly brighter than the previous one ...
        expect(l203 - l100, `${op}: 203 nits brighter than 100`).toBeGreaterThan(6);
        expect(l400 - l203, `${op}: 400 nits brighter than 203`).toBeGreaterThan(6);
        // (the curves flatten towards the mastering peak by design, so this last step is the smallest)
        expect(l1000 - l400, `${op}: 1000 nits brighter than 400`).toBeGreaterThan(3);
        // ... reference white is pulled below display white to make room for the highlights ...
        expect(l203, `${op}: 203 nits is no longer clipped`).toBeLessThan(246);
        // ... and the mastering peak lands at (or very near) display white.
        expect(l1000, `${op}: source peak maps to display peak`).toBeGreaterThan(236);
      }
      expectNoErrors(errors);
    });
  }
});

test.describe('post-processing passes', () => {
  for (const r of ['webgpu', 'webgl2'] as const) {
    test(`${r}: scalers, deband, sharpen and dither run and change the picture as expected`, async ({ page }) => {
      const errors = await openApp(page, { renderer: r, tier: 'webcodecs' });
      await load(page, 'h264_aac.mp4');
      await seekPaused(page, 2);
      await page.evaluate(() => window.player.command('set dither no'));

      // A patch full of fine detail (the noise checkerboard of testsrc2).
      const detail: [number, number, number, number] = [0.5, 0.62, 0.2, 0.2];
      const grab = () =>
        page.evaluate((rect) => {
          const c: HTMLCanvasElement = (window.player as any).renderer.snapshot();
          const ctx = c.getContext('2d')!;
          const d = ctx.getImageData(
            Math.round(rect[0] * c.width),
            Math.round(rect[1] * c.height),
            Math.round(rect[2] * c.width),
            Math.round(rect[3] * c.height),
          ).data;
          // gradient energy = how sharp the patch is
          let energy = 0;
          let sum = 0;
          for (let i = 4; i < d.length; i += 4) {
            energy += Math.abs(d[i + 1] - d[i - 3]);
            sum += d[i + 1];
          }
          return { energy: energy / (d.length / 4), mean: sum / (d.length / 4) };
        }, detail);

      const out: Record<string, { energy: number; mean: number }> = {};
      for (const scaler of ['bilinear', 'bicubic', 'lanczos', 'fsr']) {
        await page.evaluate((s) => window.player.command(`set scale ${s}`), scaler);
        await page.waitForTimeout(60);
        out[scaler] = await grab();
        expect((await stats(page)).chain).toContain(scaler === 'fsr' ? 'easu' : scaler);
        expect(out[scaler].mean, `${scaler} is not black`).toBeGreaterThan(20);
      }
      // Sharper kernels keep more high-frequency energy than bilinear when upscaling 360p.
      expect(out.bicubic.energy).toBeGreaterThan(out.bilinear.energy * 1.02);
      expect(out.lanczos.energy).toBeGreaterThan(out.bilinear.energy * 1.02);
      expect(out.fsr.energy).toBeGreaterThan(out.bilinear.energy * 1.02);

      await page.evaluate(() => window.player.command('set scale bicubic ; set sharpen 1'));
      await page.waitForTimeout(60);
      const sharp = await grab();
      expect((await stats(page)).chain).toContain('rcas');
      expect(sharp.energy, 'RCAS adds edge contrast').toBeGreaterThan(out.bicubic.energy * 1.03);

      await page.evaluate(() => window.player.command('set sharpen 0 ; set deband yes'));
      await page.waitForTimeout(60);
      const deband = await grab();
      expect((await stats(page)).chain).toContain('deband');
      expect(deband.mean).toBeGreaterThan(20);
      // Deband must leave flat, saturated areas alone (within grain).
      await load(page, 'colors_h264.mp4');
      await seekPaused(page, 1);
      await page.evaluate(() => window.player.command('set deband yes'));
      await page.waitForTimeout(60);
      const px = await page.evaluate((rr) => window.player.debug.samplePixels(rr), rects);
      names.forEach((n, i) => expectColorNear(px[i], patches[n], 14, `${r} deband ${n}`));
      expectNoErrors(errors);
    });
  }
});
