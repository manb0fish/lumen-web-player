import type { ColorInfo, MediaFrame, MediaInfo } from '../core/types';
import type { FfmpegClient } from './ffmpeg-client';
import type { MediaWorkerClient } from './media-client';

/**
 * A FrameSource produces decoded video frames (pushed to the pipeline) and/or PCM (pushed straight
 * to the AudioWorklet). The sync engine combines one or two of them, e.g. WebCodecs video with
 * FFmpeg-WASM audio when only the audio codec is unsupported by the browser.
 */
export interface FrameSource {
  readonly name: string;
  readonly provides: { video: boolean; audio: boolean };
  /**
   * What an exact seek to T yields first:
   *  'containing' - the frame whose interval contains T (pts <= T),
   *  'next'       - the first frame with pts >= T.
   */
  readonly seekSemantics: 'containing' | 'next';
  /**
   * True when audio and video come out of one decoder in file order and share its back-pressure:
   * the source stops delivering audio while the picture queue is full (see FramePipeline).
   */
  readonly coupled?: boolean;
  onFrame: (frame: MediaFrame, gen: number) => void;
  onEos: (kind: 'video' | 'audio', gen: number) => void;
  /** Reports where playback really starts (key-frame time for inexact seeks). Needs `go()` to proceed. */
  onStarted: (gen: number, time: number, needsGo: boolean) => void;
  onError: (message: string, kind: string) => void;
  onStats: (s: { decodeLatencyMs?: number; decodeQueue?: number; note?: string }) => void;
  start(gen: number, time: number, exact: boolean): void;
  go(gen: number): void;
  tick(gen: number, clock: number, rate: number, playing: boolean, released: number): void;
  stop(): void;
  destroy(): void;
}

const noop = () => {};

/** Tier 1: mediabunny demux + WebCodecs decode in a worker. */
export class WebCodecsSource implements FrameSource {
  readonly name = 'webcodecs';
  readonly seekSemantics = 'containing' as const;
  onFrame: FrameSource['onFrame'] = noop;
  onEos: FrameSource['onEos'] = noop;
  onStarted: FrameSource['onStarted'] = noop;
  onError: FrameSource['onError'] = noop;
  onStats: FrameSource['onStats'] = noop;

  constructor(
    private client: MediaWorkerClient,
    readonly provides: { video: boolean; audio: boolean },
  ) {
    client.onFrame = (f, gen) => this.onFrame(f, gen);
    client.onEos = (kind, gen) => this.onEos(kind, gen);
    client.onStarted = (gen, time) => this.onStarted(gen, time, !this.lastExact);
    client.onError = (message, kind) => this.onError(message, kind);
    client.onStats = (s) => this.onStats(s);
    client.onNote = (note) => this.onStats({ note });
  }

  private lastExact = true;

  start(gen: number, time: number, exact: boolean): void {
    this.lastExact = exact;
    this.client.start(gen, time, exact);
  }
  go(gen: number): void {
    this.client.go(gen);
  }
  tick(gen: number, clock: number, rate: number, playing: boolean, released: number): void {
    this.client.tick(gen, clock, rate, playing, released);
  }
  stop(): void {
    this.client.stop();
  }
  destroy(): void {
    this.client.stop();
  }
}

/** Tier 3: FFmpeg-WASM software decode to raw planes / PCM. */
export class FfmpegSource implements FrameSource {
  readonly name = 'ffmpeg-wasm';
  readonly seekSemantics = 'next' as const;
  onFrame: FrameSource['onFrame'] = noop;
  onEos: FrameSource['onEos'] = noop;
  onStarted: FrameSource['onStarted'] = noop;
  onError: FrameSource['onError'] = noop;
  onStats: FrameSource['onStats'] = noop;

  private gen = -1;
  private eof = true;
  private busy = false;
  private segStart = 0;
  private segLen = 1;
  private lastClock = 0;
  private color: ColorInfo;
  private frameDur: number;
  private decodeMsPerFrame = 0;
  /** Seconds of decode pre-roll for containers whose seeks are not key-frame accurate in FFmpeg. */
  private preroll = 0;

  constructor(
    private client: FfmpegClient,
    private info: MediaInfo,
    readonly provides: { video: boolean; audio: boolean },
    private audioOut: { sampleRate: number; trackIndex: number },
    private maxQueue: number,
    private markAudioEos: (gen: number) => void,
    /** Added to player time to get FFmpeg time (non-zero when another demuxer defines the timeline). */
    private timeOffset = 0,
  ) {
    const v = info.video;
    this.color = v?.color ?? { primaries: 'unknown', transfer: 'unknown', matrix: 'unknown', fullRange: false };
    this.frameDur = 1 / (v?.fps || 30);
    // No key-frame index in these: FFmpeg's seek can land past the target, losing the frames in between.
    if (/mpegts|mpeg|m2ts|h264|hevc|flv|asf|rm|ogg|nut/i.test(info.container)) this.preroll = 3;
    // Without SAB each exec() covers a bounded slice, and everything it decodes arrives at once.
    // Longer slices waste less: a slice that starts inside a GOP has to decode from the previous
    // key frame again. So take as many frames as memory reasonably allows (two slices can be in
    // memory at a time): ~192 MB of frames on machines with 8 GB or more, ~96 MB otherwise.
    if (v) {
      const bytes = v.width * v.height * 1.5 * (v.bitDepth > 8 ? 2 : 1);
      const budget = ((navigator as { deviceMemory?: number }).deviceMemory ?? 4) >= 8 ? 192e6 : 96e6;
      const frames = Math.max(8, Math.min(96, Math.floor(budget / bytes)));
      this.segLen = Math.max(0.25, frames / (v.fps || 30));
    } else {
      this.segLen = 4;
    }
    client.onVideoFrame = (m) => {
      if (m.gen !== this.gen) return;
      const bps = m.bitDepth > 8 ? 2 : 1;
      const w = m.width;
      const h = m.height;
      const cw = (w + 1) >> 1;
      const ch = (h + 1) >> 1;
      const ySize = w * h * bps;
      const cSize = cw * ch * bps;
      const u8 = new Uint8Array(m.buffer);
      this.onFrame(
        {
          kind: 'planar',
          pts: m.pts,
          duration: this.frameDur,
          width: w,
          height: h,
          bitDepth: m.bitDepth,
          planes: [u8.subarray(0, ySize), u8.subarray(ySize, ySize + cSize), u8.subarray(ySize + cSize, ySize + 2 * cSize)],
          chromaWidth: cw,
          chromaHeight: ch,
          color: this.color,
          rotation: v?.rotation ?? 0,
        },
        m.gen,
      );
    };
    client.onDone = (m) => this.handleDone(m);
    client.onFailed = (message) => this.onError(message, 'ffmpeg');
  }

  get coupled(): boolean {
    return this.provides.video && this.provides.audio && this.client.shared;
  }

  private request(): void {
    if (this.busy || this.eof) return;
    const v = this.info.video;
    const a = this.info.audioTracks[this.audioOut.trackIndex] ?? this.info.audio;
    const shared = this.client.shared;
    const ffTime = Math.max(0, this.segStart + this.timeOffset);
    const pre = Math.min(ffTime, this.preroll);
    this.busy = true;
    this.client.decode({
      gen: this.gen,
      time: ffTime - pre,
      preroll: pre,
      basePts: ffTime - this.timeOffset,
      duration: shared ? undefined : this.segLen,
      total: this.info.duration,
      maxQueue: this.maxQueue,
      threads: Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 1)),
      eosAtEnd: shared,
      video: this.provides.video && v ? { index: 0, width: v.width, height: v.height, bitDepth: v.bitDepth, fps: v.fps } : undefined,
      audio:
        this.provides.audio && a
          ? { index: a.index, channels: Math.min(8, a.channels), sampleRate: this.audioOut.sampleRate, sourceRate: a.sampleRate }
          : undefined,
    });
  }

  private handleDone(m: any): void {
    // A stale job finished: nothing to do, the request for the current generation is already
    // queued behind it in the worker's mailbox.
    if (m.gen !== this.gen) return;
    this.busy = false;
    if (m.aborted) return;
    if (m.frames) this.decodeMsPerFrame = m.ms / m.frames;
    this.onStats({ decodeLatencyMs: this.decodeMsPerFrame });
    if (m.code !== 0 && !m.frames && !m.audioFrames) {
      this.eof = true;
      this.onError(`FFmpeg decode failed (exit ${m.code})${m.log ? ': ' + m.log : ''}`, 'ffmpeg');
      return;
    }
    if (this.client.shared) {
      this.finish();
      return;
    }
    this.segStart += this.segLen;
    const produced = (m.frames ?? 0) + (m.audioFrames ?? 0);
    if (this.segStart >= this.info.duration - 0.001 || produced === 0) this.finish();
    else this.maybeRequest();
  }

  private finish(): void {
    this.eof = true;
    if (this.provides.video) this.onEos('video', this.gen);
    if (this.provides.audio) {
      if (!this.client.shared) this.markAudioEos(this.gen);
      this.onEos('audio', this.gen);
    }
  }

  private maybeRequest(): void {
    // Keep roughly one segment decoded ahead of the playhead.
    if (this.segStart - this.lastClock < this.segLen * 0.75 + 0.35) this.request();
  }

  start(gen: number, time: number, _exact: boolean): void {
    this.gen = gen;
    this.eof = false;
    this.busy = false;
    this.segStart = time;
    this.lastClock = time;
    this.client.setGeneration(gen);
    this.client.updateClock(time, 0);
    this.onStarted(gen, time, false);
    this.request();
  }

  go(): void {}

  tick(gen: number, clock: number, _rate: number, _playing: boolean, released: number): void {
    if (gen !== this.gen) return;
    this.lastClock = clock;
    this.client.updateClock(clock, released);
    if (!this.client.shared) this.maybeRequest();
  }

  stop(): void {
    this.gen = -1;
    this.eof = true;
    this.client.setGeneration(-1);
  }

  destroy(): void {
    this.stop();
  }
}
