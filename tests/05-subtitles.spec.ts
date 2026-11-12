import { expect, test, type Page } from '@playwright/test';
import {
  expectColorNear,
  expectNoErrors,
  load,
  manifest,
  openApp,
  readFrame,
  screenshotColor,
  seekPaused,
  state,
  stats,
  waitForTime,
} from './helpers';

/**
 * Subtitles: libass (JASSUB) for ASS/SSA and converted SRT/WebVTT, our own decoder for PGS.
 * The key property is frame accuracy: an event that starts on frame N must be visible on frame N
 * and not on frame N-1, which we check by reading the frame counter burned into the picture and
 * the subtitle overlay at the same instant.
 */

type Box = (typeof manifest.sync.boxes)[number];
const boxes = manifest.sync.boxes;
const inner = (b: { x: number; y: number; w: number; h: number }): [number, number, number, number] => [
  b.x + b.w * 0.25,
  b.y + b.h * 0.25,
  b.w * 0.5,
  b.h * 0.5,
];
const FPS = 30;

interface Reading {
  frame: number;
  boxes: Array<{ coverage: number; rgb: [number, number, number] }> | null;
}

/** Frame number (from video pixels) and the state of every sync box (from the subtitle overlay), read in one tick. */
async function readBoth(page: Page): Promise<Reading> {
  const f = await readFrame(page);
  const b = await page.evaluate((rects) => window.player.debug.sampleSubtitles(rects), boxes.map(inner));
  return { frame: f.frame, boxes: b };
}

async function step(page: Page, dir: 1 | -1): Promise<void> {
  const before = await page.evaluate(() => window.player.debug.lastPresentedPts());
  await page.evaluate((d) => window.player.frameStep(d), dir);
  await page.waitForFunction(
    (b) => Math.abs(window.player.debug.lastPresentedPts() - b) > 0.001 && !window.player.store.state.seeking,
    before,
    { timeout: 15_000 },
  );
  await waitSubs(page);
}

/** Wait until the subtitle engine has gone quiet: every requested frame drawn, nothing new for a moment. */
async function waitSubs(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const subs = window.player.subs;
    await subs.settled();
    let last = -1;
    let stableSince = performance.now();
    const t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      const d = subs.debug;
      const key = d.renders * 100000 + d.completed;
      if (key !== last) {
        last = key;
        stableSince = performance.now();
      } else if (performance.now() - stableSince > 110 && (d.completed >= d.renders || d.engine.startsWith('pgs') || d.engine === 'none')) {
        break;
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
}

function expectedVisible(b: Box, frame: number): boolean {
  return frame >= Math.round(b.start * FPS) && frame < Math.round(b.end * FPS);
}

async function selectTrack(page: Page, label: string): Promise<void> {
  await page.evaluate(async (l) => {
    const t = window.player.store.state.subTracks.find((x: any) => x.label === l);
    if (!t) throw new Error(`no subtitle track "${l}"`);
    await window.player.selectSubtitle(t.id);
  }, label);
  await waitSubs(page);
}

test('Matroska: embedded tracks and font attachments are discovered and the default track is selected', async ({ page }) => {
  const errors = await openApp(page);
  await load(page, 'subs_embedded.mkv');
  await page.waitForFunction(() => window.player.store.state.subTracks.length === 5 && window.player.store.state.subTrack > 0);
  const s = await state(page);
  expect(s.subTracks.map((t: any) => `${t.label}:${t.codec}`)).toEqual([
    'Sync boxes:ass',
    'Embedded font:ass',
    'Torture:ass',
    'SRT:srt',
    'PGS:pgs',
  ]);
  expect(s.subTracks.find((t: any) => t.id === s.subTrack).label).toBe('Sync boxes');
  const st = await stats(page);
  expect(st.subtitles.engine).toContain('libass');
  expect(st.subtitles.fonts).toEqual(['DejaVuSansMono-Bold.ttf']);
  expectNoErrors(errors);
});

for (const [name, params, file, external] of [
  ['embedded ASS track in MKV (WebCodecs)', { tier: 'webcodecs' }, 'subs_embedded.mkv', null],
  ['embedded ASS track in MKV (MSE)', { tier: 'mse' }, 'subs_embedded.mkv', null],
  ['embedded ASS track in MKV (FFmpeg WASM)', { tier: 'wasm' }, 'subs_embedded.mkv', null],
  ['external .ass on MP4 (WebCodecs)', { tier: 'webcodecs' }, 'h264_aac.mp4', 'sync.ass'],
] as const) {
  test(`frame-accurate: ${name}`, async ({ page }) => {
    const errors = await openApp(page, params);
    await load(page, file);
    if (external) await page.evaluate((n) => window.player.addSubtitle({ name: n, url: `/media/${n}` }), external);
    else await page.waitForFunction(() => window.player.store.state.subTrack > 0);

    // Walk frame by frame across every start/end boundary of the red and green boxes.
    const checked: Array<{ frame: number; red: boolean; green: boolean }> = [];
    for (const around of [1.0, 2.0, 3.0]) {
      await seekPaused(page, around - 0.1);
      await waitSubs(page);
      for (let i = 0; i < 7; i++) {
        const r = await readBoth(page);
        expect(r.boxes, 'subtitle overlay exists').not.toBeNull();
        const red = r.boxes![0].coverage > 0.9;
        const green = r.boxes![1].coverage > 0.9;
        expect(red, `frame ${r.frame}: red box (frames 30-59)`).toBe(expectedVisible(boxes[0], r.frame));
        expect(green, `frame ${r.frame}: green box (frames 60-89)`).toBe(expectedVisible(boxes[1], r.frame));
        if (red) expectColorNear(r.boxes![0].rgb, boxes[0].rgb, 12, 'red box');
        if (green) expectColorNear(r.boxes![1].rgb, boxes[1].rgb, 12, 'green box');
        checked.push({ frame: r.frame, red, green });
        await step(page, 1);
      }
    }
    // The walk really crossed each boundary in both states.
    const frames = checked.map((c) => c.frame);
    for (const boundary of [30, 60, 90]) {
      expect(frames, `visited frame ${boundary - 1}`).toContain(boundary - 1);
      expect(frames, `visited frame ${boundary}`).toContain(boundary);
    }
    // And backwards: stepping back over the start of the red box hides it again.
    await seekPaused(page, 1.0 + 1.5 / FPS);
    await waitSubs(page);
    const seen: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await readBoth(page);
      expect(r.boxes![0].coverage > 0.9, `back-step, frame ${r.frame}`).toBe(expectedVisible(boxes[0], r.frame));
      seen.push(r.boxes![0].coverage > 0.9);
      await step(page, -1);
    }
    expect(seen).toContain(true);
    expect(seen).toContain(false);
    expectNoErrors(errors);
  });
}

test('during playback the overlay tracks the picture (never more than 2 frames apart)', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'subs_embedded.mkv', { autoplay: true });
  await page.waitForFunction(() => window.player.store.state.subTrack > 0);
  let compared = 0;
  let transitionsSeen = 0;
  const lastState: Record<string, boolean> = {};
  while ((await page.evaluate(() => window.player.currentTime)) < 6.4) {
    const r = await readBoth(page);
    if (!r.boxes) continue;
    boxes.forEach((b, i) => {
      const visible = r.boxes![i].coverage > 0.9;
      const edges = [Math.round(b.start * FPS), Math.round(b.end * FPS)];
      const nearEdge = edges.some((e) => Math.abs(r.frame - e) <= 2);
      if (!nearEdge) {
        expect(visible, `${b.name} box at frame ${r.frame}`).toBe(expectedVisible(b, r.frame));
        compared++;
      }
      if (lastState[b.name] !== undefined && lastState[b.name] !== visible) transitionsSeen++;
      lastState[b.name] = visible;
    });
    await page.waitForTimeout(45);
  }
  expect(compared).toBeGreaterThan(120);
  expect(transitionsSeen, 'boxes appeared and disappeared while playing').toBeGreaterThanOrEqual(6);
  expectNoErrors(errors);
});

test('the composited page shows subtitles over the video (real screenshot)', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'subs_embedded.mkv');
  await page.waitForFunction(() => window.player.store.state.subTrack > 0);
  await page.evaluate(() => ((document.querySelector('.lp-chrome') as HTMLElement).style.display = 'none'));
  await seekPaused(page, 1.5);
  await waitSubs(page);
  let [red, green] = await screenshotColor(page, '.lp-stage', [inner(boxes[0]), inner(boxes[1])]);
  expectColorNear(red, boxes[0].rgb, 14, 'red box in screenshot at 1.5 s');
  expect(green[1] < 250 || green[0] > 20, 'green box absent at 1.5 s').toBe(true);
  await seekPaused(page, 2.5);
  await waitSubs(page);
  [red, green] = await screenshotColor(page, '.lp-stage', [inner(boxes[0]), inner(boxes[1])]);
  expectColorNear(green, boxes[1].rgb, 14, 'green box in screenshot at 2.5 s');
  expectNoErrors(errors);
});

test('fonts attached to the MKV are used by libass (and user-supplied fonts work too)', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });

  // Control: same script, no attachment -> libass falls back to its default proportional face.
  await load(page, 'subs_nofont.mkv');
  await page.waitForFunction(() => window.player.store.state.subTrack > 0);
  await seekPaused(page, 1);
  await waitSubs(page);
  const fallback = await page.evaluate(() => window.player.debug.subtitleBounds());
  expect(fallback, 'fallback rendering exists').not.toBeNull();
  expect((await stats(page)).subtitles.fonts).toEqual([]);

  // Supplying the font by hand re-renders the line in the monospace face.
  await page.evaluate(async (file) => {
    const data = new Uint8Array(await (await fetch(`/media/${file}`)).arrayBuffer());
    window.player.subs.addFont(file, data);
    await window.player.subs.settled();
    await window.player.selectSubtitle(window.player.store.state.subTrack); // reload the track so glyphs are re-shaped
  }, manifest.font.file);
  await waitSubs(page);
  const supplied = await page.evaluate(() => window.player.debug.subtitleBounds());

  // With the attachment, the font comes out of the container.
  await load(page, 'subs_embedded.mkv');
  await page.waitForFunction(() => window.player.store.state.subTracks.length === 5);
  await selectTrack(page, 'Embedded font');
  await seekPaused(page, 1);
  await waitSubs(page);
  const embedded = await page.evaluate(() => window.player.debug.subtitleBounds());
  expect(embedded, 'embedded-font rendering exists').not.toBeNull();
  expect((await stats(page)).subtitles.fonts).toEqual([manifest.font.file]);

  // Twenty "i" glyphs: ~0.6 em each in DejaVu Sans Mono Bold, ~0.22 em in a proportional sans.
  expect(embedded!.w / fallback!.w, `embedded ${embedded!.w.toFixed(3)} vs fallback ${fallback!.w.toFixed(3)}`).toBeGreaterThan(1.8);
  expect(embedded!.w).toBeGreaterThan(0.45);
  expect(embedded!.w).toBeLessThan(0.68);
  expect(Math.abs(supplied!.w - embedded!.w), 'user-supplied font gives the same metrics').toBeLessThan(0.03);
  expectNoErrors(errors);
});

test('torture script: libass keeps up with the display, video does not suffer', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'h264_aac_long.mp4');
  await page.evaluate(() => window.player.addSubtitle({ name: 'torture.ass', url: '/media/torture.ass' }));
  await page.evaluate(() => window.player.play());
  await waitForTime(page, 1.2);
  const m = await page.evaluate(async () => {
    const p = window.player;
    p.debug.resetDrift();
    const d0 = p.subs.debug;
    const presented0: number = p.getStats().pipeline.presented; // (the stats object is live, so copy the number)
    let refreshes = 0;
    let coverage = 0;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const loop = (now: number) => {
        refreshes++;
        if (refreshes % 20 === 0) coverage = Math.max(coverage, p.debug.subtitleBounds()?.coverage ?? 0);
        if (now - start < 4000) requestAnimationFrame(loop);
        else resolve();
      };
      requestAnimationFrame(loop);
    });
    const d1 = p.subs.debug;
    const v1 = p.getStats().pipeline;
    return {
      refreshes,
      requested: d1.renders - d0.renders,
      completed: d1.completed - d0.completed,
      busy: d1.busySkips - d0.busySkips,
      videoPresented: v1.presented - presented0,
      videoDropped: v1.dropped,
      driftAvg: v1.driftAvgMs,
      coverage,
      events: d1.events,
    };
  });
  // A subtitle frame is rendered for (nearly) every display refresh, i.e. animation runs at display rate ...
  expect(m.completed / m.refreshes, `libass drew ${m.completed} frames over ${m.refreshes} refreshes`).toBeGreaterThan(0.9);
  // ... the renderer was almost never still busy with the previous frame when the next was due ...
  expect(m.busy / m.requested, `${m.busy} of ${m.requested} requests found libass busy`).toBeLessThan(0.05);
  // ... the script is really on screen ...
  expect(m.coverage, 'share of the overlay covered by typesetting').toBeGreaterThan(0.03);
  // ... and video timing is unaffected.
  expect(m.videoPresented).toBeGreaterThan(105);
  expect(m.driftAvg).toBeLessThan(22);
  test.info().annotations.push({
    type: 'subs',
    description: `${m.completed} libass frames / ${m.refreshes} refreshes in 4 s, ${m.busy} busy, coverage ${(m.coverage * 100).toFixed(1)}%`,
  });
  expectNoErrors(errors);
});

test('SRT and WebVTT are converted and positioned (bottom by default, top via tags/settings)', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'h264_aac.mp4');
  const bounds = () => page.evaluate(() => window.player.debug.subtitleBounds());
  const at = async (t: number) => {
    await seekPaused(page, t);
    await waitSubs(page);
    return bounds();
  };

  await page.evaluate(() => window.player.addSubtitle({ name: 'subs.srt', url: '/media/subs.srt' }));
  let b = await at(1.5);
  expect(b, 'SRT cue 1 visible').not.toBeNull();
  expect(b!.y, 'bottom aligned').toBeGreaterThan(0.6);
  const oneLine = b!.h;
  expect(await at(2.75), 'between cues: nothing').toBeNull();
  b = await at(3.5);
  expect(b!.h / oneLine, 'two-line cue is about twice as tall as a one-line cue').toBeGreaterThan(1.6);
  b = await at(5.5);
  expect(b!.y + b!.h, '{\\an8} cue is at the top').toBeLessThan(0.3);

  await page.evaluate(() => window.player.addSubtitle({ name: 'subs.vtt', url: '/media/subs.vtt' }));
  b = await at(1.5);
  expect(b, 'VTT cue visible').not.toBeNull();
  expect(b!.y).toBeGreaterThan(0.6);
  b = await at(3.5);
  expect(b!.y + b!.h, 'line:0 cue is at the top').toBeLessThan(0.3);
  b = await at(5.5);
  expect(b!.x, 'align:start cue hugs the left edge').toBeLessThan(0.15);
  expect(await at(7.2)).toBeNull();
  const s = await state(page);
  expect(s.subTracks.map((t: any) => t.codec)).toEqual(['srt', 'vtt']);
  expectNoErrors(errors);
});

for (const [name, setup] of [
  [
    'external .sup file',
    async (page: Page) => {
      await load(page, 'h264_aac.mp4');
      await page.evaluate(() => window.player.addSubtitle({ name: 'subs.sup', url: '/media/subs.sup' }));
    },
  ],
  [
    'embedded S_HDMV/PGS track',
    async (page: Page) => {
      await load(page, 'subs_embedded.mkv');
      await page.waitForFunction(() => window.player.store.state.subTracks.length === 5);
      await selectTrack(page, 'PGS');
    },
  ],
] as const) {
  test(`PGS bitmap subtitles: ${name}`, async ({ page }) => {
    const errors = await openApp(page, { tier: 'webcodecs' });
    await setup(page);
    expect((await stats(page)).subtitles.engine).toContain('pgs');
    const sample = () => page.evaluate((rects) => window.player.debug.sampleSubtitles(rects), manifest.pgs.map(inner));
    const [yellow, cyan] = manifest.pgs;
    await seekPaused(page, 2);
    await waitSubs(page);
    let r = await sample();
    expect(r![0].coverage, 'yellow bitmap visible at 2 s').toBeGreaterThan(0.95);
    expectColorNear(r![0].rgb, yellow.rgb, 10, 'yellow bitmap');
    expect(r![1].coverage, 'cyan bitmap not yet visible').toBe(0);
    await seekPaused(page, 3.5);
    await waitSubs(page);
    r = await sample();
    expect(r![0].coverage, 'cleared at 3.5 s').toBe(0);
    await seekPaused(page, 5);
    await waitSubs(page);
    r = await sample();
    expect(r![1].coverage, 'cyan bitmap visible at 5 s').toBeGreaterThan(0.95);
    expectColorNear(r![1].rgb, cyan.rgb, 10, 'cyan bitmap');
    // Bitmap position: the box edges are where the stream says they are.
    const b = await page.evaluate(() => window.player.debug.subtitleBounds());
    expect(Math.abs(b!.x - cyan.x)).toBeLessThan(0.01);
    expect(Math.abs(b!.y - cyan.y)).toBeLessThan(0.01);
    expect(Math.abs(b!.w - cyan.w)).toBeLessThan(0.01);
    await seekPaused(page, 6.5);
    await waitSubs(page);
    expect((await sample())![1].coverage).toBe(0);
    expectNoErrors(errors);
  });
}

test('sub-delay shifts events, sub-visibility hides them, tracks can be switched off', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'h264_aac.mp4');
  await page.evaluate(() => window.player.addSubtitle({ name: 'sync.ass', url: '/media/sync.ass' }));
  const red = async () => (await page.evaluate((r) => window.player.debug.sampleSubtitles([r]), inner(boxes[0])))?.[0].coverage ?? 0;

  await seekPaused(page, 1.2);
  await waitSubs(page);
  expect(await red()).toBeGreaterThan(0.9);

  // +0.5 s: the 1.0-2.0 s box now lives at 1.5-2.5 s.
  await page.evaluate(() => window.player.command('set sub-delay 0.5'));
  await waitSubs(page);
  expect(await red(), 'delayed: not yet at 1.2 s').toBe(0);
  await seekPaused(page, 2.2);
  await waitSubs(page);
  expect(await red(), 'delayed: still visible at 2.2 s').toBeGreaterThan(0.9);

  // z / x keys nudge by 100 ms each.
  await page.locator('.lp-root').focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('z');
  expect((await state(page)).subDelay).toBeCloseTo(0, 5);
  await waitSubs(page);
  expect(await red(), 'delay removed: gone at 2.2 s').toBe(0);
  await page.keyboard.press('x');
  expect((await state(page)).subDelay).toBeCloseTo(0.1, 5);
  await page.keyboard.press('z');

  await seekPaused(page, 1.2);
  await waitSubs(page);
  expect(await red()).toBeGreaterThan(0.9);
  await page.keyboard.press('v');
  expect((await state(page)).subVisible).toBe(false);
  expect(await page.evaluate(() => window.player.debug.subtitleBounds()), 'hidden').toBeNull();
  await page.keyboard.press('v');
  await waitSubs(page);
  expect(await red()).toBeGreaterThan(0.9);
  await page.evaluate(() => window.player.command('set sid no'));
  await page.waitForTimeout(100);
  expect((await state(page)).subTrack).toBe(-1);
  expect(await page.evaluate(() => window.player.debug.subtitleBounds())).toBeNull();
  expectNoErrors(errors);
});
