import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import coreMtURL from '@ffmpeg/core-mt?url';
import wasmMtURL from '@ffmpeg/core-mt/wasm?url';
// Emscripten's pthread bootstrap is a *classic* worker script; a dev server would rewrite it into
// a module, so take the source verbatim and hand it over as a Blob URL.
import workerMtSource from '@ffmpeg/core-mt/worker?raw';
import type { MediaInfo } from '../core/types';
import { CTRL_CLOCK_MS, CTRL_GEN, CTRL_LENGTH, CTRL_MSE_GATE, CTRL_RELEASED } from './ffmpeg-shared';

export interface FfmpegInitOptions {
  /** Use the pthread build (needs cross-origin isolation). */
  multiThread?: boolean;
}

export interface DecodeRequest {
  gen: number;
  /** Position in FFmpeg's own (file-start-relative) timeline. */
  time: number;
  /** Player-timeline PTS of the first frame/sample wanted (defaults to `time`). */
  basePts?: number;
  /**
   * Seconds to decode-and-discard before the wanted position. `time` is already reduced by this
   * amount; needed for containers without a key-frame index, where FFmpeg's seek may overshoot.
   */
  preroll?: number;
  duration?: number;
  /** Length of the whole file in seconds (lets the worker estimate where a slice lies in it). */
  total?: number;
  maxQueue: number;
  threads?: number;
  eosAtEnd?: boolean;
  video?: { index: number; width: number; height: number; bitDepth: number; fps: number };
  audio?: { index: number; channels: number; sampleRate: number; sourceRate: number };
}

export interface RemuxRequest {
  gen: number;
  time: number;
  duration?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioIndex: number;
  audioCodec?: string;
  transcodeAudio: boolean;
}

let workerMtBlobUrl: string | null = null;
function pthreadWorkerUrl(): string {
  workerMtBlobUrl ??= URL.createObjectURL(new Blob([workerMtSource], { type: 'text/javascript' }));
  return workerMtBlobUrl;
}

// Compiled modules are cached per page so respawning a worker costs an instantiate, not a 30 MB compile.
const compiledCache: { st?: WebAssembly.Module; mt?: WebAssembly.Module } = {};

/**
 * Main-thread handle on an FFmpeg-WASM worker. Thin: it owns the worker, the SharedArrayBuffer
 * control block and request plumbing. Policy (segmenting, EOS, MSE gating) lives in the adapters.
 */
export class FfmpegClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private ctrl: Int32Array | null = null;
  private source: { blob?: Blob; url?: string; ext: string } | null = null;
  multiThread = false;
  dead = false;

  onVideoFrame: (m: { gen: number; pts: number; width: number; height: number; bitDepth: number; buffer: ArrayBuffer }) => void = () => {};
  onChunk: (data: ArrayBuffer, gen: number) => void = () => {};
  onDone: (m: any) => void = () => {};
  onFailed: (message: string, gen?: number) => void = () => {};

  /** True when Atomics-based flow control and cancellation are available. */
  get shared(): boolean {
    return !!this.ctrl;
  }

  async init(opts: FfmpegInitOptions = {}): Promise<void> {
    const canShare = typeof SharedArrayBuffer !== 'undefined' && (globalThis as any).crossOriginIsolated === true;
    if (canShare && !this.ctrl) this.ctrl = new Int32Array(new SharedArrayBuffer(CTRL_LENGTH * 4));
    const wantMt = !!opts.multiThread && canShare;
    try {
      await this.spawn(wantMt);
    } catch (err) {
      if (!wantMt) throw err;
      // The pthread build is optional; fall back to the single-thread core.
      console.warn('[lumen] ffmpeg multi-thread core failed to start, using single-thread core', err);
      const dead = this.worker;
      this.worker = null;
      dead?.terminate();
      await this.spawn(false);
    }
  }

  private spawn(mt: boolean): Promise<void> {
    const worker = new Worker(new URL('./ffmpeg-worker.ts', import.meta.url), { type: 'module', name: 'lumen-ffmpeg' });
    this.worker = worker;
    this.multiThread = mt;
    worker.onmessage = (e) => {
      if (this.worker === worker) this.handle(e.data);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      if (this.worker !== worker) return; // a worker we already replaced
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'ffmpeg worker crashed'));
      this.pending.clear();
      this.onFailed(e.message || 'ffmpeg worker crashed');
    };
    const abs = (u: string) => new URL(u, location.href).href;
    const cached = mt ? compiledCache.mt : compiledCache.st;
    return this.request<any>({
      type: 'init',
      coreURL: abs(mt ? coreMtURL : coreURL),
      wasmURL: abs(mt ? wasmMtURL : wasmURL),
      workerURL: mt ? pthreadWorkerUrl() : undefined,
      multiThread: mt,
      sab: this.ctrl?.buffer,
      wasmModule: cached,
    }).then((r) => {
      if (r.wasmModule) {
        if (mt) compiledCache.mt = r.wasmModule;
        else compiledCache.st = r.wasmModule;
      }
    });
  }

  private handle(m: any): void {
    switch (m.type) {
      case 'ready':
      case 'opened':
      case 'probed': {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        p?.resolve(m);
        break;
      }
      case 'failed': {
        const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
        if (p) {
          this.pending.delete(m.id);
          p.reject(new Error(m.message));
        } else this.onFailed(m.message, m.gen);
        break;
      }
      case 'vframe':
        this.onVideoFrame(m);
        break;
      case 'chunk':
        this.onChunk(m.data, m.gen);
        break;
      case 'done':
        this.onDone(m);
        break;
    }
  }

  private request<T>(msg: any, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ ...msg, id }, transfer);
    });
  }

  /** How the input is being read (for the stats overlay and the notes). */
  io = '';

  async open(source: Blob | string, ext: string): Promise<void> {
    // The worker resolves the URL itself, and a worker's base URL is not the page's.
    this.source = typeof source === 'string' ? { url: new URL(source, location.href).href, ext } : { blob: source, ext };
    const r = await this.request<{ io?: string }>({ type: 'open', ...this.source });
    this.io = r.io ?? '';
  }

  async probe(): Promise<MediaInfo & { video: (MediaInfo['video'] & { ffIndex?: number }) | null }> {
    const r = await this.request<{ info: any }>({ type: 'probe' });
    return r.info;
  }

  setAudioPort(port: MessagePort): void {
    this.worker!.postMessage({ type: 'audio-port', port }, [port]);
  }

  /** Declare the generation that is allowed to run; any older job aborts at its next write. */
  setGeneration(gen: number): void {
    if (!this.ctrl) return;
    Atomics.store(this.ctrl, CTRL_GEN, gen);
    Atomics.store(this.ctrl, CTRL_RELEASED, 0);
    Atomics.store(this.ctrl, CTRL_MSE_GATE, 1);
    Atomics.notify(this.ctrl, CTRL_RELEASED);
    Atomics.notify(this.ctrl, CTRL_CLOCK_MS);
    Atomics.notify(this.ctrl, CTRL_MSE_GATE);
  }

  updateClock(clockSeconds: number, released: number): void {
    if (!this.ctrl) return;
    const ms = Math.round(clockSeconds * 1000);
    if (Atomics.load(this.ctrl, CTRL_CLOCK_MS) !== ms) {
      Atomics.store(this.ctrl, CTRL_CLOCK_MS, ms);
      Atomics.notify(this.ctrl, CTRL_CLOCK_MS);
    }
    if (Atomics.load(this.ctrl, CTRL_RELEASED) !== released) {
      Atomics.store(this.ctrl, CTRL_RELEASED, released);
      Atomics.notify(this.ctrl, CTRL_RELEASED);
    }
  }

  setMseGate(open: boolean): void {
    if (!this.ctrl) return;
    Atomics.store(this.ctrl, CTRL_MSE_GATE, open ? 1 : 0);
    if (open) Atomics.notify(this.ctrl, CTRL_MSE_GATE);
  }

  decode(req: DecodeRequest): void {
    this.worker?.postMessage({ type: 'decode', ...req });
  }

  remux(req: RemuxRequest): void {
    this.worker?.postMessage({ type: 'remux', ...req });
  }

  /**
   * Hard-cancel whatever the worker is doing by replacing it. Only needed without
   * SharedArrayBuffer, where a running exec() cannot be interrupted any other way. The audio port
   * is not carried over (a transferred port cannot be re-sent): callers re-issue setAudioPort().
   */
  async restart(): Promise<void> {
    if (this.dead) return;
    this.worker?.terminate();
    for (const p of this.pending.values()) p.reject(new Error('ffmpeg worker restarted'));
    this.pending.clear();
    await this.spawn(this.multiThread);
    if (this.source) this.io = (await this.request<{ io?: string }>({ type: 'open', ...this.source })).io ?? '';
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    if (this.ctrl) {
      // Unblock and abort a running exec so the worker is not left spinning before termination.
      Atomics.store(this.ctrl, CTRL_GEN, -1);
      Atomics.notify(this.ctrl, CTRL_RELEASED);
      Atomics.notify(this.ctrl, CTRL_CLOCK_MS);
      Atomics.notify(this.ctrl, CTRL_MSE_GATE);
    }
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error('ffmpeg client destroyed'));
    this.pending.clear();
  }
}
