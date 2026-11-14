import { expect, test } from '@playwright/test';
import type { ColorInfo } from '../../src/core/types';
import {
  type ExternalPacking,
  hdrToRelativeLight,
  M_2020_TO_709,
  mul3,
  pqEotf,
  pqOetf,
  srgbEotf,
  srgbOetf,
  unpackExternal,
  type Vec3,
} from '../../src/render/color';
import { classifyExternal, ExternalHdrTracker, halfToFloat, PROBE_SIZE, PROBE_TILE, probeOrigins } from '../../src/render/external-hdr';

/**
 * Deciding how the browser handed over an HDR frame, without a browser: synthetic pictures are
 * pushed through each hand-over the renderers have met (and some they have not), together with a
 * stand-in for the browser's own SDR conversion, and the classifier has to tell them apart.
 */

const PQ: ColorInfo = { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020nc', fullRange: false };
const HLG: ColorInfo = { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020nc', fullRange: false };
const N = PROBE_SIZE * PROBE_SIZE;

function prng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A picture as linear BT.2020 light in nits: mostly mid-tones, some shadows and highlights, mild colour. */
function scene(seed: number, lo = 0.5, hi = 1500): Vec3[] {
  const rnd = prng(seed);
  const out: Vec3[] = [];
  for (let i = 0; i < N; i++) {
    const level = lo * Math.pow(hi / lo, rnd());
    out.push([level * (0.6 + 0.4 * rnd()), level * (0.6 + 0.4 * rnd()), level * (0.6 + 0.4 * rnd())]);
  }
  return out;
}

/**
 * Stand-in for the browser's HDR -> SDR conversion as the 2D canvas shows it: a constant gain up
 * to reference white, a roll-off above it, BT.709 primaries, sRGB encoding, 8 bits.
 */
function browserSdr(nits: Vec3[], gain = 0.5, peak = 1000): Uint8ClampedArray {
  const out = new Uint8ClampedArray(N * 4);
  nits.forEach((c, i) => {
    const x = Math.max(c[0], c[1], c[2]) / 203;
    const p = peak / 203;
    // straight line of slope `gain` below white, Hermite roll-off to 1 at the peak above it
    let y = gain * x;
    if (x > 1) {
      const t = Math.min(1, (x - 1) / (p - 1));
      y = gain + (1 - gain) * (1 - (1 - t) * (1 - t));
    }
    const k = x > 0 ? y / x : 0;
    const rgb = mul3(M_2020_TO_709, [(c[0] / 203) * k, (c[1] / 203) * k, (c[2] / 203) * k]);
    for (let j = 0; j < 3; j++) out[i * 4 + j] = Math.round(255 * srgbOetf(Math.min(1, Math.max(0, rgb[j]))));
    out[i * 4 + 3] = 255;
  });
  return out;
}

const pqCoded = (nits: Vec3[]): Vec3[] => nits.map((c) => [pqOetf(c[0]), pqOetf(c[1]), pqOetf(c[2])]);

/** What WebGPU's import returns for GPU-backed frames: sRGB-OETF(2020->709 x coded), float. */
function asCodedSrgb(coded: Vec3[]): Float32Array {
  const out = new Float32Array(N * 4);
  coded.forEach((c, i) => {
    const v = mul3(M_2020_TO_709, c);
    for (let j = 0; j < 3; j++) out[i * 4 + j] = srgbOetf(v[j]);
    out[i * 4 + 3] = 1;
  });
  return out;
}

/** What WebGL2's upload returns for them: the coded samples, 8 bits. */
function asCoded(coded: Vec3[]): Uint8Array {
  const out = new Uint8Array(N * 4);
  coded.forEach((c, i) => {
    for (let j = 0; j < 3; j++) out[i * 4 + j] = Math.round(255 * Math.min(1, Math.max(0, c[j])));
    out[i * 4 + 3] = 255;
  });
  return out;
}

test('colour helpers: PQ and sRGB round-trip, and unpacking inverts both known packings', () => {
  for (const nits of [0.01, 1, 100, 203, 1000, 10000]) expect(pqEotf(pqOetf(nits)) / nits).toBeCloseTo(1, 4);
  expect(pqOetf(203)).toBeCloseTo(0.5807, 3);
  for (const v of [-0.3, 0, 0.002, 0.5, 1, 1.4]) expect(srgbEotf(srgbOetf(v))).toBeCloseTo(v, 6);
  const coded: Vec3 = [0.479, 0.312, 0.262]; // a saturated red around 75 nits
  const packed = mul3(M_2020_TO_709, coded).map(srgbOetf) as Vec3;
  expect(Math.abs(packed[1] - coded[1]), 'packing really changes the samples').toBeGreaterThan(0.1);
  unpackExternal(packed, 'coded-srgb', PQ).forEach((v, i) => expect(v).toBeCloseTo(coded[i], 4));
  expect(unpackExternal(coded, 'coded', PQ)).toEqual(coded);
  // 203 nits of PQ is reference white.
  hdrToRelativeLight([pqOetf(203), pqOetf(203), pqOetf(203)], PQ).forEach((v) => expect(v).toBeCloseTo(1, 3));
  expect(halfToFloat(0x3c00)).toBe(1);
  expect(halfToFloat(0xc000)).toBe(-2);
  expect(halfToFloat(0x3555)).toBeCloseTo(1 / 3, 3);
});

test('probe tiles stay inside the picture and too small a picture is not probed', () => {
  expect(probeOrigins(48, 400)).toBeNull();
  for (const [w, h] of [
    [64, 64],
    [640, 360],
    [1921, 817],
    [3840, 2160],
  ]) {
    const o = probeOrigins(w, h)!;
    for (const x of o.x) expect(x >= 0 && x + PROBE_TILE <= w && Number.isInteger(x)).toBe(true);
    for (const y of o.y) expect(y >= 0 && y + PROBE_TILE <= h && Number.isInteger(y)).toBe(true);
    expect(new Set(o.x).size, 'tiles do not overlap').toBe(w >= 2 * PROBE_SIZE ? 4 : new Set(o.x).size);
  }
});

test('each known hand-over is recognised, whichever candidate is tried first', () => {
  for (const seed of [1, 2, 3]) {
    const nits = scene(seed);
    const sdr = browserSdr(nits);
    const coded = pqCoded(nits);
    for (const order of [
      ['coded-srgb', 'coded'],
      ['coded', 'coded-srgb'],
    ] as ExternalPacking[][]) {
      const gpu = classifyExternal(asCodedSrgb(coded), sdr, PQ, order);
      expect(gpu.packing, `WebGPU-style samples, candidates ${order}`).toBe('coded-srgb');
      expect(gpu.gain).toBeCloseTo(0.5, 1);
      expect(gpu.spread).toBeLessThan(0.1);
      const gl = classifyExternal(asCoded(coded), sdr, PQ, order);
      expect(gl.packing, `WebGL-style samples, candidates ${order}`).toBe('coded');
      expect(gl.gain).toBeCloseTo(0.5, 1);
    }
  }
});

test('the verdict does not depend on how much the browser dims the mid-tones, or on the mastering peak', () => {
  const nits = scene(7);
  const coded = pqCoded(nits);
  for (const gain of [0.3, 0.5, 0.75, 1]) {
    for (const peak of [600, 1000, 4000]) {
      const v = classifyExternal(asCodedSrgb(coded), browserSdr(nits, gain, peak), PQ);
      expect(v.packing, `gain ${gain}, peak ${peak}`).toBe('coded-srgb');
      expect(v.gain).toBeCloseTo(gain, 1);
    }
  }
});

test('an import that already is the browser conversion is left alone', () => {
  const nits = scene(11);
  const sdr = browserSdr(nits);
  // the same pixels, as a float texture would return them, with a little resampling noise
  const rnd = prng(5);
  const same = new Float32Array(N * 4);
  for (let i = 0; i < same.length; i++) same[i] = sdr[i] / 255 + (rnd() - 0.5) * 0.01;
  expect(classifyExternal(same, sdr, PQ).packing).toBe('converted');
  expect(classifyExternal(new Uint8Array(sdr), sdr, PQ).packing).toBe('converted');
});

test('a hand-over that fits nothing known is left to the browser, not guessed at', () => {
  const nits = scene(13);
  const sdr = browserSdr(nits);
  // proper SDR, but brighter than the canvas version and clipped at reference white
  const clipped = new Uint8Array(N * 4);
  nits.forEach((c, i) => {
    const rgb = mul3(M_2020_TO_709, [c[0] / 203, c[1] / 203, c[2] / 203]);
    for (let j = 0; j < 3; j++) clipped[i * 4 + j] = Math.round(255 * srgbOetf(Math.min(1, Math.max(0, rgb[j]))));
  });
  for (const order of [
    ['coded-srgb', 'coded'],
    ['coded', 'coded-srgb'],
  ] as ExternalPacking[][]) {
    const v = classifyExternal(clipped, sdr, PQ, order);
    expect(v.packing, `candidates ${order}`).toBe('converted');
    expect(v.gain).toBe(0);
  }
  // a stream tagged PQ whose samples are really HLG
  const hlgOetf = (x: number) => (x <= 1 / 12 ? Math.sqrt(3 * x) : 0.17883277 * Math.log(12 * x - 0.28466892) + 0.55991073);
  const mistagged = nits.map((c) => c.map((v) => hlgOetf(Math.min(1, v / 1000))) as Vec3);
  expect(classifyExternal(asCodedSrgb(mistagged), sdr, PQ).packing).toBe('converted');
  expect(classifyExternal(asCoded(mistagged), sdr, PQ, ['coded', 'coded-srgb']).packing).toBe('converted');
});

test('frames that cannot tell are inconclusive: black, blown out, or one flat level', () => {
  const dark = scene(17, 0.001, 0.05);
  expect(classifyExternal(asCodedSrgb(pqCoded(dark)), browserSdr(dark), PQ).packing).toBeNull();
  const bright = scene(19, 900, 4000);
  expect(classifyExternal(asCodedSrgb(pqCoded(bright)), browserSdr(bright), PQ).packing).toBeNull();
  const flat: Vec3[] = Array.from({ length: N }, () => [60, 60, 60] as Vec3);
  expect(classifyExternal(asCodedSrgb(pqCoded(flat)), browserSdr(flat), PQ).packing).toBeNull();
  expect(classifyExternal(asCoded(pqCoded(flat)), browserSdr(flat), PQ).packing).toBeNull();
});

test('HLG frames are recognised the same way', () => {
  // HLG signal for a scene; the browser version applies the reference OOTF, as the shaders do.
  const rnd = prng(23);
  const coded: Vec3[] = [];
  for (let i = 0; i < N; i++) {
    const base = 0.08 + 0.72 * rnd();
    coded.push([base * (0.75 + 0.25 * rnd()), base * (0.75 + 0.25 * rnd()), base * (0.75 + 0.25 * rnd())]);
  }
  const nits = coded.map((c) => hdrToRelativeLight(c, HLG).map((v) => v * 203) as Vec3);
  const sdr = browserSdr(nits);
  expect(classifyExternal(asCodedSrgb(coded), sdr, HLG).packing).toBe('coded-srgb');
  expect(classifyExternal(asCoded(coded), sdr, HLG, ['coded', 'coded-srgb']).packing).toBe('coded');
});

test('the tracker starts from nothing outside Chromium, adopts a verdict, and starts over for a new stream', () => {
  const frame = (w: number, pts: number) =>
    ({ kind: 'videoframe', pts, duration: 1 / 30, width: w, height: 360, frame: null, color: PQ, rotation: 0 }) as any;
  const sdrFrame = { ...frame(640, 0), color: { ...PQ, transfer: 'bt709', primaries: 'bt709' } };
  const t = new ExternalHdrTracker('webgpu');
  // No navigator in this process: no assumption about what an import does.
  expect(t.packingFor(frame(640, 0))).toBe('converted');
  expect(t.packingFor(sdrFrame), 'SDR is never ours to unpack').toBe('converted');
  expect(t.wantsProbe(sdrFrame, 1000)).toBe(false);
  expect(t.wantsProbe(frame(640, 0), 1000)).toBe(true);
  // An inconclusive probe keeps the packing; the same picture is not probed twice.
  expect(t.report(frame(640, 0), { packing: null, gain: 0, spread: 0, samples: 0 }, 1000)).toBe(false);
  expect(t.wantsProbe(frame(640, 0), 5000)).toBe(false);
  expect(t.wantsProbe(frame(640, 1), 1100), 'not again right away').toBe(false);
  expect(t.wantsProbe(frame(640, 1), 5000)).toBe(true);
  expect(t.report(frame(640, 1), { packing: 'coded-srgb', gain: 0.5, spread: 0.02, samples: 900 }, 5000)).toBe(true);
  expect(t.packingFor(frame(640, 2))).toBe('coded-srgb');
  expect(t.detail).toContain('checked');
  expect(t.wantsProbe(frame(640, 2), 9000), 'settled').toBe(false);
  // A probe that could not be made does not use up the picture: it is due again, on a timer.
  const u = new ExternalHdrTracker('webgl2');
  u.packingFor(frame(640, 7));
  expect(u.retryIn(frame(640, 7), 1000), 'never probed: due at once').toBe(0);
  u.miss(1000);
  expect(u.wantsProbe(frame(640, 7), 1100), 'not right away').toBe(false);
  expect(u.retryIn(frame(640, 7), 1100)).toBeGreaterThan(0);
  expect(u.wantsProbe(frame(640, 7), 2000), 'the same picture again').toBe(true);
  u.report(frame(640, 7), { packing: null, gain: 0, spread: 0, samples: 0 }, 2000);
  expect(u.retryIn(frame(640, 7), 6000), 'a picture that could not tell is not asked again').toBeNull();
  expect(u.retryIn(frame(640, 8), 2100), 'the next picture is, after the interval').toBeGreaterThan(0);
  expect(u.retryIn(sdrFrame, 6000)).toBeNull();
  u.giveUp();
  expect(u.retryIn(frame(640, 9), 9000)).toBeNull();
  expect(u.wantsProbe(frame(640, 9), 9000)).toBe(false);
  // The clock is performance.now(): a probe is due from the first millisecond of a page.
  const early = new ExternalHdrTracker('webgl2');
  expect(early.wantsProbe(frame(640, 0), 3)).toBe(true);
  expect(early.retryIn(frame(640, 0), 3)).toBe(0);
  // A new pipeline is a new stream even when its frames look the same from outside: the picture
  // at the same timestamp of another file with the same tags must be probed again.
  early.report(frame(640, 1), { packing: null, gain: 0, spread: 0, samples: 0 }, 400);
  expect(early.wantsProbe(frame(640, 1), 5000), 'same stream, same picture').toBe(false);
  const epoch = early.epoch;
  early.reset();
  expect(early.wantsProbe(frame(640, 1), 5000), 'after the pipeline went away').toBe(true);
  expect(early.epoch, 'a late read-back can tell it is stale').toBeGreaterThan(epoch);
  // Another stream: what was learned about the last one does not carry over.
  expect(t.packingFor(frame(1920, 0))).toBe('converted');
  expect(t.wantsProbe(frame(1920, 0), 9000)).toBe(true);
  // It gives up after a bounded number of inconclusive tries.
  for (let i = 0; i < 20; i++) {
    if (t.wantsProbe(frame(1920, i), 10000 + i * 1000))
      t.report(frame(1920, i), { packing: null, gain: 0, spread: 0, samples: 0 }, 10000 + i * 1000);
  }
  expect(t.wantsProbe(frame(1920, 99), 99999)).toBe(false);
});
