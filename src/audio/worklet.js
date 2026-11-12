/* eslint-disable no-undef */
/**
 * Lumen audio worklet — runs on the audio rendering thread.
 *
 *  LumenPlayerProcessor   PCM sink + MASTER CLOCK. Receives planar float chunks straight from the
 *                         decode workers over a MessagePort, downmixes, and plays them out either
 *                         1:1, through a WSOLA time-stretcher (pitch-preserving speed change) or a
 *                         linear resampler (speed change with pitch shift). The media time of the
 *                         sample currently leaving the processor IS the player's clock; video is
 *                         slaved to it. With no audio track the processor free-runs the clock.
 *  LumenNormalizerProcessor  Slow RMS-tracking gain rider + soft limiter ("gain normalization").
 *
 * Plain JS on purpose: worklet modules are loaded by URL and must not depend on the bundler.
 */

const RING_SECONDS = 4;
const GAP_TOLERANCE = 0.012; // seconds of PTS jitter treated as "contiguous"

/** ITU-R BS.775 style downmix rows for SMPTE channel orders. Returns matrix[out][in]. */
function buildMatrix(inCh, outCh) {
  const m = [];
  for (let o = 0; o < outCh; o++) m.push(new Float32Array(inCh));
  if (inCh === outCh) {
    for (let i = 0; i < inCh; i++) m[i][i] = 1;
    return m;
  }
  if (outCh === 1) {
    for (let i = 0; i < inCh; i++) m[0][i] = 1 / inCh;
    return m;
  }
  if (inCh === 1) {
    for (let o = 0; o < Math.min(outCh, 2); o++) m[o][0] = 1;
    return m;
  }
  if (outCh >= inCh) {
    for (let i = 0; i < inCh; i++) m[i][i] = 1;
    return m;
  }
  // Fold down to stereo (anything wider than the output is folded to L/R).
  const c = Math.SQRT1_2;
  const L = m[0];
  const R = m[1];
  L[0] = 1;
  R[1] = 1;
  // role of each input index by channel count (SMPTE): C, LFE, surrounds
  const layouts = {
    3: { C: 2 },
    4: { SL: 2, SR: 3 },
    5: { C: 2, SL: 3, SR: 4 },
    6: { C: 2, LFE: 3, SL: 4, SR: 5 },
    7: { C: 2, LFE: 3, BC: 4, SL: 5, SR: 6 },
    8: { C: 2, LFE: 3, BL: 4, BR: 5, SL: 6, SR: 7 },
  };
  const lay = layouts[inCh] || layouts[8];
  if (lay.C !== undefined) {
    L[lay.C] = c;
    R[lay.C] = c;
  }
  if (lay.SL !== undefined) L[lay.SL] = c;
  if (lay.SR !== undefined) R[lay.SR] = c;
  if (lay.BL !== undefined) L[lay.BL] = c;
  if (lay.BR !== undefined) R[lay.BR] = c;
  if (lay.BC !== undefined) {
    L[lay.BC] = 0.5;
    R[lay.BC] = 0.5;
  }
  // LFE is intentionally dropped, as most consumer downmixers do.
  let sumL = 0;
  let sumR = 0;
  for (let i = 0; i < inCh; i++) {
    sumL += L[i];
    sumR += R[i];
  }
  const norm = 1 / Math.max(sumL, sumR, 1);
  for (let i = 0; i < inCh; i++) {
    L[i] *= norm;
    R[i] *= norm;
  }
  return m;
}

class LumenPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.outCh = (options.outputChannelCount && options.outputChannelCount[0]) || 2;
    this.sr = sampleRate;
    this.cap = Math.ceil(this.sr * RING_SECONDS);
    this.ring = [];
    for (let c = 0; c < this.outCh; c++) this.ring.push(new Float32Array(this.cap));
    this.rd = 0; // read index into ring
    this.len = 0; // frames buffered in ring
    this.headPts = 0; // media time of ring[rd]
    this.writePts = 0; // media time the next written frame will have
    this.pending = []; // chunks waiting for ring space
    this.pendingFrames = 0;
    this.gen = 0;
    this.playing = false;
    this.rate = 1;
    this.pitch = true;
    this.hasAudio = false;
    this.eos = false;
    this.mediaTime = 0;
    this.srcCh = 2;
    this.matrix = buildMatrix(2, this.outCh);
    this.underruns = 0;
    this.starved = false;
    this.drained = false;
    this.quanta = 0;
    this.lastReportState = '';
    this.framesIn = 0;
    this.framesOut = 0;
    // --- WSOLA ---
    let n = 1;
    while (n < this.sr * 0.02) n <<= 1; // ~21 ms @ 48k -> 1024
    this.N = n;
    this.Hs = n >> 1;
    this.delta = n >> 2;
    this.win = new Float32Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    this.ola = [];
    this.outFifo = [];
    for (let c = 0; c < this.outCh; c++) {
      this.ola.push(new Float32Array(n));
      this.outFifo.push(new Float32Array(this.Hs));
    }
    this.fifoRd = 0;
    this.fifoLen = 0;
    this.anaPos = 0; // analysis position, frames relative to ring head (fractional)
    this.natural = -1; // where the previous segment would naturally continue (frames from ring head); -1 = none
    this.mode = 'direct';
    this.resPos = 0; // fractional read position for the linear resampler
    this.fifoTime = 0; // media time corresponding to outFifo[fifoRd]
    this.effRate = 0; // media seconds per context second right now (0 = clock held)

    this.port.onmessage = (e) => this.onControl(e.data);
  }

  onControl(msg) {
    switch (msg.type) {
      case 'port':
        msg.port.onmessage = (e) => this.onData(e.data);
        break;
      case 'config':
        this.hasAudio = !!msg.hasAudio;
        this.srcCh = msg.channels || 2;
        this.matrix = buildMatrix(this.srcCh, this.outCh);
        break;
      case 'play':
        this.playing = !!msg.playing;
        if (!this.playing) this.effRate = 0;
        break;
      case 'rate':
        this.rate = Math.min(16, Math.max(0.0625, msg.rate));
        break;
      case 'pitch':
        this.pitch = !!msg.on;
        break;
      case 'seek':
        this.flush(msg.time, msg.gen);
        break;
      case 'advance':
        this.advance(msg.time);
        break;
      case 'eos':
        if (msg.gen === this.gen) this.eos = true;
        break;
    }
    this.report(true);
  }

  flush(time, gen) {
    this.gen = gen;
    this.rd = 0;
    this.len = 0;
    this.pending.length = 0;
    this.pendingFrames = 0;
    this.headPts = time;
    this.writePts = time;
    this.mediaTime = time;
    this.eos = false;
    this.starved = false;
    this.drained = false;
    this.effRate = 0;
    this.resetStretch();
  }

  /**
   * Move the clock forward to `time` WITHOUT discarding audio that is still ahead of it (used by
   * frame-stepping). Anything the decoder delivers later that lies before `time` is trimmed by fill().
   */
  advance(time) {
    const d = Math.round((time - this.headPts) * this.sr);
    if (d < 0) return;
    if (d <= this.len) {
      this.drop(d);
    } else {
      this.drop(this.len);
      this.headPts = time;
      if (this.writePts < time) this.writePts = time;
    }
    this.mediaTime = time;
    this.effRate = 0;
    this.resetStretch();
    this.fill();
  }

  resetStretch() {
    for (let c = 0; c < this.outCh; c++) this.ola[c].fill(0);
    this.fifoRd = 0;
    this.fifoLen = 0;
    this.anaPos = 0;
    this.natural = -1;
    this.resPos = 0;
  }

  onData(msg) {
    if (msg.gen !== this.gen) return;
    if (msg.type === 'eos') {
      this.eos = true;
      return;
    }
    if (msg.type !== 'pcm') return;
    const ch = msg.channels;
    if (!ch || !ch.length) return;
    if (ch.length !== this.srcCh) {
      this.srcCh = ch.length;
      this.matrix = buildMatrix(this.srcCh, this.outCh);
    }
    this.pending.push({ pts: msg.pts, data: ch, off: 0, frames: ch[0].length });
    this.pendingFrames += ch[0].length;
    this.fill();
  }

  /** Move as much pending PCM into the ring as fits, fixing up gaps/overlaps against writePts. */
  fill() {
    const sr = this.sr;
    while (this.pending.length) {
      const chunk = this.pending[0];
      if (chunk.off === 0) {
        const diff = chunk.pts - this.writePts;
        if (diff < -GAP_TOLERANCE) {
          // Overlaps what we already have (or precedes the seek target): skip the overlap.
          const skip = Math.min(chunk.frames, Math.round(-diff * sr));
          chunk.off = skip;
          this.pendingFrames -= skip;
          if (chunk.off >= chunk.frames) {
            this.pending.shift();
            continue;
          }
        } else if (diff > GAP_TOLERANCE) {
          // Hole in the stream: insert silence so the clock keeps honest time.
          const space = this.cap - this.len;
          const want = Math.round(diff * sr);
          const n = Math.min(space, want);
          if (n <= 0) return;
          this.writeSilence(n);
          if (n < want) return;
        }
      }
      const space = this.cap - this.len;
      if (space <= 0) return;
      const n = Math.min(space, chunk.frames - chunk.off);
      this.writeChunk(chunk.data, chunk.off, n);
      chunk.off += n;
      this.pendingFrames -= n;
      if (chunk.off >= chunk.frames) this.pending.shift();
      else return;
    }
  }

  writeSilence(n) {
    let w = (this.rd + this.len) % this.cap;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.outCh; c++) this.ring[c][w] = 0;
      if (++w === this.cap) w = 0;
    }
    this.len += n;
    this.writePts += n / this.sr;
  }

  writeChunk(src, off, n) {
    const cap = this.cap;
    const w0 = (this.rd + this.len) % cap;
    const srcCh = src.length;
    for (let o = 0; o < this.outCh; o++) {
      const dst = this.ring[o];
      const row = this.matrix[o];
      let first = true;
      for (let s = 0; s < srcCh; s++) {
        const g = row[s];
        if (g === 0) continue;
        const sp = src[s];
        let w = w0;
        if (first) {
          for (let i = 0; i < n; i++) {
            dst[w] = sp[off + i] * g;
            if (++w === cap) w = 0;
          }
          first = false;
        } else {
          for (let i = 0; i < n; i++) {
            dst[w] += sp[off + i] * g;
            if (++w === cap) w = 0;
          }
        }
      }
      if (first) {
        let w = w0;
        for (let i = 0; i < n; i++) {
          dst[w] = 0;
          if (++w === cap) w = 0;
        }
      }
    }
    this.len += n;
    this.framesIn += n;
    this.writePts += n / this.sr;
  }

  drop(n) {
    if (n <= 0) return;
    if (n > this.len) n = this.len;
    this.rd = (this.rd + n) % this.cap;
    this.len -= n;
    this.headPts += n / this.sr;
  }

  // ---- output strategies -------------------------------------------------------------------

  playDirect(out, n) {
    const m = Math.min(n, this.len);
    const cap = this.cap;
    for (let c = 0; c < out.length; c++) {
      const dst = out[c];
      const src = this.ring[Math.min(c, this.outCh - 1)];
      let r = this.rd;
      for (let i = 0; i < m; i++) {
        dst[i] = src[r];
        if (++r === cap) r = 0;
      }
    }
    this.drop(m);
    this.mediaTime = this.headPts;
    return m;
  }

  playResampled(out, n) {
    // Linear interpolation; pitch follows speed (mpv's audio-pitch-correction=no).
    const cap = this.cap;
    const rate = this.rate;
    let pos = this.resPos;
    let produced = 0;
    for (let i = 0; i < n; i++) {
      const i0 = Math.floor(pos);
      if (i0 + 1 >= this.len) break;
      const f = pos - i0;
      const a = (this.rd + i0) % cap;
      const b = a + 1 === cap ? 0 : a + 1;
      for (let c = 0; c < out.length; c++) {
        const src = this.ring[Math.min(c, this.outCh - 1)];
        out[c][i] = src[a] + (src[b] - src[a]) * f;
      }
      pos += rate;
      produced++;
    }
    const whole = Math.floor(pos);
    this.drop(Math.min(whole, this.len));
    this.resPos = pos - whole;
    this.mediaTime = this.headPts + this.resPos / this.sr;
    return produced;
  }

  /** Synthesize one WSOLA hop (Hs output frames) into outFifo. Returns false when starved. */
  synthesize() {
    const N = this.N;
    const Hs = this.Hs;
    const D = this.delta;
    const cap = this.cap;
    const need = Math.ceil(this.anaPos) + D + N;
    if (this.len < need) {
      if (!(this.eos && this.pending.length === 0)) return false;
      if (this.len < Math.ceil(this.anaPos) + Hs) return false; // truly out of material
    }
    const target = Math.round(this.anaPos);
    let best = target;
    if (this.natural >= 0) {
      const natural = this.natural;
      const lo = Math.max(0, target - D);
      const hi = Math.min(this.len - N, target + D);
      if (natural >= lo && natural <= hi) {
        best = natural; // perfect continuation is inside the tolerance window
      } else if (hi > lo && natural + Hs <= this.len) {
        const r0 = this.ring[0];
        const r1 = this.ring[this.outCh > 1 ? 1 : 0];
        let bestScore = -Infinity;
        for (let cand = lo; cand <= hi; cand += 2) {
          let acc = 0;
          let a = (this.rd + cand) % cap;
          let b = (this.rd + natural) % cap;
          for (let k = 0; k < Hs; k += 4) {
            acc += (r0[a] + r1[a]) * (r0[b] + r1[b]);
            a += 4;
            if (a >= cap) a -= cap;
            b += 4;
            if (b >= cap) b -= cap;
          }
          if (acc > bestScore) {
            bestScore = acc;
            best = cand;
          }
        }
      } else {
        best = Math.max(0, Math.min(target, this.len - N));
      }
    }
    if (best < 0) best = 0;
    const avail = Math.min(N, this.len - best);
    for (let c = 0; c < this.outCh; c++) {
      const src = this.ring[c];
      const ola = this.ola[c];
      const win = this.win;
      let r = (this.rd + best) % cap;
      for (let i = 0; i < avail; i++) {
        ola[i] += src[r] * win[i];
        if (++r === cap) r = 0;
      }
      const fifo = this.outFifo[c];
      for (let i = 0; i < Hs; i++) fifo[i] = ola[i];
      ola.copyWithin(0, Hs);
      ola.fill(0, N - Hs);
    }
    this.fifoRd = 0;
    this.fifoLen = Hs;
    this.fifoTime = this.headPts + this.anaPos / this.sr;
    this.natural = best + Hs;
    this.anaPos += Hs * this.rate;
    // Release input that neither the next search window nor the continuation template can reference.
    const keepFrom = Math.floor(Math.min(this.natural, this.anaPos - D));
    if (keepFrom > 0) {
      const d = Math.min(keepFrom, this.len);
      this.drop(d);
      this.anaPos -= d;
      this.natural -= d;
    }
    return true;
  }

  playStretched(out, n) {
    let produced = 0;
    while (produced < n) {
      if (this.fifoLen === 0) {
        this.fill();
        if (!this.synthesize()) break;
      }
      const m = Math.min(n - produced, this.fifoLen);
      for (let c = 0; c < out.length; c++) {
        const src = this.outFifo[Math.min(c, this.outCh - 1)];
        const dst = out[c];
        for (let i = 0; i < m; i++) dst[produced + i] = src[this.fifoRd + i];
      }
      this.fifoRd += m;
      this.fifoLen -= m;
      this.fifoTime += (m / this.sr) * this.rate;
      produced += m;
    }
    this.mediaTime = this.fifoTime;
    return produced;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    let advancing = false;
    let effRate = 0;

    if (this.playing) {
      const exhausted = this.eos && this.len === 0 && this.pending.length === 0 && this.fifoLen === 0;
      if (!this.hasAudio || exhausted) {
        // No audio to render: free-run so video (or the tail after audio EOS) keeps moving.
        this.mediaTime += (n / this.sr) * this.rate;
        this.headPts = this.writePts = this.mediaTime;
        advancing = true;
        effRate = this.rate;
        if (this.hasAudio) this.drained = true;
        this.starved = false;
      } else {
        const wantMode = this.rate === 1 ? 'direct' : this.pitch ? 'stretch' : 'resample';
        if (wantMode !== this.mode) {
          if (this.mode === 'stretch') this.drop(Math.min(this.len, Math.max(0, Math.floor(this.anaPos))));
          this.resetStretch();
          this.mode = wantMode;
        }
        let produced;
        if (wantMode === 'direct') produced = this.playDirect(out, n);
        else if (wantMode === 'stretch') produced = this.playStretched(out, n);
        else produced = this.playResampled(out, n);
        this.framesOut += produced;
        if (produced < n) {
          if (!this.starved && !this.eos) this.underruns++;
          this.starved = !this.eos;
        } else {
          this.starved = false;
        }
        advancing = produced > 0;
        effRate = advancing ? this.rate * (produced / n) : 0;
        this.fill();
      }
    }

    this.effRate = effRate;
    if ((++this.quanta & 7) === 0) this.report(false, n);
    else {
      const key = (advancing ? 'a' : 's') + (this.starved ? 'S' : '') + (this.drained ? 'D' : '');
      if (key !== this.lastReportState) this.report(false, n);
    }
    return true;
  }

  report(fromControl, n) {
    const adv = this.effRate;
    this.lastReportState = (adv > 0 ? 'a' : 's') + (this.starved ? 'S' : '') + (this.drained ? 'D' : '');
    this.port.postMessage({
      type: 'clock',
      gen: this.gen,
      mediaTime: this.mediaTime,
      // context time at which `mediaTime` will leave this processor
      ctxTime: currentTime + (n ? n / this.sr : 0),
      rate: adv,
      buffered: (this.len + this.pendingFrames) / this.sr,
      underruns: this.underruns,
      starved: this.starved,
      drained: this.drained,
      framesIn: this.framesIn,
      framesOut: this.framesOut,
      settled: fromControl,
    });
  }
}

class LumenNormalizerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.gain = 1;
    this.level = 0; // smoothed mean-square
    this.port.onmessage = (e) => {
      if (e.data.type === 'enable') this.enabled = !!e.data.on;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length) return true;
    const n = input[0].length;
    let ms = 0;
    for (let c = 0; c < input.length; c++) {
      const x = input[c];
      for (let i = 0; i < n; i++) ms += x[i] * x[i];
    }
    ms /= n * input.length;
    const dt = n / sampleRate;
    // ~1.2 s integration for the loudness estimate
    const k = 1 - Math.exp(-dt / 1.2);
    if (ms > 1e-7) this.level += (ms - this.level) * k;
    let target = 1;
    if (this.enabled && this.level > 1e-6) {
      const TARGET_RMS = 0.11; // about -19 dBFS
      target = Math.min(4, Math.max(0.2, TARGET_RMS / Math.sqrt(this.level)));
    }
    // Slew: fast down (protect ears), slow up (no pumping)
    const up = Math.pow(10, (4 * dt) / 20);
    const down = Math.pow(10, (-18 * dt) / 20);
    const g0 = this.gain;
    let g1 = target;
    if (g1 > g0 * up) g1 = g0 * up;
    if (g1 < g0 * down) g1 = g0 * down;
    this.gain = g1;
    const limit = this.enabled || g0 !== 1 || g1 !== 1;
    for (let c = 0; c < output.length; c++) {
      const x = input[Math.min(c, input.length - 1)];
      const y = output[c];
      for (let i = 0; i < n; i++) {
        let v = x[i] * (g0 + ((g1 - g0) * i) / n);
        if (limit) {
          const a = v < 0 ? -v : v;
          if (a > 0.85) {
            // soft knee towards 1.0
            const over = a - 0.85;
            const lim = 0.85 + 0.15 * (1 - Math.exp(-over / 0.15));
            v = v < 0 ? -lim : lim;
          }
        }
        y[i] = v;
      }
    }
    return true;
  }
}

registerProcessor('lumen-player', LumenPlayerProcessor);
registerProcessor('lumen-normalizer', LumenNormalizerProcessor);
