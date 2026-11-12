import type { ColorInfo, MediaInfo, MediaFrame } from '../core/types';
import { DEFAULT_COLOR } from '../core/types';

export interface ProbeResult {
  readable: boolean;
  info?: MediaInfo;
  /** null when there is no video track. */
  videoSupported?: boolean | null;
  audioSupport?: Record<number, boolean>;
  /** Whether every selected track can be carried in fragmented MP4 (pre-condition for the MSE tier). */
  muxable?: boolean;
  hasWebCodecs?: boolean;
  error?: string;
}

export interface DecodeConfig {
  video: boolean;
  audio: boolean;
  audioPort?: MessagePort;
  audioTrackId?: number;
  outSampleRate: number;
  planarHdr: boolean;
  maxQueue: number;
  softwareOnly?: boolean;
  /** Test hook: report a fatal video decode error after this many output frames. */
  faultAfterFrames?: number;
}

/** Main-thread handle on a media worker (mediabunny + WebCodecs). */
export class MediaWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (v: any) => void>();
  private thumbs = new Map<number, (v: { bitmap: ImageBitmap | null; time: number }) => void>();
  private color: ColorInfo = DEFAULT_COLOR;
  private rotation: 0 | 90 | 180 | 270 = 0;
  private dead = false;

  onFrame: (frame: MediaFrame, gen: number) => void = () => {};
  onEos: (kind: 'video' | 'audio', gen: number) => void = () => {};
  onStarted: (gen: number, time: number) => void = () => {};
  onError: (message: string, kind: string) => void = () => {};
  onStats: (s: { decodeLatencyMs: number; decodeQueue: number; softwareOnly: boolean }) => void = () => {};
  onNote: (message: string) => void = () => {};
  onSegment: (data: ArrayBuffer, gen: number) => void = () => {};
  onRemuxEos: (gen: number) => void = () => {};

  constructor() {
    this.worker = new Worker(new URL('./media-worker.ts', import.meta.url), { type: 'module', name: 'lumen-media' });
    this.worker.onmessage = (e) => this.handle(e.data);
    this.worker.onerror = (e) => this.onError(e.message || 'media worker crashed', 'worker');
  }

  private handle(m: any): void {
    switch (m.type) {
      case 'opened':
      case 'closed':
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
        break;
      case 'frame':
        if (this.dead) {
          m.frame.close();
          return;
        }
        this.onFrame(
          {
            kind: 'videoframe',
            pts: m.pts,
            duration: m.duration,
            width: m.frame.codedWidth,
            height: m.frame.codedHeight,
            frame: m.frame,
            color: this.color,
            rotation: this.rotation,
          },
          m.gen,
        );
        break;
      case 'planar':
        if (this.dead) return;
        this.onFrame(
          {
            kind: 'planar',
            pts: m.pts,
            duration: m.duration,
            width: m.width,
            height: m.height,
            bitDepth: m.bitDepth,
            planes: m.planes,
            chromaWidth: m.chromaWidth,
            chromaHeight: m.chromaHeight,
            color: m.color?.transfer && m.color.transfer !== 'unknown' ? m.color : this.color,
            rotation: this.rotation,
          },
          m.gen,
        );
        break;
      case 'eos':
        this.onEos(m.kind, m.gen);
        break;
      case 'started':
        this.onStarted(m.gen, m.time);
        break;
      case 'stats':
        this.onStats(m);
        break;
      case 'note':
        this.onNote(m.message);
        break;
      case 'error':
        this.onError(m.message, m.kind);
        break;
      case 'segment':
        this.onSegment(m.data, m.gen);
        break;
      case 'remux-eos':
        this.onRemuxEos(m.gen);
        break;
      case 'thumb': {
        const cb = this.thumbs.get(m.id);
        this.thumbs.delete(m.id);
        if (cb) cb({ bitmap: m.bitmap, time: m.time ?? 0 });
        else m.bitmap?.close();
        break;
      }
    }
  }

  private request<T>(msg: any): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ ...msg, id });
    });
  }

  async open(source: Blob | string): Promise<ProbeResult> {
    const r = await this.request<ProbeResult>({ type: 'open', source });
    if (r.info?.video) {
      this.color = r.info.video.color;
      this.rotation = r.info.video.rotation;
    }
    return r;
  }

  configure(cfg: DecodeConfig): void {
    const { audioPort, ...rest } = cfg;
    this.worker.postMessage({ type: 'configure', ...rest, audioPort }, audioPort ? [audioPort] : []);
  }

  start(gen: number, time: number, exact: boolean): void {
    this.worker.postMessage({ type: 'start', gen, time, exact });
  }

  go(gen: number): void {
    this.worker.postMessage({ type: 'go', gen });
  }

  tick(gen: number, clock: number, rate: number, playing: boolean, released: number): void {
    this.worker.postMessage({ type: 'tick', gen, clock, rate, playing, released });
  }

  stop(): void {
    this.worker.postMessage({ type: 'stop' });
  }

  remuxStart(gen: number, time: number, audioTrackId?: number): void {
    this.worker.postMessage({ type: 'remux-start', gen, time, audioTrackId });
  }

  remuxAck(gen: number): void {
    this.worker.postMessage({ type: 'remux-ack', gen });
  }

  remuxStop(): void {
    this.worker.postMessage({ type: 'remux-stop' });
  }

  /** Decode the key frame at/before `time`, scaled to `maxWidth`. Resolves null when unavailable. */
  thumbnail(time: number, maxWidth = 192): Promise<{ bitmap: ImageBitmap | null; time: number }> {
    if (this.dead) return Promise.resolve({ bitmap: null, time });
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.thumbs.set(id, resolve);
      this.worker.postMessage({ type: 'thumb', id, time, maxWidth });
    });
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.worker.postMessage({ type: 'close', id: 0 });
    } catch {
      /* ignore */
    }
    // Give the worker a beat to close decoders (which closes any frames still inside them).
    const w = this.worker;
    setTimeout(() => w.terminate(), 150);
    for (const cb of this.thumbs.values()) cb({ bitmap: null, time: 0 });
    this.thumbs.clear();
    for (const cb of this.pending.values()) cb({ readable: false });
    this.pending.clear();
  }
}
