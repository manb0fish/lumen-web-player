import type { AudioEngine } from '../audio/engine';
import type { MediaFrame, MediaInfo } from '../core/types';
import { clamp } from '../core/types';
import type { FrameSource } from './sources';
import { emptyStats, frameLedger, type Pipeline, type PipelineCallbacks, type PipelineStats } from './types';

type Hold = 'preroll' | 'video' | 'audio' | null;

const DRIFT_WINDOW = 180;

/**
 * A/V sync engine for the frame-push tiers (WebCodecs, FFmpeg-WASM).
 *
 * The AudioWorklet is the master clock. Decoded frames arrive (in any order) from one or two
 * FrameSources, are kept in a PTS-sorted queue, and on every animation frame the newest frame whose
 * PTS has been reached is presented; older ones are dropped. The clock is *held* (not just the
 * picture) whenever video or audio runs dry, so the two can never drift apart while rebuffering.
 */
export class FramePipeline implements Pipeline {
  readonly kind = 'frames' as const;
  readonly element = null;

  private queue: MediaFrame[] = [];
  private current: MediaFrame | null = null;
  private gen = 0;
  private wantPlay = false;
  private hold: Hold = 'preroll';
  private showNext = true;
  private shownForGen = false;
  private videoEos = false;
  private audioEos = false;
  private ended = false;
  private released = 0;
  private rate = 1;
  private raf = 0;
  private timer = 0;
  private destroyed = false;
  private lastSourceTick = 0;
  private lastReleasedSent = -1;
  private lastRaf = 0;
  private vsync = 1 / 60;
  private readonly hasVideo: boolean;
  private readonly hasAudio: boolean;
  private readonly frameDur: number;
  private readonly duration: number;
  private readonly videoSemantics: 'containing' | 'next';
  private st: PipelineStats = emptyStats();
  private drifts = new Float32Array(DRIFT_WINDOW);
  private driftN = 0;
  private presentTimes: number[] = [];
  private lastState = '';
  private seeking = false;
  private prerollSince = 0;
  private prerollReported = false;

  constructor(
    info: MediaInfo,
    private audio: AudioEngine,
    private sources: FrameSource[],
    private cb: PipelineCallbacks,
    private maxQueue: number,
    startTime = 0,
  ) {
    this.hasVideo = sources.some((s) => s.provides.video);
    this.hasAudio = sources.some((s) => s.provides.audio);
    this.frameDur = 1 / (info.video?.fps || 30);
    this.duration = info.duration;
    this.videoSemantics = sources.find((s) => s.provides.video)?.seekSemantics ?? 'containing';
    for (const s of sources) {
      s.onFrame = (frame, gen) => this.onFrame(frame, gen);
      s.onEos = (kind, gen) => this.onEos(kind, gen);
      s.onStarted = (gen, time, needsGo) => {
        if (gen !== this.gen) return;
        if (needsGo) {
          this.audio.seek(time, gen);
          s.go(gen);
        }
      };
      s.onError = (message, kind) => this.cb.onError(message, kind);
      s.onStats = (x) => {
        if (x.decodeLatencyMs !== undefined) this.st.decodeLatencyMs = x.decodeLatencyMs;
        if (x.note) {
          this.st.notes.push(x.note);
          this.cb.onNote(x.note);
        }
      };
    }
    this.raf = requestAnimationFrame(this.onRaf);
    // Housekeeping must keep running when rAF is throttled (background tab) so audio keeps flowing.
    this.timer = window.setInterval(() => this.service(), 100);
    this.seek(startTime, true);
  }

  // ---- frame intake ----------------------------------------------------------------------------

  private onFrame(frame: MediaFrame, gen: number): void {
    if (frame.kind === 'videoframe') frameLedger.opened++;
    if (gen !== this.gen || this.destroyed) {
      this.close(frame);
      return;
    }
    const q = this.queue;
    // Decoders emit in presentation order, so this is an append in practice; keep it sorted anyway.
    let i = q.length;
    while (i > 0 && q[i - 1].pts > frame.pts) i--;
    q.splice(i, 0, frame);
  }

  private onEos(kind: 'video' | 'audio', gen: number): void {
    if (gen !== this.gen) return;
    if (kind === 'video') this.videoEos = true;
    else this.audioEos = true;
  }

  private close(frame: MediaFrame): void {
    if (frame.kind === 'videoframe') {
      frameLedger.closed++;
      try {
        frame.frame.close();
      } catch {
        /* already closed */
      }
    }
  }

  private flushQueue(): void {
    for (const f of this.queue) this.close(f);
    this.queue.length = 0;
  }

  private show(frame: MediaFrame, clock: number): void {
    const prev = this.current;
    this.current = frame;
    this.cb.present(frame);
    if (prev && prev !== frame) this.close(prev);
    this.shownForGen = true;
    const st = this.st;
    st.presented++;
    st.lastPts = frame.pts;
    const drift = (clock - frame.pts) * 1000;
    st.driftMs = drift;
    this.drifts[this.driftN++ % DRIFT_WINDOW] = drift;
    if (drift > (frame.duration || this.frameDur) * 1000 + this.vsync * 1000) st.delayed++;
    const now = performance.now();
    this.presentTimes.push(now);
    while (this.presentTimes.length && now - this.presentTimes[0] > 1000) this.presentTimes.shift();
  }

  // ---- loops -----------------------------------------------------------------------------------

  private get clockRunning(): boolean {
    return this.wantPlay && !this.hold && !this.ended;
  }

  private onRaf = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.onRaf);
    if (this.lastRaf) {
      const dt = (now - this.lastRaf) / 1000;
      if (dt > 0.002 && dt < 0.1) this.vsync += (dt - this.vsync) * 0.1;
    }
    this.lastRaf = now;
    this.presentDue(now);
    this.service();
    this.cb.onRefresh?.();
  };

  /**
   * `frameTime` is the rAF timestamp, i.e. the start of the refresh being prepared. What we draw
   * now reaches the screen about one refresh later, so that is the instant we schedule for:
   * the picture then coincides with the audio that is audible when it lights up.
   */
  private presentDue(frameTime: number = performance.now()): void {
    if (!this.hasVideo) return;
    const q = this.queue;
    if (!q.length) return;
    const t = this.audio.now(frameTime + this.vsync * 1000);
    if (this.showNext) {
      // First frame after a seek / a requested step: show it unconditionally.
      const f = q.shift()!;
      this.released++;
      this.showNext = false;
      if (!this.clockRunning && f.pts > t + 0.0005) {
        this.audio.advance(f.pts);
        this.show(f, f.pts);
      } else {
        this.show(f, Math.max(t, f.pts));
      }
      return;
    }
    const eps = Math.min(this.vsync, this.frameDur) * 0.5;
    while (q.length) {
      const f = q[0];
      if (f.pts > t + eps) break;
      q.shift();
      this.released++;
      if (q.length && q[0].pts <= t + eps) {
        // A newer frame is already due: this one is late, skip it.
        this.close(f);
        this.st.dropped++;
        continue;
      }
      this.show(f, t);
      break;
    }
  }

  private service(): void {
    if (this.destroyed) return;
    const t = this.audio.now();
    const rep = this.audio.lastReport;
    const now = performance.now();

    // -- hold / buffering state machine
    if (this.hold === 'preroll') {
      const videoReady = !this.hasVideo || this.shownForGen || (this.videoEos && !this.queue.length);
      const audioReady = !this.hasAudio || this.audioEos || rep.buffered >= 0.12;
      if (videoReady && audioReady) {
        this.hold = null;
        this.seeking = false;
      } else if (
        !videoReady &&
        !this.prerollReported &&
        now - this.prerollSince > 5000 &&
        (!this.hasAudio || this.audioEos || rep.buffered >= 0.8)
      ) {
        // Audio is long since ready but not a single picture has arrived: the video decoder is
        // producing nothing. Surface it so the player can move to the next tier instead of hanging.
        this.prerollReported = true;
        this.cb.onError('the video decoder produced no frames', 'video');
      }
    } else if (this.hold === 'video') {
      if (this.queue.length >= Math.min(4, this.maxQueue >> 1) || this.videoEos) this.hold = null;
    } else if (this.hold === 'audio') {
      if (rep.buffered >= 0.3 || this.audioEos) this.hold = null;
    } else if (this.wantPlay && !this.ended) {
      const cur = this.current;
      if (this.hasVideo && !this.videoEos && !this.queue.length && cur && t > cur.pts + Math.max(2 * this.frameDur, 0.12)) {
        this.hold = 'video';
      } else if (this.hasAudio && !this.audioEos && rep.starved) {
        this.hold = 'audio';
      }
    }

    // -- end of stream
    if (!this.ended && this.wantPlay && !this.hold) {
      const videoDone = !this.hasVideo || (this.videoEos && !this.queue.length && !this.showNext);
      const audioDone = !this.hasAudio || (this.audioEos && rep.drained);
      const cur = this.current;
      const tailShown = !this.hasVideo || !cur || t >= cur.pts + (cur.duration || this.frameDur) - 0.002;
      if (videoDone && audioDone && (tailShown || t >= this.duration)) this.ended = true;
    }

    this.audio.setPlaying(this.clockRunning);

    // -- feed watermarks to the sources
    if (now - this.lastSourceTick > 33 || this.released !== this.lastReleasedSent) {
      this.lastSourceTick = now;
      this.lastReleasedSent = this.released;
      for (const s of this.sources) s.tick(this.gen, t, this.rate, this.clockRunning, this.released);
    }

    // -- publish coarse state
    const buffering = this.wantPlay && (this.hold === 'video' || this.hold === 'audio');
    const key = `${this.wantPlay ? 1 : 0}${buffering ? 1 : 0}${this.ended ? 1 : 0}${this.seeking ? 1 : 0}`;
    if (key !== this.lastState) {
      this.lastState = key;
      this.cb.onState({ paused: !this.wantPlay, buffering, ended: this.ended, seeking: this.seeking });
    }
  }

  // ---- transport -------------------------------------------------------------------------------

  async play(): Promise<void> {
    if (this.ended) this.seek(0, true);
    this.wantPlay = true;
    this.service();
  }

  pause(): void {
    this.wantPlay = false;
    this.service();
  }

  seek(time: number, exact: boolean): void {
    if (this.destroyed) return;
    time = clamp(time, 0, Math.max(0, this.duration));
    const gen = ++this.gen;
    this.flushQueue();
    this.videoEos = this.audioEos = false;
    this.ended = false;
    this.released = 0;
    this.lastReleasedSent = -1;
    this.showNext = this.hasVideo;
    this.shownForGen = false;
    this.hold = 'preroll';
    this.prerollSince = performance.now();
    this.prerollReported = false;
    this.seeking = true;
    this.audio.setPlaying(false);
    this.audio.seek(time, gen);
    // With split sources the audio side cannot follow a key-frame snap, so always seek exactly.
    const reallyExact = exact || this.sources.length > 1 || !this.hasVideo;
    for (const s of this.sources) s.start(gen, time, reallyExact);
    this.service();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.audio.setRate(rate);
  }

  setPitchCorrection(on: boolean): void {
    this.audio.setPitchCorrection(on);
  }

  frameStep(direction: 1 | -1): void {
    if (!this.hasVideo) return;
    this.wantPlay = false;
    if (direction > 0) {
      // Show the next decoded frame and pull the (held) clock up to it.
      this.showNext = true;
      this.presentDue();
      this.service();
      return;
    }
    const cur = this.current;
    if (!cur) return;
    const d = cur.duration || this.frameDur;
    const target = this.videoSemantics === 'next' ? cur.pts - 1.5 * d : cur.pts - 0.5 * d;
    this.seek(Math.max(0, target), true);
  }

  currentTime(): number {
    return clamp(this.audio.now(), 0, this.duration || Infinity);
  }

  stats(): PipelineStats {
    const st = this.st;
    const t = this.audio.now();
    const rep = this.audio.lastReport;
    const q = this.queue;
    st.queue = q.length;
    st.videoAhead = q.length ? Math.max(0, q[q.length - 1].pts - t) : 0;
    st.audioAhead = rep.buffered;
    st.underruns = rep.underruns;
    st.fps = this.presentTimes.length;
    st.framesAlive = frameLedger.opened - frameLedger.closed;
    st.hold = this.hold;
    const n = Math.min(this.driftN, DRIFT_WINDOW);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(this.drifts[i]);
      sum += a;
      if (a > max) max = a;
    }
    st.driftAvgMs = n ? sum / n : 0;
    st.driftMaxMs = max;
    return st;
  }

  /** Forget drift history (tests call this after a seek so the next window is clean). */
  resetDriftWindow(): void {
    this.driftN = 0;
    this.st.dropped = 0;
    this.st.delayed = 0;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    this.gen++;
    this.audio.setPlaying(false);
    for (const s of this.sources) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    this.flushQueue();
    if (this.current) {
      this.cb.forget();
      this.close(this.current);
      this.current = null;
    }
  }
}
