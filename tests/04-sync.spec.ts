import { expect, test, type Page } from '@playwright/test';
import {
  audioLevel,
  dominantFrequency,
  expectNoErrors,
  load,
  manifest,
  openApp,
  readFrame,
  seekPaused,
  state,
  stats,
  waitForTime,
} from './helpers';

/**
 * A/V synchronisation, measured three independent ways:
 *   1. the pipeline's own bookkeeping (audio clock minus PTS of each presented frame),
 *   2. content truth: the frame number burned into the pixels vs. the audio clock,
 *   3. end to end: when the 880 Hz beep is heard on the output bus vs. when the white flash is drawn.
 * Plus the audio features that could disturb sync: speed changes with and without pitch correction,
 * surround downmix, gain, and A-B looping.
 */

const TIERS = ['webcodecs', 'mse', 'wasm'] as const;

/** Sample (frame number from pixels) - (clock * fps) repeatedly while playing. */
async function frameErrors(page: Page, fps: number, samples = 28, everyMs = 90): Promise<number[]> {
  const errs: number[] = [];
  for (let i = 0; i < samples; i++) {
    const r = await readFrame(page);
    if (r.contrast > 80) errs.push(r.frame - r.time * fps);
    await page.waitForTimeout(everyMs);
  }
  return errs;
}

for (const tier of TIERS) {
  test(`${tier}: picture stays locked to the audio clock (pipeline drift + pixel truth)`, async ({ page }) => {
    const errors = await openApp(page, { tier });
    await load(page, 'h264_aac.mp4', { autoplay: true });
    await waitForTime(page, 0.9);
    // Count display refreshes that never came (headless compositors skip some): a frame can only be
    // "dropped" legitimately when the display offered no refresh for it.
    await page.evaluate(() => {
      window.player.debug.resetDrift();
      const w = window as any;
      w.__skips = 0;
      let last = 0;
      const loop = (now: number) => {
        if (last && now - last > 36) w.__skips += Math.round((now - last) / 16.7) - 1;
        last = now;
        if (!w.__stopSkips) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });

    // 2. pixel truth
    const errs = await frameErrors(page, 30);
    expect(errs.length).toBeGreaterThan(20);
    const worst = Math.max(...errs.map(Math.abs));
    const mean = errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length;
    // The frame on screen is the one whose interval contains "now", give or take one refresh.
    expect(Math.min(...errs), 'picture never lags the clock by more than ~2 frames').toBeGreaterThan(-2.3);
    // Frames are scheduled for the refresh at which they become visible (one refresh ahead of "now"),
    // so the picture may lead the instantaneous clock by up to a refresh plus half a frame.
    expect(Math.max(...errs), 'picture never runs ahead of the clock by more than its display lead').toBeLessThan(1.5);
    expect(mean, 'mean |frame error| in frames').toBeLessThan(1.3);

    // 1. pipeline bookkeeping
    const st = await stats(page);
    if (tier !== 'mse') {
      expect(st.pipeline.driftAvgMs, 'average |clock - pts| at presentation, ms').toBeLessThan(22);
      expect(st.pipeline.driftMaxMs, 'worst |clock - pts| at presentation, ms').toBeLessThan(60);
      const skips = await page.evaluate(() => ((window as any).__stopSkips = true) && (window as any).__skips);
      expect(st.pipeline.dropped, `dropped frames (display skipped ${skips} refreshes)`).toBeLessThanOrEqual(Math.ceil(skips / 2) + 1);
      expect(st.pipeline.delayed, `late frames (display skipped ${skips} refreshes)`).toBeLessThanOrEqual(Math.ceil(skips / 2) + 2);
      expect(st.audioEngine.underruns).toBe(0);
    } else {
      expect(Math.abs(st.pipeline.driftMs)).toBeLessThan(80);
    }
    test.info().annotations.push({
      type: 'sync',
      description: `frame error mean ${mean.toFixed(2)} / worst ${worst.toFixed(2)} frames; drift avg ${st.pipeline.driftAvgMs.toFixed(1)} ms, max ${st.pipeline.driftMaxMs.toFixed(1)} ms`,
    });
    expectNoErrors(errors);
  });
}

test('60 fps content: every display refresh gets a new frame, nothing is lost in the pipeline', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'h264_aac_60fps.mp4', { autoplay: true });
  await waitForTime(page, 1);
  // Headless browsers do not guarantee a steady 60 Hz compositor, so measure the refreshes that
  // really happened and hold the player to those.
  const m = await page.evaluate(async () => {
    const p = window.player;
    p.debug.resetDrift();
    const before = p.getStats().pipeline;
    const presented0 = before.presented;
    const t0 = p.currentTime;
    let refreshes = 0;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const loop = (now: number) => {
        refreshes++;
        if (now - start < 2500) requestAnimationFrame(loop);
        else resolve();
      };
      requestAnimationFrame(loop);
    });
    const st = p.getStats().pipeline;
    return {
      refreshes,
      presented: st.presented - presented0,
      dropped: st.dropped,
      delayed: st.delayed,
      media: p.currentTime - t0,
      driftAvg: st.driftAvgMs,
      driftMax: st.driftMaxMs,
      underruns: st.underruns,
    };
  });
  const mediaFrames = m.media * 60;
  // A new picture on (essentially) every refresh the display offered ...
  expect(m.presented / m.refreshes, `presented ${m.presented} of ${m.refreshes} refreshes`).toBeGreaterThan(0.93);
  // ... and every decoded frame is accounted for: shown, or skipped only because no refresh was available for it.
  expect(
    Math.abs(m.presented + m.dropped - mediaFrames),
    `presented ${m.presented} + dropped ${m.dropped} vs ${mediaFrames.toFixed(1)} media frames`,
  ).toBeLessThan(5);
  expect(m.driftAvg, 'average |clock - pts| at presentation, ms').toBeLessThan(14);
  expect(m.driftMax).toBeLessThan(45);
  expect(m.underruns).toBe(0);
  test.info().annotations.push({
    type: 'sync',
    description: `${m.presented} frames on ${m.refreshes} refreshes in 2.5 s, ${m.dropped} skipped, drift avg ${m.driftAvg.toFixed(1)} ms`,
  });
  expectNoErrors(errors);
});

for (const tier of ['webcodecs', 'wasm'] as const) {
  test(`${tier}: the beep is heard when the flash is seen (end-to-end)`, async ({ page }) => {
    const errors = await openApp(page, { tier });
    await load(page, 'h264_aac.mp4', { autoplay: true });
    await waitForTime(page, 0.4);
    const result = await page.evaluate(async () => {
      const p = window.player;
      const ctx: AudioContext = p.audio.ctx;
      const sr = ctx.sampleRate;
      const n = 2048;
      const wave = new Float32Array(n);
      const latencyMs = p.audio.latency * 1000;

      // Picture side: the instant each whole-second frame (the first one carrying the flash) was
      // handed to the renderer. Nothing else happens in this callback, so it cannot perturb timing.
      const flashes: Array<{ second: number; perf: number }> = [];
      let lastRaf = 0;
      let vsync = 16.7;
      const off = p.events.on('frame', ({ pts }: { pts: number }) => {
        const k = Math.round(pts);
        if (Math.abs(pts - k) > 0.004 || k < 1 || flashes.some((f) => f.second === k)) return;
        flashes.push({ second: k, perf: performance.now() });
      });
      let rafAlive = true;
      const raf = (t: number) => {
        if (lastRaf) vsync += (Math.min(40, t - lastRaf) - vsync) * 0.1;
        lastRaf = t;
        if (rafAlive) requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);

      // Sound side: poll the output bus every few milliseconds and locate the beep's first sample
      // inside the analyser window. That pins the onset to context time with ~1 ms resolution,
      // which is then converted to the instant it becomes audible.
      const beeps: Array<{ audiblePerf: number }> = [];
      let quietSince = performance.now();
      let imprecise = 0;
      const end = performance.now() + 5600;
      while (performance.now() < end) {
        await new Promise((r) => setTimeout(r, 4));
        const perfNow = performance.now();
        p.audio.getWaveform(wave);
        let idx = -1;
        for (let i = 0; i < n; i++) {
          if (Math.abs(wave[i]) > 0.3) {
            idx = i;
            break;
          }
        }
        if (idx < 0) {
          quietSince = quietSince || perfNow;
          continue;
        }
        if (quietSince && perfNow - quietSince > 300) {
          // idx 0 means the onset already scrolled out of the window (the poll was late): not usable.
          if (idx > 0) beeps.push({ audiblePerf: perfNow - ((n - idx) / sr) * 1000 + latencyMs });
          else imprecise++;
        }
        quietSince = 0;
      }
      off();
      rafAlive = false;
      return { beeps, flashes, latencyMs, vsync, imprecise };
    });
    expect(result.beeps.length, `precisely timed beeps (${result.imprecise} discarded)`).toBeGreaterThanOrEqual(3);
    expect(result.flashes.length, 'flash frames presented').toBeGreaterThanOrEqual(4);
    const deltas: number[] = [];
    for (const b of result.beeps) {
      const nearest = result.flashes.reduce((best, f) =>
        Math.abs(f.perf - b.audiblePerf) < Math.abs(best.perf - b.audiblePerf) ? f : best,
      );
      // the frame becomes visible one refresh after it was submitted
      deltas.push(nearest.perf + result.vsync - b.audiblePerf);
    }
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    for (const d of deltas) expect(Math.abs(d), 'flash on screen vs beep audible, ms').toBeLessThan(45);
    expect(Math.abs(mean), 'mean flash-vs-beep offset, ms').toBeLessThan(25);

    // The frames timed above really are the flashing ones: check the pixels of one of them.
    await seekPaused(page, 3);
    const flash = manifest.flash;
    const lit = await page.evaluate((r) => window.player.debug.samplePixels([r])[0], [
      flash.x + flash.w * 0.25,
      flash.y + flash.h * 0.25,
      flash.w * 0.5,
      flash.h * 0.5,
    ] as [number, number, number, number]);
    expect(Math.min(...lit), 'frame at 3.000 s shows the flash').toBeGreaterThan(200);
    await seekPaused(page, 3.5);
    const dark = await page.evaluate((r) => window.player.debug.samplePixels([r])[0], [
      flash.x + flash.w * 0.25,
      flash.y + flash.h * 0.25,
      flash.w * 0.5,
      flash.h * 0.5,
    ] as [number, number, number, number]);
    expect(Math.max(...dark), 'frame at 3.5 s does not').toBeLessThan(40);

    test.info().annotations.push({
      type: 'sync',
      description: `flash on screen - beep audible: mean ${mean.toFixed(1)} ms, worst ${Math.max(...deltas.map(Math.abs)).toFixed(1)} ms (n=${deltas.length}, output latency ${result.latencyMs.toFixed(0)} ms, refresh ${result.vsync.toFixed(1)} ms)`,
    });
    expectNoErrors(errors);
  });
}

for (const tier of ['webcodecs', 'wasm'] as const) {
  test(`${tier}: speed changes keep sync; WSOLA preserves pitch, plain resampling shifts it`, async ({ page }) => {
    const errors = await openApp(page, { tier });
    await load(page, 'h264_aac_long.mp4', { autoplay: true });
    await waitForTime(page, 1);
    const base = await dominantFrequency(page, 150, 700);
    expect(Math.abs(base - 220), `1x: 220 Hz tone measured at ${base.toFixed(1)}`).toBeLessThan(18);

    const advance = async (rate: number, wallMs: number) => {
      await page.evaluate((r) => window.player.command(`set speed ${r}`), rate);
      await page.waitForTimeout(350);
      return page.evaluate(async (ms) => {
        const a = window.player.currentTime;
        const t0 = performance.now();
        await new Promise((r) => setTimeout(r, ms));
        return (window.player.currentTime - a) / ((performance.now() - t0) / 1000);
      }, wallMs);
    };

    // 2x with pitch correction (WSOLA): clock runs at 2x, the tone is still 220 Hz.
    const r2 = await advance(2, 1500);
    expect(r2, 'effective rate at 2x').toBeGreaterThan(1.9);
    expect(r2).toBeLessThan(2.1);
    const f2 = await dominantFrequency(page, 150, 700);
    expect(Math.abs(f2 - 220), `2x pitch-corrected tone at ${f2.toFixed(1)} Hz`).toBeLessThan(25);
    const errs2 = await frameErrors(page, 30, 12, 80);
    expect(Math.min(...errs2), '2x: picture lag in frames').toBeGreaterThan(-3.6);
    // at 2x one display refresh spans a full media frame, so the scheduled-ahead picture may lead by ~2
    expect(Math.max(...errs2), '2x: picture lead in frames').toBeLessThan(2.6);

    // 2x without pitch correction: an octave up.
    await page.evaluate(() => window.player.command('set audio-pitch-correction no'));
    await page.waitForTimeout(300);
    const f2raw = await dominantFrequency(page, 150, 700);
    expect(Math.abs(f2raw - 440), `2x resampled tone at ${f2raw.toFixed(1)} Hz`).toBeLessThan(35);

    // 0.5x: with correction still 220 Hz, without an octave down.
    const rHalfRaw = await advance(0.5, 1500);
    expect(rHalfRaw).toBeGreaterThan(0.46);
    expect(rHalfRaw).toBeLessThan(0.54);
    const fHalfRaw = await dominantFrequency(page, 70, 700);
    expect(Math.abs(fHalfRaw - 110), `0.5x resampled tone at ${fHalfRaw.toFixed(1)} Hz`).toBeLessThan(22);
    await page.evaluate(() => window.player.command('set audio-pitch-correction yes'));
    await page.waitForTimeout(400);
    const fHalf = await dominantFrequency(page, 70, 700);
    expect(Math.abs(fHalf - 220), `0.5x pitch-corrected tone at ${fHalf.toFixed(1)} Hz`).toBeLessThan(25);

    // Back to 1x: still in sync, nothing underran.
    await advance(1, 300);
    const errs = await frameErrors(page, 30, 12, 80);
    // Same limits as the pixel-truth test above: up to ~2 frames of lag, and a lead of at most one
    // display refresh plus half a frame.
    expect(Math.min(...errs), '1x again: picture lag in frames').toBeGreaterThan(-2.3);
    expect(Math.max(...errs), '1x again: picture lead in frames').toBeLessThan(1.5);
    expect((await stats(page)).audioEngine.underruns).toBe(0);
    expectNoErrors(errors);
  });
}

test('mse: playback rate is honoured', async ({ page }) => {
  await openApp(page, { tier: 'mse' });
  await load(page, 'h264_aac_long.mp4', { autoplay: true });
  await waitForTime(page, 1);
  await page.evaluate(() => window.player.command('set speed 2'));
  await page.waitForTimeout(300);
  const rate = await page.evaluate(async () => {
    const a = window.player.currentTime;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 1500));
    return (window.player.currentTime - a) / ((performance.now() - t0) / 1000);
  });
  expect(rate).toBeGreaterThan(1.85);
  expect(rate).toBeLessThan(2.15);
});

test('5.1 surround is downmixed to stereo with every channel audible', async ({ page }) => {
  const errors = await openApp(page);
  await load(page, 'h264_ac3_51.mkv', { autoplay: true });
  await waitForTime(page, 1);
  const st = await stats(page);
  expect(st.mode).toBe('webcodecs+wasm-audio');
  expect(st.audio).toContain('6ch');
  expect(st.audio).toContain('downmix');
  // Each source channel carries its own tone: FL 220, FR 330, SL 550, SR 660 Hz (LFE 60 Hz is dropped).
  for (const [hz, name] of [
    [220, 'front left'],
    [330, 'front right'],
    [550, 'surround left'],
    [660, 'surround right'],
  ] as const) {
    const f = await dominantFrequency(page, hz - 45, hz + 45, 700);
    expect(Math.abs(f - hz), `${name} tone measured at ${f.toFixed(1)} Hz`).toBeLessThan(16);
  }
  expect(await audioLevel(page)).toBeGreaterThan(0.05);
  expectNoErrors(errors);
});

test('volume, mute and gain normalization act on the output bus', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'h264_aac_long.mp4', { autoplay: true });
  await waitForTime(page, 1);
  const full = await audioLevel(page, 1500);
  expect(full).toBeGreaterThan(0.25);

  await page.evaluate(() => window.player.command('set volume 50'));
  await page.waitForTimeout(250);
  const half = await audioLevel(page, 1500);
  // volume uses a squared taper: 50 % -> 0.25 gain
  expect(half / full).toBeGreaterThan(0.17);
  expect(half / full).toBeLessThan(0.34);

  await page.evaluate(() => window.player.command('set mute yes'));
  await page.waitForTimeout(250);
  expect(await audioLevel(page, 1200)).toBeLessThan(0.005);

  await page.evaluate(() => window.player.command('set mute no ; set volume 100 ; set audio-normalize yes'));
  await page.waitForTimeout(4500); // let the loudness estimate converge
  const normalized = await audioLevel(page, 1500);
  expect(normalized, 'never clips').toBeLessThan(1);
  expect(Math.abs(normalized / full - 1), 'normalizer changes the gain').toBeGreaterThan(0.08);
  expect((await state(page)).normalize).toBe(true);
  expectNoErrors(errors);
});

test('A-B loop repeats the selected range', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'h264_aac_long.mp4', { autoplay: true });
  await waitForTime(page, 0.5);
  const trace = await page.evaluate(async () => {
    const p = window.player;
    p.command('set ab-loop-a 2 ; set ab-loop-b 3');
    p.seek(2, true);
    const times: number[] = [];
    const end = performance.now() + 3800;
    while (performance.now() < end) {
      await new Promise((r) => setTimeout(r, 40));
      times.push(p.currentTime);
    }
    return times;
  });
  let wraps = 0;
  for (let i = 1; i < trace.length; i++) if (trace[i] < trace[i - 1] - 0.5) wraps++;
  expect(wraps, 'loop wrapped').toBeGreaterThanOrEqual(2);
  expect(Math.max(...trace)).toBeLessThan(3.25);
  expect(Math.min(...trace.slice(5))).toBeGreaterThan(1.85);
  expectNoErrors(errors);
});
