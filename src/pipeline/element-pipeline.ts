import type { AudioEngine } from '../audio/engine';
import type { ColorInfo, MediaInfo } from '../core/types';
import { clamp, DEFAULT_COLOR } from '../core/types';
import type { FfmpegClient } from './ffmpeg-client';
import type { MediaWorkerClient } from './media-client';
import { emptyStats, frameLedger, type Pipeline, type PipelineCallbacks, type PipelineStats } from './types';

/**
 * Something that can produce fragmented MP4 for a SourceBuffer, starting at (or at the key frame
 * before) a given time, with timestamps on the player timeline.
 */
export interface MseFeeder {
  readonly name: string;
  /**
   * Begin producing. `push` resolves once the bytes are appended and the buffer has room for more.
   * `done(error?)` is called once when the stream is complete or failed. `partial` marks a failure
   * that came after output had been produced: fatal only if none of that output is playable.
   */
  start(
    gen: number,
    time: number,
    push: (data: ArrayBuffer, gen: number) => Promise<void>,
    done: (gen: number, error?: string, partial?: boolean) => void,
  ): void;
  stop(): void | Promise<void>;
  destroy(): void;
}

/** Tier 2 feeder: mediabunny demux -> fMP4 mux in the media worker. */
export class MediabunnyFeeder implements MseFeeder {
  readonly name = 'mediabunny-remux';
  constructor(
    private client: MediaWorkerClient,
    private audioTrackId?: number,
  ) {}

  start(
    gen: number,
    time: number,
    push: (data: ArrayBuffer, gen: number) => Promise<void>,
    done: (gen: number, error?: string) => void,
  ): void {
    let chain: Promise<void> = Promise.resolve();
    this.client.onSegment = (data, g) => {
      chain = chain
        .then(() => push(data, g))
        .then(() => this.client.remuxAck(g))
        .catch(() => {});
    };
    this.client.onRemuxEos = (g) => {
      chain = chain.then(() => done(g));
    };
    this.client.onError = (message) => done(gen, message);
    this.client.remuxStart(gen, time, this.audioTrackId);
  }

  stop(): void {
    this.client.remuxStop();
  }

  destroy(): void {
    this.client.remuxStop();
  }
}

/** Tier 3 feeder: FFmpeg-WASM stream copy (optionally transcoding audio to AAC) -> fMP4. */
export class FfmpegFeeder implements MseFeeder {
  readonly name: string;
  private pendingPushes = 0;
  private running = false;

  constructor(
    private client: FfmpegClient,
    private info: MediaInfo,
    private audioIndex: number,
    private transcodeAudio: boolean,
  ) {
    this.name = transcodeAudio ? 'ffmpeg-transcode' : 'ffmpeg-remux';
  }

  start(
    gen: number,
    time: number,
    push: (data: ArrayBuffer, gen: number) => Promise<void>,
    done: (gen: number, error?: string, partial?: boolean) => void,
  ): void {
    let chain: Promise<void> = Promise.resolve();
    this.pendingPushes = 0;
    this.running = true;
    this.client.setGeneration(gen);
    this.client.onChunk = (data, g) => {
      if (g !== gen) return;
      this.pendingPushes++;
      // With SAB the worker blocks on this gate, so memory stays bounded.
      if (this.pendingPushes > 6) this.client.setMseGate(false);
      chain = chain
        .then(() => push(data, g))
        .catch(() => {})
        .then(() => {
          this.pendingPushes--;
          if (this.pendingPushes <= 2) this.client.setMseGate(true);
        });
    };
    this.client.onDone = (m) => {
      if (m.gen !== gen) return;
      this.running = false;
      if (m.aborted) return;
      // A run that fails near the end of a damaged file has still delivered nearly all of it, but
      // one that fails on its first packets (a stream copy the MP4 muxer refuses, such as video
      // without presentation timestamps) leaves an init segment and nothing to play. The byte
      // count cannot tell the two apart; the pipeline, which sees the buffer, can.
      const error = m.code !== 0 ? `FFmpeg remux failed (exit ${m.code})${m.log ? ': ' + m.log : ''}` : undefined;
      // Exit code -1 is the core's "never exited" value: FFmpeg died on an assertion or a trap
      // instead of leaving through its own exit path, so it cleaned nothing up and the instance
      // cannot run anything else, in particular not the software decode the player would fall
      // back to. Replace the worker before reporting.
      if (m.code === -1) chain = chain.then(() => this.client.restart().catch(() => {}));
      chain = chain.then(() => done(gen, error, !!m.bytes));
    };
    this.client.onFailed = (message) => done(gen, message);
    this.client.remux({
      gen,
      time,
      hasVideo: !!this.info.video,
      hasAudio: !!this.info.audio,
      audioIndex: this.audioIndex,
      audioCodec: (this.info.audioTracks[this.audioIndex] ?? this.info.audio)?.codec,
      transcodeAudio: this.transcodeAudio,
    });
  }

  async stop(): Promise<void> {
    this.client.onChunk = () => {};
    if (this.client.shared) {
      this.client.setGeneration(-1);
    } else if (this.running) {
      // No way to interrupt exec() without SAB: replace the worker.
      this.running = false;
      await this.client.restart().catch(() => {});
    }
    this.running = false;
  }

  destroy(): void {
    this.client.onChunk = () => {};
    this.client.setGeneration(-1);
  }
}

const MAX_AHEAD = 30; // seconds of media to keep buffered ahead of the playhead
const KEEP_BEHIND = 15;

export interface ElementPipelineOptions {
  mode: 'mse' | 'native';
  info: MediaInfo;
  audio: AudioEngine;
  cb: PipelineCallbacks;
  /** MSE only. */
  feeder?: MseFeeder;
  mime?: string;
  /** Native only. */
  url?: string;
  startTime?: number;
}

/**
 * Tier 2 (and the "native" last resort): a <video> element is decoder and clock. Frames are picked
 * up with requestVideoFrameCallback and handed to the same GPU renderer as the other tiers, so
 * shaders, scaling and subtitles behave identically. Audio is routed through the shared Web Audio
 * graph (normalizer, gain, analyser).
 */
export class ElementPipeline implements Pipeline {
  readonly kind = 'element' as const;
  readonly element: HTMLVideoElement;

  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private feedGen = 0;
  private destroyed = false;
  private wantPlay = false;
  private rvfc = 0;
  private st: PipelineStats = emptyStats();
  private presentTimes: number[] = [];
  private color: ColorInfo;
  private ready: Promise<void>;
  private pendingSeek: number | null = null;
  private waiters: Array<() => void> = [];
  private poll = 0;
  private lastState = '';
  private ended = false;
  private buffering = false;
  private seeking = false;
  private feedStart = 0;

  constructor(private o: ElementPipelineOptions) {
    const v = document.createElement('video');
    v.className = 'lp-native-video';
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.disablePictureInPicture = true;
    this.element = v;
    this.color = o.info.video?.color ?? DEFAULT_COLOR;
    v.addEventListener('waiting', () => this.setFlags({ buffering: true }));
    v.addEventListener('playing', () => this.setFlags({ buffering: false, ended: false }));
    v.addEventListener('canplay', () => this.setFlags({ buffering: false }));
    v.addEventListener('seeking', () => this.setFlags({ seeking: true }));
    v.addEventListener('seeked', () => this.setFlags({ seeking: false }));
    v.addEventListener('ended', () => this.setFlags({ ended: true }));
    v.addEventListener('timeupdate', () => this.wake());
    v.addEventListener('error', () => {
      if (this.destroyed) return;
      const e = v.error;
      this.o.cb.onError(e ? `media element error ${e.code}: ${e.message}` : 'media element error', 'element');
    });
    this.poll = window.setInterval(() => {
      this.wake();
      this.housekeeping();
    }, 250);
    this.ready = o.mode === 'mse' ? this.initMse() : this.initNative();
    this.ready.catch((err) => {
      if (!this.destroyed) this.o.cb.onError(err?.message ?? String(err), 'element');
    });
    this.armFrameCallback();
  }

  private setFlags(p: { buffering?: boolean; ended?: boolean; seeking?: boolean }): void {
    if (p.buffering !== undefined) this.buffering = p.buffering;
    if (p.ended !== undefined) this.ended = p.ended;
    if (p.seeking !== undefined) this.seeking = p.seeking;
    this.publish();
  }

  private publish(): void {
    const buffering = this.wantPlay && this.buffering && !this.ended;
    const key = `${this.wantPlay ? 1 : 0}${buffering ? 1 : 0}${this.ended ? 1 : 0}${this.seeking ? 1 : 0}`;
    if (key === this.lastState || this.destroyed) return;
    this.lastState = key;
    this.o.cb.onState({ paused: !this.wantPlay, buffering, ended: this.ended, seeking: this.seeking });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  private waitWake(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  private async initNative(): Promise<void> {
    const v = this.element;
    this.o.audio.attachElement(v);
    v.src = this.o.url!;
    if (this.o.startTime) v.currentTime = this.o.startTime;
  }

  private async initMse(): Promise<void> {
    const v = this.element;
    const MS: typeof MediaSource = (window as any).ManagedMediaSource ?? window.MediaSource;
    if (!MS) throw new Error('Media Source Extensions are not available');
    const ms = new MS();
    this.ms = ms;
    this.objectUrl = URL.createObjectURL(ms);
    if ((window as any).ManagedMediaSource && ms instanceof (window as any).ManagedMediaSource) (v as any).disableRemotePlayback = true;
    v.src = this.objectUrl;
    this.o.audio.attachElement(v);
    await new Promise<void>((resolve, reject) => {
      ms.addEventListener('sourceopen', () => resolve(), { once: true });
      v.addEventListener('error', () => reject(new Error('MediaSource failed to open')), { once: true });
    });
    if (this.destroyed) return;
    const sb = ms.addSourceBuffer(this.o.mime!);
    sb.mode = 'segments';
    this.sb = sb;
    sb.addEventListener('updateend', () => this.wake());
    sb.addEventListener('error', () => {
      if (!this.destroyed) this.o.cb.onError('SourceBuffer rejected the remuxed stream', 'mse');
    });
    if (Number.isFinite(this.o.info.duration) && this.o.info.duration > 0) {
      try {
        ms.duration = this.o.info.duration;
      } catch {
        /* ignore */
      }
    }
    const start = this.o.startTime ?? 0;
    this.startFeed(start);
    if (start > 0) v.currentTime = start;
  }

  private async idle(): Promise<void> {
    while (this.sb && this.sb.updating && !this.destroyed) await this.waitWake();
  }

  private bufferedAhead(): number {
    const v = this.element;
    const b = v.buffered;
    const t = v.currentTime;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.25 && t <= b.end(i) + 0.05) return b.end(i) - t;
    }
    return 0;
  }

  private isBuffered(time: number): boolean {
    const b = this.element.buffered;
    for (let i = 0; i < b.length; i++) if (time >= b.start(i) && time < b.end(i) - 0.2) return true;
    return false;
  }

  /**
   * If `time` falls in a small hole just before buffered media (typically the very start of a
   * stream whose first frame is not at exactly 0), return the first playable position after it.
   */
  private gapTarget(time: number): number | null {
    const b = this.element.buffered;
    for (let i = 0; i < b.length; i++) {
      const start = b.start(i);
      if (start > time && start - time < 0.5 && b.end(i) - start > 0.05) return start + 0.001;
    }
    return null;
  }

  private startFeed(time: number): void {
    const gen = ++this.feedGen;
    this.feedStart = time;
    this.o.feeder!.start(
      gen,
      time,
      (data, g) => this.append(data, g),
      (g, error, partial) => {
        if (g !== this.feedGen || this.destroyed) return;
        // Every append has settled by now (the feeder chains this call behind them), so an empty
        // buffer means the producer failed before it delivered anything playable.
        if (error && !(partial && this.element.buffered.length > 0)) {
          this.o.cb.onError(error, 'mse-feed');
          return;
        }
        void this.endOfStream(g);
      },
    );
  }

  private async endOfStream(gen: number): Promise<void> {
    await this.idle();
    if (gen !== this.feedGen || this.destroyed || !this.ms) return;
    try {
      if (this.ms.readyState === 'open') this.ms.endOfStream();
    } catch {
      /* ignore */
    }
  }

  private async append(data: ArrayBuffer, gen: number): Promise<void> {
    if (gen !== this.feedGen || this.destroyed) return;
    await this.idle();
    const sb = this.sb;
    if (!sb || gen !== this.feedGen || this.destroyed) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        sb.appendBuffer(data);
        break;
      } catch (err: any) {
        if (err?.name !== 'QuotaExceededError' || attempt === 2) throw err;
        await this.evict(true);
      }
    }
    await this.idle();
    // Hold the producer while we are comfortably ahead of the playhead.
    while (gen === this.feedGen && !this.destroyed && this.bufferedAhead() > MAX_AHEAD) await this.waitWake();
  }

  private async evict(force = false): Promise<void> {
    const sb = this.sb;
    if (!sb || sb.updating) return;
    const t = this.element.currentTime;
    const b = sb.buffered;
    if (!b.length) return;
    const start = b.start(0);
    const cut = t - (force ? 4 : KEEP_BEHIND);
    if (cut - start < (force ? 0.5 : 10)) return;
    try {
      sb.remove(start, cut);
      await this.idle();
    } catch {
      /* ignore */
    }
  }

  private housekeeping(): void {
    if (this.destroyed) return;
    if (this.o.mode === 'mse') {
      void this.evict(false);
      // Gap jumping: the element will wait forever in front of a hole, so step over small ones.
      const v = this.element;
      if (!this.reseeding && this.pendingSeek === null && v.readyState < 3 && (v.seeking || !v.paused)) {
        const hop = this.gapTarget(v.currentTime);
        if (hop !== null) v.currentTime = hop;
      }
      if (this.seeking && !v.seeking && !this.reseeding && this.pendingSeek === null) this.seeking = false;
    }
    this.publish();
  }

  private armFrameCallback(): void {
    const v = this.element as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: any) => void) => number };
    if (!v.requestVideoFrameCallback) {
      // No rVFC: poll with rAF (the renderer samples whatever the element currently shows).
      const loop = () => {
        if (this.destroyed) return;
        this.rvfc = requestAnimationFrame(loop);
        if (v.readyState >= 2 && v.videoWidth) this.presentElement(v.currentTime, v.videoWidth, v.videoHeight, 0);
      };
      this.rvfc = requestAnimationFrame(loop);
      return;
    }
    const onFrame = (_now: number, meta: any) => {
      if (this.destroyed) return;
      this.rvfc = v.requestVideoFrameCallback!(onFrame);
      this.presentElement(meta.mediaTime, meta.width, meta.height, meta.processingDuration ?? 0);
    };
    this.rvfc = v.requestVideoFrameCallback(onFrame);
  }

  private presentElement(mediaTime: number, width: number, height: number, processing: number): void {
    const v = this.element;
    this.o.cb.present({
      kind: 'element',
      el: v,
      pts: mediaTime,
      duration: 1 / (this.o.info.video?.fps || 30),
      width,
      height,
      color: this.color,
      rotation: 0,
    });
    const st = this.st;
    st.presented++;
    st.lastPts = mediaTime;
    st.driftMs = (v.currentTime - mediaTime) * 1000;
    if (processing) st.decodeLatencyMs = processing * 1000;
    const now = performance.now();
    this.presentTimes.push(now);
    while (this.presentTimes.length && now - this.presentTimes[0] > 1000) this.presentTimes.shift();
  }

  // ---- transport -------------------------------------------------------------------------------

  async play(): Promise<void> {
    this.wantPlay = true;
    this.publish();
    await this.ready.catch(() => {});
    if (this.destroyed || !this.wantPlay) return;
    if (this.ended && this.element.currentTime >= this.o.info.duration - 0.25) this.seek(0, true);
    try {
      await this.element.play();
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // superseded by pause()/seek
      this.wantPlay = false;
      this.publish();
      throw err;
    }
  }

  pause(): void {
    this.wantPlay = false;
    this.element.pause();
    this.publish();
  }

  seek(time: number, _exact: boolean): void {
    if (this.destroyed) return;
    time = clamp(time, 0, Math.max(0, this.o.info.duration));
    this.ended = false;
    const v = this.element;
    if (this.o.mode === 'native' || this.isBuffered(time)) {
      v.currentTime = time;
      this.publish();
      return;
    }
    const hop = this.gapTarget(time);
    if (hop !== null) {
      v.currentTime = hop;
      this.publish();
      return;
    }
    if (v.buffered.length === 0 && time >= this.feedStart && time - this.feedStart < 2) {
      // The feed that is already running starts right where we want to be; nothing to restart.
      v.currentTime = time;
      this.publish();
      return;
    }
    this.seeking = true;
    this.publish();
    this.pendingSeek = time;
    void this.reseed();
  }

  /** Throw away the buffer and restart the remux at the key frame before the pending seek target. */
  private reseeding = false;
  private async reseed(): Promise<void> {
    if (this.reseeding) return;
    this.reseeding = true;
    try {
      await this.ready.catch(() => {});
      while (this.pendingSeek !== null && !this.destroyed) {
        const time = this.pendingSeek;
        this.pendingSeek = null;
        ++this.feedGen;
        await this.o.feeder!.stop();
        const sb = this.sb;
        if (!sb || this.destroyed) return;
        await this.idle();
        try {
          if (this.ms?.readyState === 'open') sb.abort();
          await this.idle();
          sb.remove(0, Infinity);
          await this.idle();
        } catch {
          /* ignore */
        }
        if (this.pendingSeek !== null) continue; // a newer target arrived meanwhile
        this.startFeed(time);
        this.element.currentTime = time;
      }
    } finally {
      this.reseeding = false;
      // Assigning the position the element is already at fires no seeking/seeked events.
      if (!this.element.seeking && this.pendingSeek === null) this.setFlags({ seeking: false });
    }
  }

  setRate(rate: number): void {
    this.element.playbackRate = rate;
  }

  setPitchCorrection(on: boolean): void {
    (this.element as any).preservesPitch = on;
  }

  frameStep(direction: 1 | -1): void {
    this.pause();
    const d = 1 / (this.o.info.video?.fps || 30);
    const base = this.st.lastPts || this.element.currentTime;
    // Aim a quarter-frame into the neighbouring frame so rounding cannot land on the same picture.
    this.seek(Math.max(0, base + direction * d + d * 0.25), true);
  }

  currentTime(): number {
    return this.pendingSeek ?? this.element.currentTime;
  }

  stats(): PipelineStats {
    const st = this.st;
    const q = this.element.getVideoPlaybackQuality?.();
    if (q) st.dropped = q.droppedVideoFrames;
    st.fps = this.presentTimes.length;
    st.videoAhead = st.audioAhead = this.bufferedAhead();
    st.queue = 0;
    st.driftAvgMs = Math.abs(st.driftMs);
    st.driftMaxMs = Math.max(st.driftMaxMs, Math.abs(st.driftMs));
    st.framesAlive = frameLedger.opened - frameLedger.closed;
    st.hold = this.buffering ? 'element' : null;
    return st;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.poll);
    const v = this.element as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void };
    if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.rvfc);
    cancelAnimationFrame(this.rvfc);
    ++this.feedGen;
    this.wake();
    try {
      this.o.feeder?.destroy();
    } catch {
      /* ignore */
    }
    this.o.cb.forget();
    this.o.audio.detachElement();
    try {
      v.pause();
      v.removeAttribute('src');
      v.load();
    } catch {
      /* ignore */
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    v.remove();
    this.ms = null;
    this.sb = null;
  }
}
