import { expect, test } from '@playwright/test';
import { dominantFrequency, feed, loadWorklet, makePlayer, rms, sine } from './worklet-harness.mjs';

/**
 * The real AudioWorklet module, executed in Node against synthetic signals. No browser involved:
 * these pin down the DSP and clock arithmetic exactly (bit-exact passthrough, pitch to within a
 * fraction of a hertz, media-time accounting to the sample).
 */

const SR = 48000;

function start(p: any, opts: { channels?: number; rate?: number; pitch?: boolean; time?: number } = {}) {
  p.control({ type: 'config', hasAudio: true, channels: opts.channels ?? 1 });
  p.control({ type: 'seek', time: opts.time ?? 0, gen: 1 });
  if (opts.rate !== undefined) p.control({ type: 'rate', rate: opts.rate });
  if (opts.pitch !== undefined) p.control({ type: 'pitch', on: opts.pitch });
  p.control({ type: 'play', playing: true });
}

const lastClock = (p: any) => p.proc.port.messages.filter((m: any) => m.type === 'clock').at(-1);

test('1x playback is a bit-exact passthrough and the clock counts samples', () => {
  const p = makePlayer();
  start(p);
  const src = sine(440, 1, SR, 0.5);
  feed(p, [src]);
  const out = p.render(SR / 2);
  for (let i = 0; i < 24000 - 128; i += 997) expect(out[0][i]).toBe(src[i]);
  expect(out[1][1000], 'mono is copied to both output channels').toBe(src[1000]);
  const c = lastClock(p);
  expect(c.mediaTime).toBeCloseTo(c.framesOut / SR, 9);
  expect(c.underruns).toBe(0);
});

for (const rate of [0.5, 0.75, 1.25, 1.5, 2, 3]) {
  test(`WSOLA at ${rate}x keeps a 220 Hz tone at 220 Hz with full amplitude`, () => {
    const p = makePlayer();
    start(p, { rate });
    feed(p, [sine(220, 1.2 * rate + 1, SR, 0.5)]);
    const out = p.render(SR);
    const tail = out[0].subarray(SR * 0.25, SR * 0.95);
    const f = dominantFrequency(tail, SR, 100, 500);
    expect(Math.abs(f.frequency - 220), `measured ${f.frequency} Hz`).toBeLessThanOrEqual(0.5);
    expect(f.magnitude).toBeGreaterThan(0.47);
    expect(rms(tail)).toBeCloseTo(0.5 / Math.SQRT2, 1);
    // media time advances `rate` seconds per output second
    const c = lastClock(p);
    expect(c.mediaTime / (c.framesOut / SR)).toBeCloseTo(rate, 1);
    expect(p.proc.mode).toBe('stretch');
    expect(c.underruns).toBe(0);
  });
}

test('WSOLA keeps two simultaneous tones and a transient intact', () => {
  const p = makePlayer();
  start(p, { rate: 1.5 });
  const n = SR * 3;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = 0.3 * Math.sin((2 * Math.PI * 330 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 1320 * i) / SR);
  feed(p, [src]);
  const out = p.render(SR);
  const tail = out[0].subarray(SR * 0.3, SR * 0.9);
  expect(Math.abs(dominantFrequency(tail, SR, 250, 420).frequency - 330)).toBeLessThanOrEqual(1);
  expect(Math.abs(dominantFrequency(tail, SR, 1200, 1450).frequency - 1320)).toBeLessThanOrEqual(2);
  expect(Math.max(...tail.map(Math.abs)), 'no clipping from overlap-add').toBeLessThan(0.75);
});

test('with pitch correction off, speed shifts pitch like a tape (2x -> octave up, 0.5x -> octave down)', () => {
  for (const [rate, expected] of [
    [2, 440],
    [0.5, 110],
  ] as const) {
    const p = makePlayer();
    start(p, { rate, pitch: false });
    feed(p, [sine(220, 3, SR, 0.5)]);
    const out = p.render(SR);
    const f = dominantFrequency(out[0].subarray(4800, 43200), SR, 60, 700);
    expect(Math.abs(f.frequency - expected), `${rate}x measured ${f.frequency} Hz`).toBeLessThanOrEqual(1);
    expect(p.proc.mode).toBe('resample');
    expect(lastClock(p).mediaTime / (lastClock(p).framesOut / SR)).toBeCloseTo(rate, 2);
  }
});

test('5.1 is folded down ITU-style: centre and surrounds in both/each side, LFE dropped, no clipping', () => {
  const p = makePlayer();
  start(p, { channels: 6 });
  // SMPTE order: FL FR C LFE SL SR, one distinct tone each at full scale
  const tones = [220, 330, 440, 60, 550, 660];
  feed(
    p,
    tones.map((f) => sine(f, 1, SR, 1.0)),
  );
  const out = p.render(SR / 2);
  const L = out[0].subarray(2400, 21600);
  const R = out[1].subarray(2400, 21600);
  const mag = (sig: Float32Array, f: number) => dominantFrequency(sig, SR, f - 3, f + 3).magnitude;
  const norm = 1 / (1 + Math.SQRT1_2 + Math.SQRT1_2);
  expect(mag(L, 220)).toBeCloseTo(norm, 2); // FL -> L
  expect(mag(R, 330)).toBeCloseTo(norm, 2); // FR -> R
  expect(mag(L, 440)).toBeCloseTo(norm * Math.SQRT1_2, 2); // C -> both at -3 dB
  expect(mag(R, 440)).toBeCloseTo(norm * Math.SQRT1_2, 2);
  expect(mag(L, 550)).toBeCloseTo(norm * Math.SQRT1_2, 2); // SL -> L
  expect(mag(R, 660)).toBeCloseTo(norm * Math.SQRT1_2, 2); // SR -> R
  expect(mag(R, 220), 'FL does not leak right').toBeLessThan(0.01);
  expect(mag(L, 660), 'SR does not leak left').toBeLessThan(0.01);
  expect(mag(L, 60), 'LFE is dropped').toBeLessThan(0.01);
  expect(Math.max(...L.map(Math.abs)), 'full-scale input on every channel cannot clip').toBeLessThanOrEqual(1.0001);
});

test('a seek trims audio to the exact sample of the target', () => {
  const p = makePlayer();
  start(p, { time: 0.5 });
  // ramp whose value encodes its own sample index, delivered in chunks that straddle the target
  const n = SR;
  const ramp = new Float32Array(n);
  for (let i = 0; i < n; i++) ramp[i] = i / n;
  feed(p, [ramp], { chunk: 1000 });
  const out = p.render(1280);
  expect(out[0][0]).toBeCloseTo(0.5, 6); // first audible sample is sample 24000
  expect(out[0][1]).toBeCloseTo(0.5 + 1 / n, 6);
  expect(p.proc.mediaTime, 'clock = target + frames played').toBeCloseTo(0.5 + 1280 / SR, 6);
});

test('a hole in the stream becomes silence of exactly the right length; an overlap is skipped', () => {
  const p = makePlayer();
  start(p);
  const one = new Float32Array(4800).fill(1);
  p.push({ type: 'pcm', gen: 1, pts: 0, channels: [one.slice()] }); // 0.0 - 0.1
  p.push({ type: 'pcm', gen: 1, pts: 0.2, channels: [one.slice()] }); // 0.1 s missing
  p.push({ type: 'pcm', gen: 1, pts: 0.25, channels: [new Float32Array(4800).fill(0.5)] }); // overlaps the previous chunk by half
  const out = p.render(SR * 0.4 + 128);
  const at = (t: number) => out[0][Math.round(t * SR)];
  expect(at(0.05)).toBe(1);
  expect(at(0.15)).toBe(0);
  expect(at(0.199)).toBe(0);
  expect(at(0.201)).toBe(1);
  expect(at(0.299)).toBe(1); // second chunk plays in full
  expect(at(0.301)).toBe(0.5); // third chunk continues where the second ended
  expect(at(0.349)).toBe(0.5);
});

test('the clock holds when audio underruns and free-runs after end-of-stream', () => {
  const p = makePlayer();
  start(p);
  feed(p, [sine(440, 0.1, SR, 0.5)]);
  p.render(SR * 0.3);
  let c = lastClock(p);
  expect(c.mediaTime, 'clock stopped at the last sample').toBeCloseTo(0.1, 3);
  expect(c.starved).toBe(true);
  expect(c.underruns).toBe(1);
  expect(c.rate).toBe(0);
  // more audio arrives: it resumes from where it stopped
  feed(p, [sine(440, 0.1, SR, 0.5)], { startPts: 0.1 });
  p.render(SR * 0.05);
  expect(lastClock(p).starved).toBe(false);
  // end of stream: video may still have frames to show, so time keeps flowing
  p.push({ type: 'eos', gen: 1 });
  p.render(SR * 0.5);
  c = lastClock(p);
  expect(c.drained).toBe(true);
  expect(c.mediaTime).toBeGreaterThan(0.5);
  expect(c.rate).toBe(1);
});

test('without an audio track the processor is a free-running clock at the playback rate', () => {
  const p = makePlayer();
  p.control({ type: 'config', hasAudio: false, channels: 2 });
  p.control({ type: 'seek', time: 10, gen: 3 });
  p.control({ type: 'rate', rate: 2 });
  p.control({ type: 'play', playing: true });
  p.render(SR);
  expect(p.proc.mediaTime).toBeCloseTo(12, 6);
  // reports are throttled to every 8th quantum, so the last one may trail by up to 8 * 128 frames of media
  expect(12 - lastClock(p).mediaTime).toBeLessThan((2 * 8 * 128) / SR + 1e-9);
  p.control({ type: 'play', playing: false });
  p.render(SR);
  expect(p.proc.mediaTime).toBeCloseTo(12, 6);
  expect(lastClock(p).rate).toBe(0);
});

test('stale generations are ignored and "advance" steps the clock without discarding buffered audio', () => {
  const p = makePlayer();
  start(p);
  p.push({ type: 'pcm', gen: 99, pts: 0, channels: [new Float32Array(4800).fill(1)] });
  expect(lastClock(p).buffered).toBe(0);
  const ramp = new Float32Array(SR);
  for (let i = 0; i < SR; i++) ramp[i] = i / SR;
  feed(p, [ramp]);
  p.control({ type: 'play', playing: false });
  p.control({ type: 'advance', time: 0.25 });
  expect(lastClock(p).mediaTime).toBeCloseTo(0.25, 9);
  p.control({ type: 'play', playing: true });
  const out = p.render(256);
  expect(out[0][0]).toBeCloseTo(0.25, 6);
});

test('normalizer: lifts quiet material, tames loud material, never exceeds full scale', () => {
  const { registry } = loadWorklet(SR);
  const run = (amp: number, seconds: number, enabled: boolean) => {
    const proc = new registry['lumen-normalizer']();
    proc.port.onmessage({ data: { type: 'enable', on: enabled } });
    const input = sine(440, seconds, SR, amp);
    const out = new Float32Array(input.length);
    for (let o = 0; o + 128 <= input.length; o += 128) {
      const y = [new Float32Array(128), new Float32Array(128)];
      proc.process([[input.subarray(o, o + 128), input.subarray(o, o + 128)]], [y]);
      out.set(y[0], o);
    }
    return out.subarray(out.length - SR);
  };
  expect(rms(run(0.03, 8, false))).toBeCloseTo(0.03 / Math.SQRT2, 3); // disabled = transparent
  const quiet = rms(run(0.03, 8, true));
  expect(quiet / (0.03 / Math.SQRT2), 'quiet input gain').toBeGreaterThan(2.5);
  expect(quiet).toBeLessThan(0.12);
  const loud = run(0.95, 8, true);
  expect(rms(loud)).toBeLessThan(0.2);
  expect(rms(loud)).toBeGreaterThan(0.07);
  const hot = run(1.6, 1, false); // over-range input with the stage bypassed is passed through untouched
  expect(Math.max(...hot.map(Math.abs))).toBeCloseTo(1.6, 2);
  const limited = run(1.6, 0.2, true); // enabled, before the gain rider has settled: the limiter must hold
  expect(Math.max(...limited.map(Math.abs))).toBeLessThanOrEqual(1.0);
});
