import { expect, test, type Page } from '@playwright/test';
import { destroyPlayer, expectNoErrors, load, openApp, openHarness, readFrame, seekPaused, state, stats, waitForTime } from './helpers';

/**
 * Abuse: rapid random seeking mixed with speed changes and pause/play, frame-step runs, repeated
 * create/load/destroy cycles. After each, the player must still be correct (the exact frame asked
 * for is on screen) and must have released everything it took: VideoFrames, GPU textures, heap.
 */

const TIERS = ['webcodecs', 'mse', 'wasm', 'wasm+threads'] as const;

async function hammer(page: Page, seeks: number): Promise<{ maxAlive: number; maxQueue: number }> {
  return page.evaluate(async (n) => {
    const p = window.player;
    // deterministic PRNG so failures are reproducible
    let seed = 0x2f6e2b1;
    const rnd = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let maxAlive = 0;
    let maxQueue = 0;
    for (let i = 0; i < n; i++) {
      p.seek(rnd() * 56, i % 3 !== 0);
      if (i % 6 === 2) p.setSpeed([0.5, 1, 2, 4][(i / 6) & 3]);
      if (i % 5 === 3) p.pause();
      else if (i % 5 === 4) void p.play();
      await new Promise((r) => setTimeout(r, 25 + rnd() * 130));
      const st = p.getStats();
      maxAlive = Math.max(maxAlive, st.frames.alive);
      maxQueue = Math.max(maxQueue, st.pipeline?.queue ?? 0);
    }
    p.setSpeed(1);
    return { maxAlive, maxQueue };
  }, seeks);
}

for (const tier of TIERS) {
  test(`${tier}: survives 45 rapid seeks with speed changes, then lands on the exact frame`, async ({ page }) => {
    const errors = await openApp(page, tier === 'wasm+threads' ? { tier: 'wasm', threads: 1 } : { tier });
    await load(page, 'h264_aac_long.mp4', { autoplay: true });
    await waitForTime(page, 0.4);
    const h = await hammer(page, 45);
    expect((await state(page)).error).toBeNull();
    // Decoded pictures in flight stay bounded no matter how hard we seek.
    expect(h.maxAlive, 'VideoFrames open at any one time').toBeLessThanOrEqual(48);

    // Exact landing: 12.345 s is inside frame 370 (12.333 - 12.367).
    await seekPaused(page, 12.345);
    const r = await readFrame(page);
    expect(r.contrast).toBeGreaterThan(80);
    // WebCodecs/MSE show the frame containing the target; FFmpeg's accurate seek shows the first frame at/after it.
    expect(r.frame, `landed on frame ${r.frame} (pts ${r.pts.toFixed(4)})`).toBe(tier.startsWith('wasm') ? 371 : 370);
    expect(Math.abs(r.pts - r.frame / 30), 'reported PTS matches the picture').toBeLessThan(0.002);

    // And it still plays, in sync, afterwards.
    await page.evaluate(() => window.player.play());
    await waitForTime(page, 13.4);
    const after = await readFrame(page);
    expect(Math.abs(after.frame - after.time * 30)).toBeLessThanOrEqual(2.5);
    expect((await state(page)).status).toBe('playing');
    expectNoErrors(errors);

    const res = await destroyPlayer(page);
    expect(res.frames.opened - res.frames.closed, 'VideoFrames leaked').toBe(0);
    expect(res.textures.created - res.textures.destroyed, 'GPU textures leaked').toBe(0);
    test.info().annotations.push({
      type: 'leaks',
      description: `${res.frames.opened} VideoFrames opened/closed, peak ${h.maxAlive} alive; ${res.textures.created} textures created/destroyed`,
    });
  });
}

for (const tier of ['webcodecs', 'wasm'] as const) {
  test(`${tier}: frame stepping is exact over long runs in both directions`, async ({ page }) => {
    const errors = await openApp(page, { tier });
    await load(page, 'h264_aac_long.mp4');
    await seekPaused(page, 20);
    const start = (await readFrame(page)).frame;
    expect(start).toBe(600);
    const stepTo = async (dir: 1 | -1) => {
      const before = await page.evaluate(() => window.player.debug.lastPresentedPts());
      await page.evaluate((d) => window.player.frameStep(d), dir);
      await page.waitForFunction(
        (b) => Math.abs(window.player.debug.lastPresentedPts() - b) > 0.001 && !window.player.store.state.seeking,
        before,
        { timeout: 20_000 },
      );
      await page.waitForTimeout(30);
      return (await readFrame(page)).frame;
    };
    for (let i = 1; i <= 40; i++) expect(await stepTo(1), `forward step ${i}`).toBe(start + i);
    for (let i = 1; i <= 12; i++) expect(await stepTo(-1), `backward step ${i}`).toBe(start + 40 - i);
    // the clock follows the picture, so resuming continues from the stepped position
    const t = await page.evaluate(() => window.player.currentTime);
    expect(Math.abs(t - (start + 28) / 30)).toBeLessThan(0.02);
    expectNoErrors(errors);
  });
}

test('speed sweep 0.25x - 4x: the clock runs at the requested rate', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'h264_aac_long.mp4', { autoplay: true });
  await waitForTime(page, 0.5);
  for (const rate of [0.25, 0.5, 1.5, 2, 3, 4, 1]) {
    await page.evaluate((r) => {
      if (window.player.currentTime > 40) window.player.seek(2, true);
      window.player.setSpeed(r);
    }, rate);
    await page.waitForTimeout(450);
    const measured = await page.evaluate(async () => {
      const a = window.player.currentTime;
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 1000));
      return (window.player.currentTime - a) / ((performance.now() - t0) / 1000);
    });
    expect(measured / rate, `clock rate at ${rate}x (measured ${measured.toFixed(3)})`).toBeGreaterThan(0.94);
    expect(measured / rate).toBeLessThan(1.06);
  }
  expect((await stats(page)).audioEngine.underruns).toBe(0);
  expectNoErrors(errors);
});

test('create / load / seek / destroy cycles across tiers and renderers leak nothing', async ({ page }) => {
  const errors = await openHarness(page, { auto: 0 });
  const result = await page.evaluate(async () => {
    const L = window.Lumen;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const gc = (window as any).gc as undefined | (() => void);
    const heap = () => (performance as any).memory.usedJSHeapSize / 1048576;
    const combos: Array<[string, string]> = [
      ['webcodecs', 'webgpu'],
      ['mse', 'webgl2'],
      ['wasm', 'canvas2d'],
      ['webcodecs', 'webgl2'],
      ['wasm', 'webgpu'],
      ['mse', 'canvas2d'],
    ];
    const heaps: number[] = [];
    const cycles = 18;
    for (let i = 0; i < cycles; i++) {
      const [tier, renderer] = combos[i % combos.length];
      const p = L.make({ tier, renderer });
      const loading = p.load('/media/h264_aac.mp4', { autoplay: true }).catch(() => {});
      if (i % 6 === 5) {
        // tear down while the load is still in flight
        await sleep(30);
      } else {
        await loading;
        await sleep(280);
        for (let k = 0; k < 4; k++) {
          p.seek(Math.random() * 7, k % 2 === 0);
          await sleep(45);
        }
        if (i % 4 === 1) p.setSpeed(2);
        if (i % 3 === 0) await sleep(150);
      }
      await p.destroy();
      if (i % 3 === 2) {
        await sleep(250);
        gc?.();
        await sleep(50);
        heaps.push(heap());
      }
    }
    await sleep(700);
    gc?.();
    return {
      frames: { ...L.frameLedger },
      textures: { ...L.textureLedger },
      heaps,
      leftovers: document.querySelectorAll('#host canvas, #host video, #host .lp-stage').length,
      hasGc: !!gc,
    };
  });
  expect(result.frames.opened).toBeGreaterThan(50);
  expect(result.frames.opened - result.frames.closed, 'VideoFrames leaked').toBe(0);
  expect(result.textures.created).toBeGreaterThan(10);
  expect(result.textures.created - result.textures.destroyed, 'GPU textures leaked').toBe(0);
  expect(result.leftovers, 'DOM nodes left behind').toBe(0);
  expect(result.hasGc, 'test needs --expose-gc').toBe(true);
  // Heap after the first batch of cycles vs. after the last: no upward creep.
  const first = result.heaps[0];
  const last = result.heaps[result.heaps.length - 1];
  expect(last - first, `JS heap after GC, MB: ${result.heaps.map((h) => h.toFixed(1)).join(' → ')}`).toBeLessThan(12);
  test.info().annotations.push({
    type: 'leaks',
    description: `18 cycles: ${result.frames.opened} VideoFrames, ${result.textures.created} textures, heap ${result.heaps.map((h) => h.toFixed(1)).join(' → ')} MB`,
  });
  expectNoErrors(errors);
});

test('long playback with periodic seeks keeps frame and heap usage flat', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'h264_aac_long.mp4', { autoplay: true });
  await waitForTime(page, 0.5);
  const r = await page.evaluate(async () => {
    const p = window.player;
    const gc = (window as any).gc as () => void;
    const heap = () => (performance as any).memory.usedJSHeapSize / 1048576;
    p.setSpeed(2);
    gc();
    const h0 = heap();
    let maxAlive = 0;
    const t0 = performance.now();
    let i = 0;
    while (performance.now() - t0 < 12000) {
      await new Promise((res) => setTimeout(res, 200));
      maxAlive = Math.max(maxAlive, p.getStats().frames.alive);
      if (++i % 10 === 0) p.seek((i * 3.7) % 50, true);
    }
    gc();
    await new Promise((res) => setTimeout(res, 100));
    const st = p.getStats();
    return {
      maxAlive,
      heapGrowth: heap() - h0,
      opened: st.frames.opened,
      textures: st.render.texturesCreated - st.render.texturesDestroyed,
    };
  });
  expect(r.opened).toBeGreaterThan(500);
  expect(r.maxAlive, 'VideoFrames open at once').toBeLessThanOrEqual(48);
  expect(r.textures, 'live GPU textures stays constant').toBeLessThanOrEqual(4);
  expect(r.heapGrowth, 'JS heap growth over 12 s at 2x, MB').toBeLessThan(10);
  expectNoErrors(errors);
});
