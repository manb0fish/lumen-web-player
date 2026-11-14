import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

declare global {
  interface Window {
    player: any;
    ui: any;
    Lumen: any;
    ready: boolean;
  }
}

export interface MediaFile {
  file: string;
  container: string;
  video: string | null;
  audio: string | null;
  bitDepth?: number;
  fps?: number;
  duration: number;
  colors?: boolean;
  hdr?: string;
  long?: boolean;
  /** 1080p benchmark clip: not part of the playback matrix. */
  perf?: boolean;
  subtitles?: string[];
  channels?: number;
  matrix?: string;
}

export const manifest: {
  counter: { bits: number; cell: number; height: number; width: number; videoHeight: number };
  flash: { x: number; y: number; w: number; h: number; period: number; on: number };
  colorPatches: Record<'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight', [number, number, number]>;
  hdrSteps: Record<'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight', number>;
  sync: {
    boxes: Array<{ name: string; start: number; end: number; x: number; y: number; w: number; h: number; rgb: [number, number, number] }>;
  };
  font: { family: string; file: string; line: { x: number; y: number; height: number } };
  pgs: Array<{ name: string; start: number; end: number; x: number; y: number; w: number; h: number; rgb: [number, number, number] }>;
  files: MediaFile[];
  extras: string[];
} = JSON.parse(readFileSync('public/media/manifest.json', 'utf8'));

/** Console errors and uncaught exceptions seen on a page. Benign network noise is not collected. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

type Params = Record<string, string | number | boolean | undefined>;

function query(params: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === false) continue;
    q.set(k, v === true ? '1' : String(v));
  }
  return q.toString();
}

/** Open the full demo app (player + UI), sidebar hidden, without touching localStorage. */
export async function openApp(page: Page, params: Params = {}): Promise<string[]> {
  const errors = trackErrors(page);
  await page.goto(`/?${query({ persist: 0, sidebar: 0, ...params })}`);
  await page.waitForFunction(() => !!window.player && !!window.ui);
  return errors;
}

/** Open the bare harness (headless player, no UI). */
export async function openHarness(page: Page, params: Params = {}): Promise<string[]> {
  const errors = trackErrors(page);
  await page.goto(`/harness.html?${query(params)}`);
  await page.waitForFunction(() => window.ready === true);
  return errors;
}

export async function load(page: Page, file: string, opts: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(([f, o]) => window.player.load(`/media/${f}`, o), [file, opts] as const);
}

export async function waitForTime(page: Page, t: number, timeout = 25_000): Promise<void> {
  await page.waitForFunction((x) => window.player.currentTime >= x, t, { timeout });
}

export async function waitForStatus(page: Page, status: string | string[], timeout = 25_000): Promise<void> {
  const list = Array.isArray(status) ? status : [status];
  await page.waitForFunction((l) => l.includes(window.player.store.state.status), list, { timeout });
}

/** Wait until the frame pipeline has shown a frame for the current position and nothing is pending. */
export async function settle(page: Page, ms = 220): Promise<void> {
  await page.waitForFunction(() => {
    const s = window.player.store.state;
    return !s.seeking && s.status !== 'loading' && window.player.debug.lastPresentedPts() >= 0;
  });
  await page.waitForTimeout(ms);
}

export async function seekPaused(page: Page, t: number): Promise<void> {
  await page.evaluate((x) => {
    window.player.pause();
    window.player.seek(x, true);
  }, t);
  await page.waitForFunction(
    (x) => {
      const p = window.player;
      const pts = p.debug.lastPresentedPts();
      return !p.store.state.seeking && Math.abs(pts - x) < 0.12;
    },
    t,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(160);
}

export interface FrameReading {
  /** Frame number decoded from the binary strip burned into the picture. */
  frame: number;
  /** Player clock at the instant of the reading. */
  time: number;
  /** PTS of the frame the pipeline says is on screen. */
  pts: number;
  /** White/black sentinel contrast; < 80 means the strip could not be read. */
  contrast: number;
}

/** Read the burned-in frame counter back from the pixels the renderer actually produced. */
export async function readFrame(page: Page): Promise<FrameReading> {
  return page.evaluate((c) => {
    const p = window.player;
    const rect = (x0: number): [number, number, number, number] => [
      (x0 + 12) / c.width,
      12 / c.videoHeight,
      16 / c.width,
      16 / c.videoHeight,
    ];
    const rects: Array<[number, number, number, number]> = [];
    for (let k = 0; k < c.bits; k++) rects.push(rect(k * c.cell));
    rects.push(rect(c.bits * c.cell)); // white sentinel
    rects.push(rect(c.bits * c.cell + 80)); // black sentinel
    const time = p.currentTime;
    const px = p.debug.samplePixels(rects) as Array<[number, number, number]> | null;
    const pts = p.debug.lastPresentedPts();
    if (!px) return { frame: -1, time, pts, contrast: 0 };
    const luma = px.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
    const white = luma[c.bits];
    const black = luma[c.bits + 1];
    const thr = (white + black) / 2;
    let frame = 0;
    for (let k = 0; k < c.bits; k++) if (luma[k] > thr) frame |= 1 << k;
    return { frame, time, pts, contrast: white - black };
  }, manifest.counter);
}

export async function stats(page: Page): Promise<any> {
  return page.evaluate(() => window.player.getStats());
}

export async function state(page: Page): Promise<any> {
  return page.evaluate(() => {
    const { mediaInfo, ...rest } = window.player.store.state;
    return rest;
  });
}

/** Peak output RMS over a short window (audio is bursty: a 100 ms beep every second over a quiet tone). */
export async function audioLevel(page: Page, ms = 1300): Promise<number> {
  return page.evaluate(async (dur) => {
    let max = 0;
    const end = performance.now() + dur;
    while (performance.now() < end) {
      max = Math.max(max, window.player.audio.getLevel().rms);
      await new Promise((r) => setTimeout(r, 30));
    }
    return max;
  }, ms);
}

/** Frequency (Hz) of the strongest spectral peak inside [lo, hi]. */
export async function dominantFrequency(page: Page, lo: number, hi: number, ms = 900): Promise<number> {
  return page.evaluate(
    async ([lo, hi, dur]) => {
      const a = window.player.audio;
      const n = a.fftBins;
      const acc = new Float64Array(n);
      const buf = new Uint8Array(n);
      const end = performance.now() + dur;
      while (performance.now() < end) {
        a.getSpectrum(buf);
        for (let i = 0; i < n; i++) acc[i] += buf[i];
        await new Promise((r) => setTimeout(r, 40));
      }
      const hzPerBin = a.sampleRate / (2 * n);
      let best = 0;
      let bestV = -1;
      for (let i = Math.floor(lo / hzPerBin); i <= Math.ceil(hi / hzPerBin) && i < n; i++) {
        if (acc[i] > bestV) {
          bestV = acc[i];
          best = i;
        }
      }
      // parabolic interpolation around the peak bin
      const y0 = acc[best - 1] ?? 0;
      const y1 = acc[best];
      const y2 = acc[best + 1] ?? 0;
      const d = y0 - 2 * y1 + y2;
      const off = d ? (0.5 * (y0 - y2)) / d : 0;
      return (best + off) * hzPerBin;
    },
    [lo, hi, ms] as const,
  );
}

export function expectNoErrors(errors: string[]): void {
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
}

export function expectColorNear(actual: number[], expected: number[], tolerance: number, label = ''): void {
  const diff = Math.max(...actual.map((v, i) => Math.abs(v - expected[i])));
  expect(diff, `${label} rgb(${actual.map((v) => v.toFixed(0))}) vs expected rgb(${expected})`).toBeLessThanOrEqual(tolerance);
}

/** Average colour of a normalised rectangle of an element, taken from a real browser screenshot. */
export async function screenshotColor(page: Page, selector: string, rects: Array<[number, number, number, number]>): Promise<number[][]> {
  const png = PNG.sync.read(await page.locator(selector).first().screenshot());
  return rects.map(([x, y, w, h]) => {
    const x0 = Math.round(x * png.width);
    const y0 = Math.round(y * png.height);
    const x1 = Math.min(png.width, Math.max(x0 + 1, Math.round((x + w) * png.width)));
    const y1 = Math.min(png.height, Math.max(y0 + 1, Math.round((y + h) * png.height)));
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = (py * png.width + px) * 4;
        r += png.data[i];
        g += png.data[i + 1];
        b += png.data[i + 2];
        n++;
      }
    }
    return [r / n, g / n, b / n];
  });
}

/** Centres of the four colour quadrants, as small sampling rectangles. */
export const PATCH_RECTS: Record<keyof typeof manifest.colorPatches, [number, number, number, number]> = {
  topLeft: [0.15, 0.15, 0.2, 0.2],
  topRight: [0.65, 0.15, 0.2, 0.2],
  bottomLeft: [0.15, 0.65, 0.2, 0.2],
  bottomRight: [0.65, 0.65, 0.2, 0.2],
};

export async function destroyPlayer(
  page: Page,
): Promise<{ frames: { opened: number; closed: number }; textures: { created: number; destroyed: number }; audioState: string }> {
  return page.evaluate(async () => {
    const p = window.player;
    const frames = p.debug.frameLedger;
    const textures = p.debug.textureLedger;
    window.ui?.destroy?.();
    await p.destroy();
    // decoders close their frames asynchronously in the worker; give the ledger a beat to settle
    await new Promise((r) => setTimeout(r, 400));
    return { frames: { ...frames }, textures: { ...textures }, audioState: p.audio.state };
  });
}
