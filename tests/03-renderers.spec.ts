import { expect, test } from '@playwright/test';
import { pqEotf, pqOetf } from '../src/render/color';
import { PEAK_TAU } from '../src/render/peak';
import {
  destroyPlayer,
  expectColorNear,
  expectNoErrors,
  load,
  manifest,
  openApp,
  openHarness,
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
      // This picture never passes SDR white. Told that its source reaches 1000 nits, every curve
      // makes room for highlights that do not come; that is what is compared here.
      await page.evaluate(() => window.player.command('set hdr-peak-source fixed'));
      expect(st.hdrMetadata, 'the clip carries no static metadata').toBe('');
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
      // Measured, there is nothing to make room for: the peak is SDR white itself, and the curves
      // that are the identity there leave the picture as a clip would.
      await page.evaluate(() => window.player.command('set hdr-peak-source measured'));
      for (const op of ['bt2390', 'reinhard']) {
        await page.evaluate((o) => window.player.command(`set tone-mapping ${o}`), op);
        await page.waitForTimeout(80);
        const px = await samplePatches(page);
        names.forEach((n, i) => expectColorNear(px[i], seen.clip[i], 3, `${r} ${op} with the measured peak, ${n}`));
      }
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

test.describe('HDR frames decoded by the browser get the same colour pipeline as software-decoded ones', () => {
  // The browser hands HDR pictures to WebGPU and WebGL2 as coded PQ samples (see external-hdr.ts).
  // Shown as they come they are flat and grey: the grey patch read 175 on WebGPU and 109 on WebGL2
  // where the software-decoded picture has 135.
  for (const r of ['webgpu', 'webgl2'] as const) {
    test(`${r}: PQ through WebCodecs and MSE matches the software-decoded picture`, async ({ page }) => {
      const files = ['hdr_pq_hevc10.mkv', 'hdr_pq_steps.mkv'];
      // Reference: our shaders on planes decoded by FFmpeg.
      const reference: Record<string, number[][]> = {};
      let errors = await openApp(page, { renderer: r, tier: 'wasm' });
      for (const file of files) {
        await load(page, file);
        await seekPaused(page, 1);
        reference[file] = await samplePatches(page);
      }
      expectNoErrors(errors);

      for (const [tier, mode] of [
        ['webcodecs', 'webcodecs'],
        ['mse', 'mse-remux'],
      ]) {
        errors = await openApp(page, { renderer: r, tier });
        for (const file of files) {
          await load(page, file);
          await seekPaused(page, 1);
          const st = await stats(page);
          expect(st.mode).toBe(mode);
          expect(st.renderer).toBe(r);
          expect(st.chain, `${tier}: the browser's frame goes through our colour pipeline`).toContain('external(pq samples)');
          expect(st.chain).toContain('pq→sdr(bt2390)');
          expect(st.chain).toContain('2020→709');
          const px = await samplePatches(page);
          names.forEach((n, i) => expectColorNear(px[i], reference[file][i], 12, `${r} ${tier} ${file} ${n} vs software decode`));
        }
        // The colour clip has several brightness levels, which is what the check against the
        // browser's own 2D-canvas conversion needs (WebGPU reads back asynchronously).
        await load(page, files[0]);
        await seekPaused(page, 1);
        await expect.poll(async () => (await stats(page)).hdrHandover, { timeout: 5000 }).toContain('checked against the 2D canvas');
        const handover = (await stats(page)).hdrHandover as string;
        expect(handover, `${r} ${tier}`).toContain(r === 'webgpu' ? 'coded-srgb' : 'coded (');
        // Settings reach these frames too: a hard clip puts 203 nits and everything above at white.
        await load(page, files[1]);
        await seekPaused(page, 1);
        await page.evaluate(() => window.player.command('set tone-mapping clip'));
        await page.waitForTimeout(80);
        const clipped = await samplePatches(page);
        expect(clipped[0][1], 'clip: 100 nits stays below white').toBeLessThan(215);
        expect(Math.min(clipped[1][1], clipped[2][1], clipped[3][1]), 'clip: 203 nits and up are white').toBeGreaterThan(240);
        expectNoErrors(errors);
      }
    });
  }

  test('the hdrShader: false option leaves HDR frames as the browser hands them over', async ({ page }) => {
    const errors = await openHarness(page, { auto: 0, renderer: 'webgpu', tier: 'webcodecs' });
    const r = await page.evaluate(async (rects) => {
      const p = window.Lumen.make({ hdrShader: false });
      window.player = p;
      await p.load('/media/hdr_pq_hevc10.mkv');
      p.seek(1, true);
      const t0 = performance.now();
      while (performance.now() - t0 < 8000 && (p.store.state.seeking || Math.abs(p.debug.lastPresentedPts() - 1) > 0.12)) {
        await new Promise((res) => setTimeout(res, 50));
      }
      await new Promise((res) => setTimeout(res, 250));
      const st = p.getStats();
      return {
        mode: st.mode,
        chain: st.chain as string,
        handover: st.hdrHandover as string,
        px: p.debug.samplePixels(rects) as number[][],
      };
    }, rects);
    expect(r.mode).toBe('webcodecs');
    expect(r.chain.startsWith('external →'), `chain: ${r.chain}`).toBe(true);
    expect(r.handover).toBe('');
    // Coded samples on screen: the grey patch is far from the 135 of the managed picture.
    expect(Math.abs(r.px[3][1] - 135)).toBeGreaterThan(25);
    expectNoErrors(errors);
  });
});

test.describe('HDR peak: what the stream says and what the picture shows replace the 1000-nit assumption', () => {
  // hdr_pq_peaks.mkv: two seconds that never pass 400 nits (50 / 100 / 203 / 400), a hard cut,
  // two seconds that reach 4000 (203 / 1000 / 2000 / 4000). Tagged MaxCLL 4000, mastered at 4000.
  const HP = manifest.hdrPeaks;
  const ROUTES = [
    ['wasm', 'wasm-sw'],
    ['webcodecs', 'webcodecs'],
    ['mse', 'mse-remux'],
  ] as const;
  type P = import('@playwright/test').Page;
  const cmd = (page: P, c: string) => page.evaluate((x) => window.player.command(x), c);
  // Green: the hardware path leaves a slight tint on some flat patches, least of it there.
  const levels = async (page: P) => (await samplePatches(page)).map((p) => p[1]);
  const readPeak = (page: P): Promise<{ peak: number; mean: number } | null> =>
    page.evaluate(() => (window.player as any).renderer.readPeak());

  for (const r of ['webgpu', 'webgl2'] as const) {
    test(`${r}: 4000 nits tagged as 4000 nits are rolled off instead of clipped, on every decoding route`, async ({ page }) => {
      for (const [tier, mode] of ROUTES) {
        const errors = await openApp(page, { renderer: r, tier });
        await load(page, 'hdr_pq_peaks.mkv');
        await cmd(page, 'set dither no ; set hdr-peak-source metadata');
        await seekPaused(page, HP.cut + 1);
        const st = await stats(page);
        expect(st.mode).toBe(mode);
        expect(st.renderer).toBe(r);
        // SEI messages in the HEVC stream: read by ffprobe on one route, by our own parser on the others.
        expect(st.hdrMetadata, tier).toBe('MaxCLL 4000, MaxFALL 1800, mastering display 0.005–4000 nits');
        expect(st.hdrPeak, tier).toBe('4000 nits (MaxCLL)');
        const seen: Record<string, number[]> = {};
        for (const op of ['bt2390', 'hable', 'reinhard']) {
          await cmd(page, `set tone-mapping ${op}`);
          await page.waitForTimeout(80);
          const [l203, l1000, l2000, l4000] = (seen[op] = await levels(page));
          const what = `${r} ${tier} ${op}: ${seen[op].map((v) => v.toFixed(1))}`;
          // Every step up in the source is a step up on screen, and the stated peak is display white.
          expect(l1000 - l203, what).toBeGreaterThan(30);
          expect(l2000 - l1000, what).toBeGreaterThan(op === 'bt2390' ? 2.5 : 8);
          expect(l4000 - l2000, what).toBeGreaterThan(op === 'bt2390' ? 0.5 : 6);
          expect(l1000, `${what}: 1000 nits stays below white`).toBeLessThan(252);
          expect(l4000, `${what}: the peak is white`).toBeGreaterThan(253);
        }
        // The old assumption, for comparison: everything from 1000 nits up is one flat white ...
        await cmd(page, 'set tone-mapping bt2390 ; set hdr-peak-source fixed');
        await page.waitForTimeout(80);
        expect((await stats(page)).hdrPeak).toBe('1000 nits (fixed)');
        const fixed = await levels(page);
        expect(
          Math.min(fixed[1], fixed[2], fixed[3]),
          `${r} ${tier} fixed at 1000 nits: ${fixed.map((v) => v.toFixed(1))}`,
        ).toBeGreaterThan(253);
        // ... and reference white sits higher, because less room was kept above it.
        expect(fixed[0] - seen.bt2390[0]).toBeGreaterThan(12);
        // The fixed value can be set, and then does what the metadata did.
        await cmd(page, 'set hdr-peak 4000');
        await page.waitForTimeout(80);
        expect((await stats(page)).hdrPeak).toBe('4000 nits (fixed)');
        (await levels(page)).forEach((v, i) =>
          expect(Math.abs(v - seen.bt2390[i]), `fixed 4000 equals MaxCLL 4000, patch ${i}`).toBeLessThan(1.5),
        );
        expectNoErrors(errors);
      }
    });

    test(`${r}: a scene that peaks at 400 nits is brighter with the measured peak than with the assumption, on every route`, async ({
      page,
    }) => {
      for (const [tier, mode] of ROUTES) {
        const errors = await openApp(page, { renderer: r, tier });
        await load(page, 'hdr_pq_peaks.mkv');
        await cmd(page, 'set dither no');
        await seekPaused(page, HP.cut - 1);
        expect((await state(page)).hdrPeakSource, 'measuring is the default').toBe('measured');
        expect((await stats(page)).mode).toBe(mode);
        // The number stays on the GPU; the overlay asks for it.
        await expect
          .poll(async () => (await stats(page)).hdrPeak, { timeout: 5000 })
          .toMatch(/^4\d\d nits \(measured; picture average 1\d\d nits\)$/);
        const m = (await readPeak(page))!;
        expect(m.peak, `${r} ${tier}: measured peak`).toBeGreaterThan(385);
        expect(m.peak, `${r} ${tier}: measured peak`).toBeLessThan(450);
        const seen: Record<string, Record<string, number[]>> = {};
        for (const source of ['measured', 'fixed', 'metadata']) {
          seen[source] = {};
          for (const op of ['bt2390', 'hable', 'reinhard']) {
            await cmd(page, `set hdr-peak-source ${source} ; set tone-mapping ${op}`);
            await page.waitForTimeout(80);
            seen[source][op] = await levels(page);
          }
        }
        const what = `${r} ${tier}: ${JSON.stringify(seen, (_, v) => (typeof v === 'number' ? Math.round(v) : v))}`;
        for (const op of ['bt2390', 'hable', 'reinhard']) {
          const [, m100, m203, m400] = seen.measured[op];
          const [, f100, f203, f400] = seen.fixed[op];
          const [, , t203, t400] = seen.metadata[op];
          // Reference white and the scene's own peak are brighter than under the 1000-nit guess ...
          expect(m203 - f203, what).toBeGreaterThan(10);
          expect(m400 - f400, what).toBeGreaterThan(4);
          // ... the peak of the scene is display white, or very near it ...
          expect(m400, what).toBeGreaterThan(242);
          // ... and the programme-wide 4000 nits of the metadata leave this scene darker still.
          expect(f203 - t203, what).toBeGreaterThan(2);
          expect(f400 - t400, what).toBeGreaterThan(5);
          // BT.2390 only ever touches what lies above its knee: the mid-tones do not move.
          if (op === 'bt2390') expect(Math.abs(m100 - f100), what).toBeLessThan(2);
        }
        // Drawing the paused picture again changes nothing, whatever was shown in between.
        await cmd(page, 'set hdr-peak-source measured ; set tone-mapping bt2390');
        await page.waitForTimeout(80);
        (await levels(page)).forEach((v, i) =>
          expect(v, `${r} ${tier} patch ${i} after switching away and back`).toBe(seen.measured.bt2390[i]),
        );
        expect((await readPeak(page))!.peak).toBe(m.peak);
        // The other scene has its own peak: a seek starts the measurement over.
        await seekPaused(page, HP.cut + 1);
        const bright = (await readPeak(page))!;
        expect(bright.peak, `${r} ${tier}: after the seek`).toBeGreaterThan(3600);
        expect(bright.peak, `${r} ${tier}: after the seek`).toBeLessThan(4400);
        expectNoErrors(errors);
      }
    });

    test(`${r}: the measured peak follows a scene slowly, jumps at a cut, and a picture drawn again stays as it is`, async ({ page }) => {
      const errors = await openApp(page, { renderer: r, tier: 'wasm' });
      await load(page, 'hdr_pq_peaks.mkv');
      await seekPaused(page, 1);
      // Synthetic BT.2020 PQ pictures straight into the renderer: a grey background, a patch at
      // SDR white on the left and a small highlight on the right, everything in nits.
      const out = await page.evaluate(async () => {
        const pq = (nits: number) => {
          const y = Math.pow(nits / 10000, 0.1593017578125);
          return Math.pow((0.8359375 + 18.8515625 * y) / (1 + 18.6875 * y), 78.84375);
        };
        const W = 128;
        const H = 64;
        const make = (pts: number, background: number, highlight: number) => {
          const code = (nits: number) => Math.round((219 * pq(nits) + 16) * 4);
          const Y = new Uint16Array(W * H).fill(code(background));
          const fill = (x0: number, y0: number, w: number, h: number, nits: number) => {
            for (let y = y0; y < y0 + h; y++) Y.fill(code(nits), y * W + x0, y * W + x0 + w);
          };
          fill(8, 16, 32, 32, 203);
          fill(88, 24, 16, 16, highlight);
          const C = new Uint16Array((W / 2) * (H / 2)).fill(512);
          return {
            kind: 'planar',
            pts,
            duration: 1 / 24,
            width: W,
            height: H,
            bitDepth: 10,
            planes: [new Uint8Array(Y.buffer), new Uint8Array(C.buffer), new Uint8Array(C.slice().buffer)],
            chromaWidth: W / 2,
            chromaHeight: H / 2,
            color: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020nc', fullRange: false },
            rotation: 0,
          };
        };
        const p = window.player as any;
        const R = p.renderer;
        const S = {
          ...p.settings,
          hdrPeakSource: 'measured',
          toneMapping: 'bt2390',
          dither: false,
          scaler: 'bilinear',
          sharpen: 0,
          deband: false,
        };
        // The picture as drawn: the level of the SDR-white patch, and a checksum of every pixel.
        const grab = () => {
          const c: HTMLCanvasElement = R.snapshot();
          const ctx = c.getContext('2d')!;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let sum = 0;
          for (let i = 0; i < d.length; i++) sum = (sum * 31 + d[i]) >>> 0;
          const ref = ctx.getImageData(Math.round((24 / W) * c.width), Math.round(0.5 * c.height), 1, 1).data[1];
          return { sum, ref };
        };
        const peak = async () => (await R.readPeak()).peak as number;
        const res: Record<string, any> = {};

        // The first picture: all there is to go by.
        let f = make(100, 100, 400);
        R.render(f, S);
        res.first = { peak: await peak(), px: grab() };
        res.firstAgain = [grab(), grab()];
        R.render(f, { ...S, hdrPeakSource: 'fixed' });
        res.firstFixed = grab();

        // The next one has a much brighter highlight, too small to move the average.
        f = make(100 + 1 / 24, 100, 1000);
        R.render(f, S);
        res.second = { peak: await peak(), px: grab() };
        // Half-way between two states is where drawing again must not move anything.
        res.secondAgain = [grab(), grab(), grab()];
        R.render(f, { ...S, hdrPeakSource: 'fixed' });
        R.render(f, { ...S, toneMapping: 'hable' });
        R.render(f, S);
        res.secondBack = { peak: await peak(), px: grab() };

        // Three seconds of the same scene.
        res.trail = [];
        for (let i = 2; i <= 73; i++) {
          f = make(100 + i / 24, 100, 1000);
          R.render(f, S);
          if (i % 24 === 1) res.trail.push(await peak());
        }
        res.trailEnd = grab();
        // A cut: the whole picture is another one.
        f = make(100 + 74 / 24, 1000, 4000);
        R.render(f, S);
        res.cut = await peak();
        // A seek to a picture with much the same average, and a step back from there.
        f = make(500, 1000, 1500);
        R.render(f, S);
        res.seek = await peak();
        f = make(500 - 1 / 24, 1000, 2500);
        R.render(f, S);
        res.back = await peak();
        return res;
      });
      const near = (got: number, want: number, what: string) =>
        expect(Math.abs(got / want - 1), `${r} ${what}: ${got.toFixed(1)} nits, expected ${want.toFixed(1)}`).toBeLessThan(0.02);
      const lowPass = (seconds: number) => pqEotf(pqOetf(1000) - (pqOetf(1000) - pqOetf(400)) * Math.exp(-seconds / PEAK_TAU));

      near(out.first.peak, 400, 'first picture');
      for (const again of out.firstAgain) expect(again, 'the first picture drawn again').toEqual(out.first.px);
      // Reference white is brighter than under the 1000-nit assumption.
      expect(out.first.px.ref - out.firstFixed.ref, `${out.first.px.ref} vs ${out.firstFixed.ref}`).toBeGreaterThan(8);

      // One frame later the state has moved a twentieth of the way, in PQ terms: 432 nits, not 1000.
      near(out.second.peak, lowPass(1 / 24), 'second picture');
      expect(out.second.peak).toBeGreaterThan(out.first.peak * 1.04);
      for (const again of out.secondAgain) expect(again, 'the second picture drawn again').toEqual(out.second.px);
      expect(out.secondBack, 'after other settings and back').toEqual(out.second);

      // After one, two and three seconds: the low-pass with its time constant.
      expect(out.trail.length).toBe(3);
      out.trail.forEach((v: number, i: number) => near(v, lowPass((24 * (i + 1) + 1) / 24), `after ${i + 1} s`));
      expect(out.trail[2]).toBeGreaterThan(940);
      // The picture follows the state: by now reference white is where a 1000-nit peak puts it.
      expect(out.first.px.ref - out.trailEnd.ref, `${out.first.px.ref} then ${out.trailEnd.ref}`).toBeGreaterThan(8);
      expect(Math.abs(out.trailEnd.ref - out.firstFixed.ref)).toBeLessThanOrEqual(2);

      // The cut is taken at once, and so is a seek; neither is smoothed in.
      near(out.cut, 4000, 'scene cut');
      near(out.seek, 1500, 'seek');
      near(out.back, 2500, 'step back');
      expectNoErrors(errors);
    });

    test(`${r}: the cut in a real stream is found frame-exactly, stepping and playing`, async ({ page }) => {
      for (const tier of ['wasm', 'webcodecs'] as const) {
        const errors = await openApp(page, { renderer: r, tier });
        await load(page, 'hdr_pq_peaks.mkv');
        await seekPaused(page, HP.cut - 4 / 30);
        const seenPeaks: Array<[number, number]> = [];
        for (let i = 0; i < 8; i++) {
          const pts: number = await page.evaluate(() => window.player.debug.lastPresentedPts());
          seenPeaks.push([pts, (await readPeak(page))!.peak]);
          await cmd(page, 'frame-step');
          await page.waitForFunction((t) => window.player.debug.lastPresentedPts() > t + 0.01, pts, { timeout: 10_000 });
        }
        const what = `${r} ${tier}: ${seenPeaks.map(([t, v]) => `${t.toFixed(3)}s ${v.toFixed(0)}`).join(', ')}`;
        const before = seenPeaks.filter(([t]) => t < HP.cut - 0.01);
        const after = seenPeaks.filter(([t]) => t >= HP.cut - 0.01);
        expect(before.length, what).toBeGreaterThanOrEqual(3);
        expect(after.length, what).toBeGreaterThanOrEqual(3);
        for (const [, v] of before) expect(v, what).toBeLessThan(450);
        // The very first picture of the new scene already has its peak.
        for (const [, v] of after) expect(v, what).toBeGreaterThan(3600);

        // The same while playing: across the cut, then back.
        await seekPaused(page, HP.cut - 0.5);
        expect((await readPeak(page))!.peak).toBeLessThan(450);
        await page.evaluate(() => window.player.play());
        await waitForTime(page, HP.cut + 0.4);
        await page.evaluate(() => window.player.pause());
        await page.waitForTimeout(150);
        const played = (await readPeak(page))!.peak;
        expect(played, `${r} ${tier}: after playing across the cut`).toBeGreaterThan(3600);
        expect(played).toBeLessThan(4400);
        expectNoErrors(errors);
      }
    });

    test(`${r}: VP9 keeps its HDR metadata in the WebM track header, and it is found on every route`, async ({ page }) => {
      for (const [tier, mode] of ROUTES) {
        const errors = await openApp(page, { renderer: r, tier });
        await load(page, 'hdr_pq_vp9_colour.webm');
        await cmd(page, 'set dither no ; set hdr-peak-source metadata');
        await seekPaused(page, 1);
        const st = await stats(page);
        expect(st.mode).toBe(mode);
        expect(st.hdrMetadata, tier).toBe('MaxCLL 4000, MaxFALL 1800, mastering display 0.005–4000 nits');
        expect(st.hdrPeak, tier).toBe('4000 nits (MaxCLL)');
        const [l203, l1000, l2000, l4000] = await levels(page);
        expect(l1000 - l203).toBeGreaterThan(30);
        expect(l1000, `${r} ${tier}: 1000 nits stays below white`).toBeLessThan(252);
        expect(l2000 - l1000).toBeGreaterThan(2.5);
        expect(l4000).toBeGreaterThan(253);
        expectNoErrors(errors);
      }
    });
  }

  test('a stream without metadata falls back on the fixed value, and the setting is in the Video menu and the overlay', async ({
    page,
  }) => {
    const errors = await openApp(page, { renderer: 'webgpu', tier: 'wasm', skin: 'glass' });
    await load(page, 'hdr_pq_steps.mkv');
    await seekPaused(page, 1);
    await page.mouse.move(640, 640);
    await page.locator('[data-control="video"]').click();
    await expect(page.locator('.lp-menu-item[data-checked="true"]', { hasText: 'Measured per scene' })).toBeVisible();
    await page.locator('.lp-menu-item', { hasText: 'From the stream' }).click();
    expect((await state(page)).hdrPeakSource).toBe('metadata');
    await expect(page.locator('.lp-menu-item[data-checked="true"]', { hasText: 'From the stream' })).toBeVisible();
    // Nothing in this stream: 1000 nits, and the overlay says that it is an assumption.
    let st = await stats(page);
    expect(st.hdrMetadata).toBe('');
    expect(st.hdrPeak).toBe('1000 nits (assumed: the stream states no peak)');
    await page.locator('.lp-menu-item', { hasText: 'Fixed peak: next value' }).click();
    expect((await state(page)).hdrPeak).toBe(2000);
    await page.locator('.lp-menu-item', { hasText: 'Fixed: 2000 nits' }).click();
    st = await stats(page);
    expect((await state(page)).hdrPeakSource).toBe('fixed');
    expect(st.hdrPeak).toBe('2000 nits (fixed)');
    await page.keyboard.press('Escape');
    await cmd(page, 'set hdr-peak 99999');
    expect((await state(page)).hdrPeak, 'clamped to what PQ can code').toBe(10000);
    await cmd(page, 'set hdr-peak 1000 ; set hdr-peak-source measured');
    await page.locator('.lp-root').focus();
    await page.keyboard.press('i');
    await expect(page.locator('.lp-stats')).toContainText(/HDR peak\s+10\d\d nits \(measured; picture average \d+ nits\)/, {
      timeout: 5000,
    });
    // The Canvas 2D renderer has no tone curve of its own, and so no peak to report.
    await setRenderer(page, 'canvas2d');
    await settle(page);
    expect((await stats(page)).hdrPeak).toBe('');
    expectNoErrors(errors);
  });
});

test.describe('wide-gamut colours that BT.709 cannot show', () => {
  for (const r of ['webgpu', 'webgl2'] as const) {
    test(`${r}: soft gamut mapping keeps hue and gradation where clipping flattens them`, async ({ page }) => {
      const errors = await openApp(page, { renderer: r, tier: 'wasm' });
      await load(page, 'hdr_pq_hevc10.mkv');
      await seekPaused(page, 1);
      // A synthetic BT.2020 PQ picture, 4 x 2 patches of linear light in nits, fed straight to the
      // renderer: no clip in the repository leaves BT.709.
      const patchNits: Array<[number, number, number]> = [
        [0, 100, 0], // BT.2020 green, far outside BT.709
        [10, 100, 5], // a little less saturated: still outside
        [100, 0, 0], // BT.2020 red
        [1000, 20, 10], // a saturated highlight at the mastering peak
        [60, 80, 50], // an ordinary colour, well inside
        [100, 100, 100], // grey
        [0, 0, 100], // BT.2020 blue
        [30, 100, 30], // green that BT.709 can almost show
      ];
      const render = (gamut: string) =>
        page.evaluate(
          ([patches, gamut]) => {
            const pq = (nits: number) => {
              const y = Math.pow(nits / 10000, 0.1593017578125);
              return Math.pow((0.8359375 + 18.8515625 * y) / (1 + 18.6875 * y), 78.84375);
            };
            const P = 32;
            const W = 4 * P;
            const H = 2 * P;
            const cw = W / 2;
            const ch = H / 2;
            const Y = new Uint16Array(W * H);
            const U = new Uint16Array(cw * ch);
            const V = new Uint16Array(cw * ch);
            (patches as number[][]).forEach(([rn, gn, bn], i) => {
              const R = pq(rn);
              const G = pq(gn);
              const B = pq(bn);
              const y = 0.2627 * R + 0.678 * G + 0.0593 * B;
              const dy = Math.round((219 * y + 16) * 4);
              const du = Math.round((224 * ((B - y) / 1.8814) + 128) * 4);
              const dv = Math.round((224 * ((R - y) / 1.4746) + 128) * 4);
              const px = (i % 4) * P;
              const py = Math.floor(i / 4) * P;
              for (let yy = 0; yy < P; yy++) for (let xx = 0; xx < P; xx++) Y[(py + yy) * W + px + xx] = dy;
              for (let yy = 0; yy < P / 2; yy++)
                for (let xx = 0; xx < P / 2; xx++) {
                  U[(py / 2 + yy) * cw + px / 2 + xx] = du;
                  V[(py / 2 + yy) * cw + px / 2 + xx] = dv;
                }
            });
            const p = window.player as any;
            const frame = {
              kind: 'planar',
              pts: 0,
              duration: 1 / 30,
              width: W,
              height: H,
              bitDepth: 10,
              planes: [new Uint8Array(Y.buffer), new Uint8Array(U.buffer), new Uint8Array(V.buffer)],
              chromaWidth: cw,
              chromaHeight: ch,
              color: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020nc', fullRange: false },
              rotation: 0,
            };
            p.renderer.render(frame, { ...p.settings, gamutMapping: gamut, dither: false, scaler: 'bilinear', sharpen: 0, deband: false });
            const c: HTMLCanvasElement = p.renderer.snapshot();
            const ctx = c.getContext('2d')!;
            return (patches as number[][]).map((_, i) => {
              const x = Math.round((((i % 4) + 0.5) / 4) * c.width);
              const y = Math.round(((Math.floor(i / 4) + 0.5) / 2) * c.height);
              const d = ctx.getImageData(x - 2, y - 2, 4, 4).data;
              let rr = 0;
              let gg = 0;
              let bb = 0;
              for (let k = 0; k < d.length; k += 4) {
                rr += d[k];
                gg += d[k + 1];
                bb += d[k + 2];
              }
              return [rr / 16, gg / 16, bb / 16];
            });
          },
          [patchNits, gamut] as const,
        );
      const clip = await render('clip');
      const soft = await render('soft');
      const [green, green2, red, hot, inside, grey, blue, nearGreen] = soft;
      // Inside the gamut nothing changes.
      expectColorNear(inside, clip[4], 2, `${r} in-gamut colour`);
      expectColorNear(grey, clip[5], 2, `${r} grey`);
      expect(Math.max(...grey) - Math.min(...grey), 'grey stays neutral').toBeLessThan(4);
      // Clipping maps both greens to the same colour; soft mapping keeps them apart.
      expect(Math.abs(clip[0][0] - clip[1][0]) + Math.abs(clip[0][2] - clip[1][2]), 'clip flattens the two greens').toBeLessThan(3);
      expect(green2[0] - green[0], 'soft keeps the less saturated green less saturated').toBeGreaterThan(5);
      // The edge of the source gamut lands on the edge of BT.709 ...
      expect(green[0], 'BT.2020 green: no red').toBeLessThan(4);
      expect(red[1], 'BT.2020 red: no green').toBeLessThan(4);
      expect(blue[0], 'BT.2020 blue: no red').toBeLessThan(4);
      // ... at the hue of the source, not at the nearest BT.709 primary: BT.2020 green is bluer
      // than BT.709 green, its red is deeper, its blue slightly greener.
      expect(green[2], 'BT.2020 green keeps its hue').toBeGreaterThan(80);
      expect(red[2], 'BT.2020 red keeps its hue').toBeGreaterThan(40);
      expect(blue[1], 'BT.2020 blue keeps its hue').toBeGreaterThan(30);
      // The dominant channel still dominates, and its brightness is not given up to make room.
      expect(green[1]).toBeGreaterThan(Math.max(green[0], green[2]) + 60);
      expect(red[0]).toBeGreaterThan(Math.max(red[1], red[2]) + 60);
      expect(blue[2]).toBeGreaterThan(Math.max(blue[0], blue[1]) + 60);
      expect(nearGreen[1]).toBeGreaterThan(nearGreen[0] + 60);
      expect(Math.abs(green[1] - clip[0][1])).toBeLessThan(4);
      expect(Math.abs(red[0] - clip[2][0])).toBeLessThan(4);
      // A highlight too saturated for display white gives up saturation, not luminance.
      expect(hot[0], 'still at display white').toBeGreaterThan(250);
      expect(clip[3][1] + clip[3][2], 'clipped: pure red, darker than the source').toBeLessThan(40);
      expect(hot[1], 'soft: lighter, towards white').toBeGreaterThan(clip[3][1] + 40);
      expect(hot[0]).toBeGreaterThan(hot[1] + 40);
      // The setting is a player property like the others (the clip that is loaded is BT.2020).
      await page.evaluate(() => window.player.command('set gamut-mapping clip'));
      expect((await state(page)).gamutMapping).toBe('clip');
      expect((await stats(page)).chain).not.toContain('(soft)');
      await page.evaluate(() => window.player.command('set gamut-mapping soft'));
      expect((await stats(page)).chain).toContain('2020→709(soft)');
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
