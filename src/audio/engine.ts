import workletUrl from './worklet.js?url';

/**
 * Main-thread facade over the audio graph:
 *
 *   [lumen-player worklet]──┐
 *                            ├─► [lumen-normalizer] ─► [gain] ─► [analyser] ─► destination
 *   [MediaElementSource]────┘
 *
 * The player worklet is both the PCM sink and the master clock. `now()` converts its last report
 * into "media time that is audible right now" using the context's output timestamp, so the value
 * already accounts for output latency and can be read at any moment without messaging.
 */

export interface ClockReport {
  gen: number;
  mediaTime: number;
  ctxTime: number;
  rate: number;
  buffered: number;
  underruns: number;
  starved: boolean;
  drained: boolean;
  framesIn: number;
  framesOut: number;
}

const ZERO_REPORT: ClockReport = {
  gen: 0,
  mediaTime: 0,
  ctxTime: 0,
  rate: 0,
  buffered: 0,
  underruns: 0,
  starved: false,
  drained: false,
  framesIn: 0,
  framesOut: 0,
};

export class AudioEngine {
  ctx: AudioContext | null = null;
  private playerNode: AudioWorkletNode | null = null;
  private normalizerNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  private activeElementSource: MediaElementAudioSourceNode | null = null;
  private report: ClockReport = { ...ZERO_REPORT };
  private floor = 0;
  private gen = 0;
  private volume = 1;
  private muted = false;
  private normalize = false;
  private pitch = true;
  private rate = 1;
  private playing = false;
  private hasAudio = false;
  private channels = 2;
  private building: Promise<void> | null = null;
  private waveBuf: Float32Array<ArrayBuffer> | null = null;
  /** Smoothed (context time - performance time), seconds: maps a wall-clock instant to audible context time. */
  private ctxOffset: number | null = null;
  onReport: (r: ClockReport) => void = () => {};

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get outputChannels(): number {
    return 2;
  }

  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  get latency(): number {
    if (!this.ctx) return 0;
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  get lastReport(): ClockReport {
    return this.report;
  }

  /** Create (or recreate at a different sample rate) the context and graph. */
  async ensure(sampleRate?: number): Promise<void> {
    if (this.building) await this.building;
    const want = sampleRate && sampleRate >= 8000 && sampleRate <= 96000 ? sampleRate : undefined;
    if (this.ctx && (!want || this.ctx.sampleRate === want)) return;
    this.building = this.build(want);
    try {
      await this.building;
    } finally {
      this.building = null;
    }
  }

  private async build(sampleRate?: number): Promise<void> {
    await this.teardown();
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    await ctx.audioWorklet.addModule(workletUrl);
    const playerNode = new AudioWorkletNode(ctx, 'lumen-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const normalizerNode = new AudioWorkletNode(ctx, 'lumen-normalizer', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    const gainNode = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    playerNode.connect(normalizerNode);
    normalizerNode.connect(gainNode);
    gainNode.connect(analyser);
    analyser.connect(ctx.destination);
    playerNode.port.onmessage = (e) => {
      const d = e.data;
      if (d.type !== 'clock' || d.gen !== this.gen) return;
      const wasHeld = this.report.rate === 0;
      this.report = d;
      if (wasHeld || d.rate === 0) this.floor = d.mediaTime;
      this.onReport(d);
    };
    this.ctx = ctx;
    this.ctxOffset = null;
    ctx.addEventListener('statechange', () => (this.ctxOffset = null));
    this.playerNode = playerNode;
    this.normalizerNode = normalizerNode;
    this.gainNode = gainNode;
    this.analyser = analyser;
    this.waveBuf = new Float32Array(analyser.fftSize);
    this.applyGain();
    normalizerNode.port.postMessage({ type: 'enable', on: this.normalize });
    playerNode.port.postMessage({ type: 'pitch', on: this.pitch });
    playerNode.port.postMessage({ type: 'rate', rate: this.rate });
    playerNode.port.postMessage({ type: 'config', hasAudio: this.hasAudio, channels: this.channels });
  }

  private async teardown(): Promise<void> {
    if (!this.ctx) return;
    try {
      this.playerNode?.port.close();
      this.playerNode?.disconnect();
      this.normalizerNode?.disconnect();
      this.gainNode?.disconnect();
      this.analyser?.disconnect();
      await this.ctx.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.playerNode = this.normalizerNode = null;
    this.gainNode = null;
    this.analyser = null;
    this.activeElementSource = null;
    this.elementSources = new WeakMap();
  }

  async destroy(): Promise<void> {
    this.onReport = () => {};
    await this.teardown();
  }

  /** Try to start the context. Resolves false when the browser's autoplay policy keeps it suspended. */
  async resume(): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.state === 'running') return true;
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
    } catch {
      /* ignore */
    }
    return (ctx.state as string) === 'running';
  }

  // ---- worklet-driven (WebCodecs / WASM) path ------------------------------------------------

  configure(opts: { hasAudio: boolean; channels: number }): void {
    this.hasAudio = opts.hasAudio;
    this.channels = opts.channels;
    this.playerNode?.port.postMessage({ type: 'config', hasAudio: opts.hasAudio, channels: opts.channels });
  }

  /** Returns a port a decode worker can post PCM to; the other end is wired into the worklet. */
  createDataPort(): MessagePort {
    const ch = new MessageChannel();
    this.playerNode!.port.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
    return ch.port2;
  }

  /** Flush buffered audio and pin the clock to `time`. Messages from older generations are ignored. */
  seek(time: number, gen: number): void {
    this.gen = gen;
    this.floor = time;
    this.report = { ...ZERO_REPORT, gen, mediaTime: time };
    this.playerNode?.port.postMessage({ type: 'seek', time, gen });
  }

  /** Step the (held) clock forward to `time`, keeping already-buffered audio beyond it. */
  advance(time: number): void {
    this.report = { ...this.report, mediaTime: time, rate: 0 };
    this.floor = time;
    this.playerNode?.port.postMessage({ type: 'advance', time });
  }

  markEos(gen: number): void {
    this.playerNode?.port.postMessage({ type: 'eos', gen });
  }

  setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    if (!playing) {
      // Freeze immediately at the audible position rather than waiting for the worklet's reply.
      const t = this.now();
      this.report = { ...this.report, mediaTime: t, rate: 0 };
      this.floor = t;
    }
    this.playerNode?.port.postMessage({ type: 'play', playing });
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.playerNode?.port.postMessage({ type: 'rate', rate });
    if (this.activeElementSource) (this.activeElementSource.mediaElement as HTMLMediaElement).playbackRate = rate;
  }

  setPitchCorrection(on: boolean): void {
    this.pitch = on;
    this.playerNode?.port.postMessage({ type: 'pitch', on });
  }

  /**
   * Media time (seconds) of the sample that is audible at `perfMs` (a performance.now() timestamp,
   * default: right now). Passing a vsync-aligned timestamp — e.g. the requestAnimationFrame time
   * plus one refresh — gives a jitter-free schedule for picture presentation.
   */
  now(perfMs: number = performance.now()): number {
    const r = this.report;
    const ctx = this.ctx;
    if (!ctx || r.rate === 0) return r.mediaTime;
    const wall = performance.now();
    let audible: number;
    const ts = ctx.getOutputTimestamp();
    if (ts.contextTime && ts.performanceTime) {
      // The (contextTime, performanceTime) pair is quantised to audio callbacks and jitters by a
      // few milliseconds; low-pass the offset between the two clocks instead of using it raw.
      const raw = ts.contextTime - ts.performanceTime / 1000;
      if (this.ctxOffset === null || Math.abs(raw - this.ctxOffset) > 0.03) this.ctxOffset = raw;
      else this.ctxOffset += (raw - this.ctxOffset) * 0.02;
      audible = perfMs / 1000 + this.ctxOffset;
      // Guard against implementations that report a stale timestamp.
      const nowAudible = wall / 1000 + this.ctxOffset;
      if (nowAudible > ctx.currentTime + 0.05 || nowAudible < ctx.currentTime - 1) {
        audible = ctx.currentTime - this.latency + (perfMs - wall) / 1000;
      }
    } else {
      audible = ctx.currentTime - this.latency + (perfMs - wall) / 1000;
    }
    const t = r.mediaTime + (audible - r.ctxTime) * r.rate;
    return t < this.floor ? this.floor : t;
  }

  // ---- element-driven (MSE / native) path -----------------------------------------------------

  attachElement(el: HTMLMediaElement): void {
    if (!this.ctx || !this.normalizerNode) return;
    let node = this.elementSources.get(el);
    if (!node) {
      node = this.ctx.createMediaElementSource(el);
      this.elementSources.set(el, node);
    }
    this.activeElementSource?.disconnect();
    node.connect(this.normalizerNode);
    this.activeElementSource = node;
  }

  detachElement(): void {
    try {
      this.activeElementSource?.disconnect();
    } catch {
      /* ignore */
    }
    this.activeElementSource = null;
  }

  // ---- shared controls ------------------------------------------------------------------------

  private applyGain(): void {
    if (!this.gainNode || !this.ctx) return;
    const v = this.muted ? 0 : this.volume;
    this.gainNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  setVolume(v: number): void {
    this.volume = v;
    this.applyGain();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyGain();
  }

  setNormalize(on: boolean): void {
    this.normalize = on;
    this.normalizerNode?.port.postMessage({ type: 'enable', on });
  }

  // ---- analysis taps for visualizers ----------------------------------------------------------

  get fftBins(): number {
    return this.analyser?.frequencyBinCount ?? 1024;
  }

  /** Byte magnitudes (0..255), `fftBins` long. */
  getSpectrum(target: Uint8Array<ArrayBuffer>): void {
    this.analyser?.getByteFrequencyData(target);
  }

  /** Time-domain samples (-1..1). */
  getWaveform(target: Float32Array<ArrayBuffer>): void {
    this.analyser?.getFloatTimeDomainData(target);
  }

  /** Instantaneous RMS and peak of the output, for VU meters and tests. */
  getLevel(): { rms: number; peak: number } {
    if (!this.analyser || !this.waveBuf) return { rms: 0, peak: 0 };
    this.analyser.getFloatTimeDomainData(this.waveBuf);
    let sum = 0;
    let peak = 0;
    const b = this.waveBuf;
    for (let i = 0; i < b.length; i++) {
      const a = Math.abs(b[i]);
      sum += a * a;
      if (a > peak) peak = a;
    }
    return { rms: Math.sqrt(sum / b.length), peak };
  }
}
