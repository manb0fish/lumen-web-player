// Runs the real AudioWorklet module outside a browser by stubbing the worklet global scope.
// Used by the unit tests to verify the time-stretcher, resampler, downmixer and clock arithmetic
// against synthetic signals with exactly known properties.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadWorklet(sampleRate = 48000) {
  const registry = {};
  const sandbox = {
    sampleRate,
    currentTime: 0,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => this.port.messages.push(m), messages: [], onmessage: null };
      }
    },
    registerProcessor: (name, cls) => (registry[name] = cls),
    console,
    Math,
    Float32Array,
    Float64Array,
    Infinity,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../../src/audio/worklet.js', import.meta.url), 'utf8'), sandbox);
  return { registry, sandbox };
}

/** A player processor wired to a fake data port. */
export function makePlayer({ sampleRate = 48000, outChannels = 2 } = {}) {
  const { registry, sandbox } = loadWorklet(sampleRate);
  const proc = new registry['lumen-player']({ outputChannelCount: [outChannels] });
  const dataPort = { onmessage: null };
  proc.port.onmessage({ data: { type: 'port', port: dataPort } });
  const control = (msg) => proc.port.onmessage({ data: msg });
  const push = (msg) => dataPort.onmessage({ data: msg });
  /** Render `frames` output frames (in 128-frame quanta); returns per-channel Float32Arrays. */
  const render = (frames) => {
    const out = Array.from({ length: outChannels }, () => new Float32Array(frames));
    for (let o = 0; o + 128 <= frames; o += 128) {
      const q = Array.from({ length: outChannels }, () => new Float32Array(128));
      proc.process([], [q]);
      sandbox.currentTime += 128 / sampleRate;
      for (let c = 0; c < outChannels; c++) out[c].set(q[c], o);
    }
    return out;
  };
  return { proc, control, push, render, sandbox, sampleRate };
}

export function sine(freq, seconds, sampleRate = 48000, amp = 0.5, phase = 0) {
  const n = Math.round(seconds * sampleRate);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * freq * (i / sampleRate) + phase);
  return a;
}

/** Feed a mono/multi-channel signal as a stream of timestamped chunks, like a decoder would. */
export function feed(player, channels, { gen = 1, startPts = 0, chunk = 1024 } = {}) {
  const n = channels[0].length;
  for (let o = 0; o < n; o += chunk) {
    const len = Math.min(chunk, n - o);
    player.push({ type: 'pcm', gen, pts: startPts + o / player.sampleRate, channels: channels.map((c) => c.slice(o, o + len)) });
  }
}

/** Frequency of the strongest component via a zero-padded DFT scan with parabolic refinement. */
export function dominantFrequency(signal, sampleRate, lo, hi) {
  const n = signal.length;
  let best = 0;
  let bestMag = -1;
  const mags = [];
  const step = 0.5;
  for (let f = lo; f <= hi; f += step) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * f) / sampleRate;
    for (let i = 0; i < n; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      re += signal[i] * win * Math.cos(w * i);
      im -= signal[i] * win * Math.sin(w * i);
    }
    const m = Math.hypot(re, im);
    mags.push(m);
    if (m > bestMag) {
      bestMag = m;
      best = f;
    }
  }
  return { frequency: best, magnitude: (2 * bestMag) / (n * 0.5) };
}

export function rms(signal) {
  let s = 0;
  for (let i = 0; i < signal.length; i++) s += signal[i] * signal[i];
  return Math.sqrt(s / signal.length);
}
