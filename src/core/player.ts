import './stage.css';
import { AudioEngine } from '../audio/engine';
import { ElementPipeline, FfmpegFeeder, MediabunnyFeeder } from '../pipeline/element-pipeline';
import { FfmpegClient } from '../pipeline/ffmpeg-client';
import { FramePipeline } from '../pipeline/frame-pipeline';
import { MediaWorkerClient, type ProbeResult } from '../pipeline/media-client';
import { buildMime, detectCapabilities, planForeign, planReadable, type Capabilities, type WasmMode } from '../pipeline/router';
import { FfmpegSource, WebCodecsSource } from '../pipeline/sources';
import { frameLedger, type Pipeline, type PipelineCallbacks, type PipelineStats } from '../pipeline/types';
import { createRenderer, textureLedger, type Renderer } from '../render';
import { SubtitleManager } from '../subs/manager';
import { CommandBus } from './commands';
import { KeyBindings } from './keybindings';
import { Emitter, Store } from './store';
import {
  clamp,
  DEFAULT_RENDER_SETTINGS,
  formatTime,
  type MediaFrame,
  type MediaInfo,
  type PlayerState,
  type RendererKind,
  type RendererRequest,
  type RenderSettings,
  type RoutePlan,
  type Scaler,
  type TierRequest,
  type GamutMap,
  type ToneMap,
} from './types';

export interface PlayerOptions {
  /** Element the video stage is created in. */
  container: HTMLElement;
  renderer?: RendererRequest;
  tier?: TierRequest;
  /** Force a specific FFmpeg-WASM strategy (mostly for testing). */
  wasmMode?: WasmMode;
  /**
   * Multi-threaded FFmpeg core (needs a cross-origin isolated page). Default: on where the machine
   * has at least four logical cores; `false` forces the single-thread core.
   */
  wasmThreads?: boolean;
  /**
   * Tone-map HDR in our own shaders (default). `false` leaves HDR to the browser: frames are not
   * read back as planes, and what its GPU import returns is drawn as it comes.
   */
  hdrShader?: boolean;
  volume?: number;
  muted?: boolean;
  /** Element that goes fullscreen (defaults to the container). */
  fullscreenElement?: HTMLElement;
  /** Test hook: make the WebCodecs video decoder fail after N frames to exercise runtime tier fallback. */
  injectWebCodecsFaultAfter?: number;
}

export interface LoadOptions {
  title?: string;
  startTime?: number;
  autoplay?: boolean;
  tier?: TierRequest;
  wasmMode?: WasmMode;
}

export interface PlayerEvents {
  loaded: MediaInfo;
  ended: void;
  error: { message: string; fatal: boolean };
  osd: { text: string; duration: number };
  note: string;
  frame: { pts: number };
  fallback: { from: RoutePlan; to: RoutePlan; reason: string };
  screenshot: Blob;
  destroy: void;
}

export interface PlayerPlugin {
  name: string;
  /** Called once; may return a disposer. */
  install(player: Player): void | (() => void);
}

export interface PlayerStats {
  time: number;
  duration: number;
  speed: number;
  tier: string | null;
  mode: string | null;
  routeReason: string;
  renderer: string | null;
  rendererDetail: string;
  chain: string;
  /** How HDR frames decoded by the browser are being read; empty when none have been shown. */
  hdrHandover: string;
  container: string;
  video: string;
  audio: string;
  colorSpace: string;
  dimensions: { video: string; canvas: string; dpr: number };
  pipeline: PipelineStats | null;
  render: { texturesCreated: number; texturesDestroyed: number; framesRendered: number; lastRenderMs: number };
  audioEngine: { state: string; sampleRate: number; latencyMs: number; bufferedMs: number; underruns: number };
  subtitles: { engine: string; events: number; fonts: string[]; renders: number; completed: number; busySkips: number };
  frames: { opened: number; closed: number; alive: number };
  capabilities: Capabilities;
  jsHeapMB: number | null;
  notes: string[];
}

const SOURCE_EXT = /\.([a-z0-9]{2,5})(?:[?#].*)?$/i;

function initialState(o: PlayerOptions): PlayerState {
  return {
    status: 'idle',
    paused: true,
    buffering: false,
    ended: false,
    seeking: false,
    currentTime: 0,
    duration: 0,
    bufferAhead: 0,
    speed: 1,
    volume: o.volume ?? 100,
    muted: o.muted ?? false,
    title: '',
    mediaInfo: null,
    tier: null,
    mode: null,
    tierRequest: o.tier ?? 'auto',
    routeReason: '',
    renderer: null,
    rendererRequest: o.renderer ?? 'auto',
    rendererDetail: '',
    scaler: DEFAULT_RENDER_SETTINGS.scaler,
    deband: DEFAULT_RENDER_SETTINGS.deband,
    sharpen: DEFAULT_RENDER_SETTINGS.sharpen,
    toneMapping: DEFAULT_RENDER_SETTINGS.toneMapping,
    gamutMapping: DEFAULT_RENDER_SETTINGS.gamutMapping,
    dither: DEFAULT_RENDER_SETTINGS.dither,
    linearScaling: DEFAULT_RENDER_SETTINGS.linearScaling,
    normalize: false,
    pitchCorrection: true,
    subTracks: [],
    subTrack: -1,
    subVisible: true,
    subDelay: 0,
    audioTrack: 0,
    abLoopA: null,
    abLoopB: null,
    loop: false,
    fullscreen: false,
    skin: '',
    stats: false,
    error: null,
  };
}

/**
 * Headless player core. It has no UI of its own: everything is driven through
 *   - `store`    reactive state (subscribe / watch),
 *   - `commands` mpv-style command bus + properties,
 *   - `events`   one-shot notifications (OSD text, errors, loaded, ended …),
 *   - `use()`    plugins.
 * The bundled skins are just one consumer of this surface.
 */
export class Player {
  readonly store: Store<PlayerState>;
  readonly events = new Emitter<PlayerEvents>();
  readonly commands = new CommandBus();
  readonly keys = new KeyBindings();
  readonly audio = new AudioEngine();
  readonly subs: SubtitleManager;
  readonly stage: HTMLElement;
  readonly capabilities: Capabilities = detectCapabilities();

  private opts: PlayerOptions;
  private renderer: Renderer | null = null;
  private rendererBusy: Promise<void> = Promise.resolve();
  private pipeline: Pipeline | null = null;
  private media: MediaWorkerClient | null = null;
  private thumbs: MediaWorkerClient | null = null;
  private thumbsReady: Promise<boolean> | null = null;
  private ffmpeg: FfmpegClient | null = null;
  private ffmpegInfo: MediaInfo | null = null;
  private source: Blob | string | null = null;
  private sourceExt = 'bin';
  private objectUrl: string | null = null;
  private info: MediaInfo | null = null;
  private probe: ProbeResult | null = null;
  private plans: RoutePlan[] = [];
  private planIndex = 0;
  private loadToken = 0;
  private wasmMode: WasmMode;
  private settings: RenderSettings = { ...DEFAULT_RENDER_SETTINGS };
  private lastFrame: MediaFrame | null = null;
  private videoSize = { width: 0, height: 0 };
  private rect = { left: 0, top: 0, width: 0, height: 0 };
  private resizeObserver: ResizeObserver;
  private raf = 0;
  private lastStorePush = 0;
  private notes: string[] = [];
  private plugins: Array<{ name: string; dispose?: () => void }> = [];
  private destroyed = false;
  private wantPlay = false;
  private fallbackBusy = false;
  private subFetch: AbortController | null = null;
  private onFullscreenChange = () => this.store.set({ fullscreen: !!document.fullscreenElement });

  constructor(opts: PlayerOptions) {
    this.opts = opts;
    this.wasmMode = opts.wasmMode ?? 'auto';
    this.settings.externalHdr = opts.hdrShader !== false;
    this.store = new Store(initialState(opts));
    this.stage = document.createElement('div');
    this.stage.className = 'lp-stage';
    opts.container.appendChild(this.stage);
    this.subs = new SubtitleManager(this.stage);
    this.subs.onChange = () => this.store.set({ subTracks: this.subs.list(), subTrack: this.subs.activeId });
    this.subs.onError = (m) => this.note(m);
    this.audio.setVolume(this.gainFor(this.store.state.volume));
    this.audio.setMuted(this.store.state.muted);
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.stage);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.commands.onOsd = (text) => this.osd(text);
    this.commands.onError = (message) => this.osd(message, 2500);
    this.registerCommands();
    this.raf = requestAnimationFrame(this.tick);
  }

  // ================================================================================================
  // Loading & routing
  // ================================================================================================

  /** Load a URL or a File/Blob. Resolves when the first route is up (or rejects if none works). */
  async load(source: string | Blob, o: LoadOptions = {}): Promise<void> {
    const token = ++this.loadToken;
    await this.unload();
    if (token !== this.loadToken || this.destroyed) return;
    if (o.tier) this.store.set({ tierRequest: o.tier });
    if (o.wasmMode) this.wasmMode = o.wasmMode;
    const name = typeof source === 'string' ? source.split(/[?#]/)[0].split('/').pop() || source : ((source as File).name ?? 'media');
    this.source = source;
    this.sourceExt = (SOURCE_EXT.exec(name)?.[1] ?? 'bin').toLowerCase();
    this.notes = [];
    this.store.set({
      status: 'loading',
      title: o.title ?? decodeURIComponent(name),
      error: null,
      ended: false,
      paused: true,
      currentTime: 0,
      duration: 0,
      mediaInfo: null,
      tier: null,
      mode: null,
      routeReason: '',
      abLoopA: null,
      abLoopB: null,
    });
    try {
      await this.ensureRenderer();
      const media = new MediaWorkerClient();
      this.media = media;
      const probe = await media.open(source);
      if (token !== this.loadToken) return;
      this.probe = probe;
      const request = this.store.state.tierRequest;
      if (probe.readable && probe.info) {
        this.info = probe.info;
        this.plans = planReadable(probe, request, this.capabilities, this.wasmMode);
      } else {
        media.destroy();
        this.media = null;
        await this.ensureFfmpeg();
        if (token !== this.loadToken) return;
        this.info = this.ffmpegInfo!;
        this.plans = planForeign(this.info, request, this.capabilities, this.wasmMode);
      }
      if (!this.plans.length) {
        throw new Error(
          request === 'auto'
            ? 'No playable route for this file'
            : `The "${request}" tier cannot play this file (${this.describe(this.info)})`,
        );
      }
      await this.startPlan(0, o.startTime ?? 0, token);
      if (token !== this.loadToken) return;
      this.scanEmbeddedSubtitles(token);
      this.events.emit('loaded', this.info!);
      if (o.autoplay) await this.play();
    } catch (err: any) {
      if (token !== this.loadToken) return;
      this.fail(err?.message ?? String(err));
      throw err;
    }
  }

  private describe(info: MediaInfo | null): string {
    if (!info) return 'unknown';
    return [info.container, info.video?.codec, info.audio?.codec].filter(Boolean).join(' / ');
  }

  private async ensureFfmpeg(): Promise<FfmpegClient> {
    if (this.ffmpeg && !this.ffmpeg.dead) return this.ffmpeg;
    const ff = new FfmpegClient();
    this.ffmpeg = ff;
    this.note('loading FFmpeg WebAssembly core…');
    // Threads by default wherever they can work (the client falls back to the single-thread core
    // when the page is not cross-origin isolated or the pthread core fails to start).
    const threads = this.opts.wasmThreads ?? (navigator.hardwareConcurrency || 4) >= 4;
    await ff.init({ multiThread: threads });
    await ff.open(this.source!, this.sourceExt);
    this.ffmpegInfo = await ff.probe();
    this.note(
      `FFmpeg core ready (${ff.multiThread ? 'pthreads' : 'single-thread'}, ${ff.shared ? 'SharedArrayBuffer flow control' : 'segmented, no SharedArrayBuffer'})`,
    );
    if (ff.io) this.note(`FFmpeg input: ${ff.io}`);
    if (!ff.shared) {
      this.note('this page is not cross-origin isolated: FFmpeg decodes on one thread, in slices (guide: "Cross-origin isolation")');
    }
    return ff;
  }

  private async startPlan(index: number, time: number, token: number): Promise<void> {
    let lastError: any = null;
    for (let i = index; i < this.plans.length; i++) {
      const plan = this.plans[i];
      try {
        const pipeline = await this.buildPipeline(plan, time);
        if (token !== this.loadToken || this.destroyed) {
          await pipeline.destroy();
          return;
        }
        this.pipeline = pipeline;
        this.planIndex = i;
        const info = this.info!;
        pipeline.setRate(this.store.state.speed);
        pipeline.setPitchCorrection(this.store.state.pitchCorrection);
        this.attachElement(pipeline.element);
        this.videoSize = info.video ? { width: info.video.displayWidth, height: info.video.displayHeight } : { width: 0, height: 0 };
        this.layout();
        this.store.set({
          status: 'paused',
          mediaInfo: info,
          duration: info.duration,
          tier: plan.tier,
          mode: plan.mode,
          routeReason: plan.reason,
          audioTrack: info.audio?.index ?? 0,
          error: null,
        });
        this.note(`route: ${plan.mode} — ${plan.reason}`);
        return;
      } catch (err: any) {
        lastError = err;
        this.note(`${plan.mode} could not start: ${err?.message ?? err}`);
        const next = this.plans[i + 1];
        if (next) this.events.emit('fallback', { from: plan, to: next, reason: err?.message ?? String(err) });
      }
    }
    throw lastError ?? new Error('No pipeline could be started');
  }

  private queueDepth(info: MediaInfo): number {
    const px = (info.video?.width ?? 0) * (info.video?.height ?? 0);
    const fps = info.video?.fps ?? 30;
    const base = px > 3840 * 1200 ? 6 : px > 1920 * 800 ? 10 : 14;
    return Math.max(base, Math.ceil(fps * 0.25));
  }

  private async buildPipeline(plan: RoutePlan, time: number): Promise<Pipeline> {
    const cb = this.pipelineCallbacks();
    const audioIndex = this.store.state.audioTrack;
    switch (plan.mode) {
      case 'webcodecs': {
        const info = this.probe!.info!;
        this.info = info;
        const media = this.media!;
        const track = info.audioTracks[audioIndex] ?? info.audio;
        await this.audio.ensure(track?.sampleRate);
        this.audio.configure({ hasAudio: !!track, channels: track?.channels ?? 2 });
        const depth = this.queueDepth(info);
        media.configure({
          video: !!info.video,
          audio: !!track,
          audioPort: track ? this.audio.createDataPort() : undefined,
          audioTrackId: track?.id,
          outSampleRate: this.audio.sampleRate,
          planarHdr: !!info.video?.hdr && this.opts.hdrShader !== false,
          maxQueue: depth,
          faultAfterFrames: this.opts.injectWebCodecsFaultAfter,
        });
        const src = new WebCodecsSource(media, { video: !!info.video, audio: !!track });
        return new FramePipeline({ ...info, audio: track ?? null }, this.audio, [src], cb, depth, time);
      }
      case 'webcodecs+wasm-audio': {
        const info = this.probe!.info!;
        this.info = info;
        const media = this.media!;
        const ff = await this.ensureFfmpeg();
        const ffInfo = this.ffmpegInfo!;
        const track = ffInfo.audioTracks[audioIndex] ?? ffInfo.audio!;
        if (ffInfo.softwareDecodable && !ffInfo.softwareDecodable.audio) {
          throw new Error(`the FFmpeg WASM core has no software decoder for ${track.codec} audio`);
        }
        await this.audio.ensure(track.sampleRate);
        this.audio.configure({ hasAudio: true, channels: Math.min(8, track.channels) });
        const depth = this.queueDepth(info);
        ff.setAudioPort(this.audio.createDataPort());
        media.configure({
          video: true,
          audio: false,
          outSampleRate: this.audio.sampleRate,
          planarHdr: !!info.video?.hdr && this.opts.hdrShader !== false,
          maxQueue: depth,
        });
        const vsrc = new WebCodecsSource(media, { video: true, audio: false });
        const asrc = new FfmpegSource(
          ff,
          ffInfo,
          { video: false, audio: true },
          { sampleRate: this.audio.sampleRate, trackIndex: track.index },
          depth,
          (gen) => this.audio.markEos(gen),
          info.startTime - ffInfo.startTime,
        );
        return new FramePipeline(info, this.audio, [vsrc, asrc], cb, depth, time);
      }
      case 'wasm-sw': {
        const ff = await this.ensureFfmpeg();
        const info = this.ffmpegInfo!;
        if (info.video && info.softwareDecodable && !info.softwareDecodable.video) {
          throw new Error(`the FFmpeg WASM core has no software decoder for ${info.video.codec} video`);
        }
        this.info = info;
        const track = info.audioTracks[audioIndex] ?? info.audio;
        await this.audio.ensure(track?.sampleRate);
        this.audio.configure({ hasAudio: !!track, channels: Math.min(8, track?.channels ?? 2) });
        const depth = this.queueDepth(info);
        if (track) ff.setAudioPort(this.audio.createDataPort());
        const src = new FfmpegSource(
          ff,
          info,
          { video: !!info.video, audio: !!track },
          { sampleRate: this.audio.sampleRate, trackIndex: track?.index ?? 0 },
          depth,
          (gen) => this.audio.markEos(gen),
          // FFmpeg rebases onto the file's start time even when that is negative (codec priming);
          // keep the player origin at the first presentable sample, as in the other tiers.
          -Math.min(0, info.startTime),
        );
        return new FramePipeline({ ...info, audio: track ?? null }, this.audio, [src], cb, depth, time);
      }
      case 'mse-remux': {
        const info = this.probe!.info!;
        this.info = info;
        await this.audio.ensure();
        const mime = buildMime(info)!;
        const track = info.audioTracks[audioIndex] ?? info.audio;
        return new ElementPipeline({
          mode: 'mse',
          info,
          audio: this.audio,
          cb,
          feeder: new MediabunnyFeeder(this.media!, track?.id),
          mime,
          startTime: time,
        });
      }
      case 'wasm-remux-mse':
      case 'wasm-transcode-mse': {
        const ff = await this.ensureFfmpeg();
        const info = this.ffmpegInfo!;
        this.info = info;
        await this.audio.ensure();
        const transcode = plan.mode === 'wasm-transcode-mse';
        const mimeInfo: MediaInfo = transcode && info.audio ? { ...info, audio: { ...info.audio, codecString: 'mp4a.40.2' } } : info;
        const mime = buildMime(mimeInfo);
        if (!mime) throw new Error('Cannot derive an MSE codec string for this stream');
        return new ElementPipeline({
          mode: 'mse',
          info,
          audio: this.audio,
          cb,
          feeder: new FfmpegFeeder(ff, info, audioIndex, transcode),
          mime,
          startTime: time,
        });
      }
      case 'native': {
        const info: MediaInfo = this.info ?? {
          container: this.sourceExt,
          demuxer: 'native',
          duration: 0,
          startTime: 0,
          video: null,
          audio: null,
          audioTracks: [],
          title: null,
        };
        this.info = info;
        await this.audio.ensure();
        if (typeof this.source !== 'string') this.objectUrl = URL.createObjectURL(this.source as Blob);
        return new ElementPipeline({
          mode: 'native',
          info,
          audio: this.audio,
          cb,
          url: typeof this.source === 'string' ? this.source : this.objectUrl!,
          startTime: time,
        });
      }
    }
  }

  private pipelineCallbacks(): PipelineCallbacks {
    return {
      onState: (p) => this.onPipelineState(p),
      onError: (message, kind) => void this.onPipelineError(message, kind),
      onNote: (m) => this.note(m),
      present: (f) => this.present(f),
      forget: () => {
        this.renderer?.forget();
        this.lastFrame = null;
      },
      onRefresh: () => this.refreshSubtitles(),
    };
  }

  private onPipelineState(p: { paused?: boolean; buffering?: boolean; ended?: boolean; seeking?: boolean }): void {
    const s = this.store.state;
    const next = {
      paused: p.paused ?? s.paused,
      buffering: p.buffering ?? s.buffering,
      ended: p.ended ?? s.ended,
      seeking: p.seeking ?? s.seeking,
    };
    const status =
      s.status === 'loading' || s.status === 'error'
        ? s.status
        : next.ended
          ? 'ended'
          : next.paused
            ? 'paused'
            : next.buffering || next.seeking
              ? 'buffering'
              : 'playing';
    const justEnded = next.ended && !s.ended;
    this.store.set({ ...next, status });
    if (justEnded) {
      if (s.loop) {
        this.seek(0);
        void this.play();
      } else {
        this.wantPlay = false;
        this.events.emit('ended', undefined);
      }
    }
  }

  /** A pipeline died at runtime: move to the next route at the current position. */
  private async onPipelineError(message: string, kind: string): Promise<void> {
    if (this.destroyed || this.fallbackBusy) return;
    const from = this.plans[this.planIndex];
    const next = this.plans[this.planIndex + 1];
    this.note(`${from?.mode ?? 'pipeline'} error (${kind}): ${message}`);
    if (!next) {
      this.fail(message);
      return;
    }
    this.fallbackBusy = true;
    const token = this.loadToken;
    const time = this.pipeline?.currentTime() ?? 0;
    const resume = this.wantPlay;
    try {
      this.events.emit('fallback', { from, to: next, reason: message });
      this.osd(`${from.tier} failed → ${next.tier}`, 2500);
      await this.teardownPipeline();
      await this.startPlan(this.planIndex + 1, time, token);
      if (resume && token === this.loadToken) await this.play();
    } catch (err: any) {
      if (token === this.loadToken) this.fail(err?.message ?? String(err));
    } finally {
      this.fallbackBusy = false;
    }
  }

  private fail(message: string): void {
    this.store.set({ status: 'error', error: message, paused: true });
    this.events.emit('error', { message, fatal: true });
  }

  private note(message: string): void {
    this.notes.push(message);
    if (this.notes.length > 40) this.notes.shift();
    this.events.emit('note', message);
  }

  private scanEmbeddedSubtitles(token: number): void {
    const source = this.source;
    const container = this.info?.container ?? '';
    const matroska = /matroska|webm|mkv/i.test(container) || /^(mkv|webm|mka|mks|mk3d)$/.test(this.sourceExt);
    if (!matroska || !source) return;
    if (typeof source !== 'string') {
      void this.subs.attachContainer(source);
      return;
    }
    // URL source: fetch the file once in the background to scan it (the HTTP cache then serves playback).
    const ac = new AbortController();
    this.subFetch = ac;
    fetch(source, { signal: ac.signal })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((blob) => {
        if (token === this.loadToken && !this.destroyed) return this.subs.attachContainer(blob);
      })
      .catch((err) => {
        if (!ac.signal.aborted) this.note(`could not scan for embedded subtitles: ${err?.message ?? err}`);
      });
  }

  private async teardownPipeline(): Promise<void> {
    const p = this.pipeline;
    this.pipeline = null;
    if (p) {
      this.attachElement(null);
      await p.destroy();
    }
    this.lastFrame = null;
  }

  private async unload(): Promise<void> {
    this.wantPlay = false;
    this.subFetch?.abort();
    this.subFetch = null;
    await this.teardownPipeline();
    this.media?.destroy();
    this.media = null;
    this.thumbs?.destroy();
    this.thumbs = null;
    this.thumbsReady = null;
    this.ffmpeg?.destroy();
    this.ffmpeg = null;
    this.ffmpegInfo = null;
    this.probe = null;
    this.info = null;
    this.plans = [];
    this.planIndex = 0;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.subs.reset();
  }

  // ================================================================================================
  // Rendering
  // ================================================================================================

  private ensureRenderer(): Promise<void> {
    if (this.renderer || this.store.state.renderer === 'native') return this.rendererBusy;
    return this.setRenderer(this.store.state.rendererRequest);
  }

  /** Switch renderer at runtime. Degrades WebGPU → WebGL2 → Canvas2D if a context cannot be created. */
  setRenderer(request: RendererRequest): Promise<void> {
    this.rendererBusy = this.rendererBusy
      .catch(() => {})
      .then(async () => {
        if (this.destroyed) return;
        this.store.set({ rendererRequest: request });
        const old = this.renderer;
        if (request === 'native' && this.pipeline?.kind === 'element') {
          this.renderer = null;
          old?.destroy();
          this.store.set({ renderer: 'native', rendererDetail: 'HTMLVideoElement (browser compositor)' });
          this.attachElement(this.pipeline.element);
          this.layout();
          return;
        }
        const choice = await createRenderer(request === 'native' ? 'canvas2d' : request);
        if (this.destroyed) {
          choice.renderer.destroy();
          return;
        }
        for (const s of choice.skipped) this.note(`renderer ${s.kind} unavailable: ${s.reason}`);
        const r = choice.renderer;
        r.onLost = (reason) => {
          this.note(`${r.kind} context lost (${reason})`);
          const order: RendererKind[] = ['webgpu', 'webgl2', 'canvas2d'];
          const next = order[order.indexOf(r.kind) + 1] ?? 'canvas2d';
          void this.setRenderer(next as RendererRequest);
        };
        this.renderer = r;
        old?.destroy();
        this.stage.insertBefore(r.canvas, this.stage.querySelector('.lp-sub-canvas'));
        this.store.set({ renderer: r.kind, rendererDetail: r.detail });
        this.attachElement(this.pipeline?.element ?? null);
        this.layout();
        if (this.lastFrame) this.present(this.lastFrame);
      });
    return this.rendererBusy;
  }

  private attachElement(el: HTMLVideoElement | null): void {
    for (const v of Array.from(this.stage.querySelectorAll('video.lp-native-video'))) {
      if (v !== el) v.remove();
    }
    if (!el) return;
    if (el.parentElement !== this.stage) this.stage.insertBefore(el, this.stage.firstChild);
    // With a canvas renderer the element only feeds frames; in "native" mode it is the picture.
    el.classList.toggle('lp-native-visible', this.store.state.renderer === 'native');
  }

  private layout(): void {
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const { width: vw, height: vh } = this.videoSize;
    const canvas = this.renderer?.canvas;
    if (!W || !H) return;
    if (!vw || !vh) {
      if (canvas) canvas.style.display = 'none';
      return;
    }
    const scale = Math.min(W / vw, H / vh);
    const width = Math.max(1, Math.round(vw * scale));
    const height = Math.max(1, Math.round(vh * scale));
    const left = Math.round((W - width) / 2);
    const top = Math.round((H - height) / 2);
    this.rect = { left, top, width, height };
    if (canvas) {
      canvas.style.display = '';
      canvas.style.left = `${left}px`;
      canvas.style.top = `${top}px`;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const k = Math.min(1, 4096 / (width * dpr), 4096 / (height * dpr));
      this.renderer!.resize(Math.round(width * dpr * k), Math.round(height * dpr * k));
    }
    this.subs.layout(this.rect);
    if (this.lastFrame) this.subs.render(this.subTime(), vw, vh, true, true);
  }

  private present(frame: MediaFrame): void {
    this.lastFrame = frame;
    if (frame.kind !== 'planar' && frame.width && frame.height && !this.info?.video) {
      // Native route without probe data: learn the size from the first frame.
      this.videoSize = { width: frame.width, height: frame.height };
      this.layout();
    }
    this.renderer?.render(frame, this.settings);
    // While playing, subtitles are drawn once per display refresh (refreshSubtitles), right after
    // the picture. A lone frame — paused seek, frame step — gets its own settled render here.
    if (this.store.state.paused || !this.wantPlay) {
      this.subs.render(frame.pts, this.videoSize.width, this.videoSize.height, false, true);
    }
    this.events.emit('frame', { pts: frame.pts });
  }

  /**
   * Subtitle time for the picture currently on screen: follows the clock for smooth animation but
   * never leaves the displayed frame's own time interval, so events stay frame-accurate.
   */
  private subTime(): number {
    const t = this.pipeline?.currentTime() ?? 0;
    const f = this.lastFrame;
    if (!f) return t;
    return clamp(t, f.pts, f.pts + Math.max(0.004, f.duration) - 0.002);
  }

  /** One subtitle frame per display refresh while playing, timed to the picture now on screen. */
  private refreshSubtitles(): void {
    const s = this.store.state;
    if (s.paused || s.seeking || !this.wantPlay || !this.videoSize.width) return;
    this.subs.render(this.subTime(), this.videoSize.width, this.videoSize.height);
  }

  private tick = (now: number): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.tick);
    const p = this.pipeline;
    if (!p) return;
    const s = this.store.state;
    const t = p.currentTime();
    // Frame pipelines call refreshSubtitles() themselves right after presenting; for <video>-driven
    // pipelines the new frame (if any) was already delivered before animation-frame callbacks ran.
    if (p.kind === 'element') this.refreshSubtitles();
    if (s.abLoopA !== null && s.abLoopB !== null && !s.paused && t >= s.abLoopB) this.seek(s.abLoopA);
    if (now - this.lastStorePush > 100) {
      this.lastStorePush = now;
      const st = p.stats();
      this.store.set({ currentTime: t, bufferAhead: Math.max(st.videoAhead, st.audioAhead) });
    }
  };

  private applySettings(patch: Partial<RenderSettings>): void {
    Object.assign(this.settings, patch);
    if (this.lastFrame && this.renderer) this.renderer.render(this.lastFrame, this.settings);
  }

  // ================================================================================================
  // Transport
  // ================================================================================================

  get currentTime(): number {
    return this.pipeline?.currentTime() ?? 0;
  }

  get duration(): number {
    return this.store.state.duration;
  }

  get mediaInfo(): MediaInfo | null {
    return this.info;
  }

  async play(): Promise<void> {
    const p = this.pipeline;
    if (!p) return;
    this.wantPlay = true;
    const running = await this.audio.resume();
    if (!running) {
      this.wantPlay = false;
      this.osd('Audio is blocked by the browser — click to start playback', 4000);
      this.store.set({ paused: true, status: 'paused' });
      return;
    }
    try {
      await p.play();
    } catch (err: any) {
      this.wantPlay = false;
      this.osd(`Cannot start playback: ${err?.message ?? err}`, 3000);
    }
  }

  pause(): void {
    this.wantPlay = false;
    this.pipeline?.pause();
  }

  togglePause(): void {
    if (this.store.state.paused || this.store.state.ended) void this.play();
    else this.pause();
  }

  /** Seek to an absolute time in seconds. `exact: false` snaps to the previous key frame (fast scrubbing). */
  seek(time: number, exact = true): void {
    const p = this.pipeline;
    if (!p) return;
    const t = clamp(time, 0, Math.max(0, this.duration - 0.001));
    this.store.set({ currentTime: t, ended: false });
    p.seek(t, exact);
  }

  frameStep(direction: 1 | -1): void {
    this.wantPlay = false;
    this.pipeline?.frameStep(direction);
  }

  setSpeed(speed: number): void {
    const v = clamp(speed, 0.1, 8);
    this.store.set({ speed: v });
    this.pipeline?.setRate(v);
    this.audio.setRate(v);
  }

  private gainFor(volume: number): number {
    const x = clamp(volume, 0, 130) / 100;
    return x * x; // perceptual-ish taper; 100 → unity
  }

  setVolume(volume: number): void {
    const v = clamp(volume, 0, 130);
    this.store.set({ volume: v });
    this.audio.setVolume(this.gainFor(v));
  }

  setMuted(muted: boolean): void {
    this.store.set({ muted });
    this.audio.setMuted(muted);
  }

  /** Restart the current file on a different decode tier, keeping position and play state. */
  async setTier(request: TierRequest, wasmMode?: WasmMode): Promise<void> {
    const source = this.source;
    this.store.set({ tierRequest: request });
    if (wasmMode) this.wasmMode = wasmMode;
    if (!source) return;
    const time = this.currentTime;
    const resume = this.wantPlay;
    const subs = { visible: this.store.state.subVisible, delay: this.store.state.subDelay };
    await this.load(source, { startTime: time, autoplay: resume, title: this.store.state.title });
    this.subs.setVisible(subs.visible);
    this.subs.setDelay(subs.delay);
  }

  async setAudioTrack(index: number): Promise<void> {
    const info = this.info;
    if (!info || index < 0 || index >= info.audioTracks.length || index === this.store.state.audioTrack) return;
    const token = this.loadToken;
    const time = this.currentTime;
    const resume = this.wantPlay;
    this.store.set({ audioTrack: index });
    await this.teardownPipeline();
    await this.startPlan(this.planIndex, time, token);
    this.store.set({ audioTrack: index });
    if (resume) await this.play();
  }

  // ---- subtitles --------------------------------------------------------------------------------

  /** Add an external subtitle (ASS/SSA/SRT/WebVTT text, or a PGS .sup). Returns the track id. */
  async addSubtitle(input: File | { name: string; url?: string; text?: string; data?: Uint8Array }, select = true): Promise<number> {
    let name: string;
    let data: string | Uint8Array;
    if (input instanceof Blob) {
      name = (input as File).name ?? 'subtitle';
      data = new Uint8Array(await input.arrayBuffer());
    } else {
      name = input.name;
      if (input.text !== undefined) data = input.text;
      else if (input.data) data = input.data;
      else {
        const res = await fetch(input.url!);
        if (!res.ok) throw new Error(`HTTP ${res.status} while fetching ${input.url}`);
        data = new Uint8Array(await res.arrayBuffer());
      }
    }
    const id = this.subs.addExternal(name, data, select);
    await this.subs.settled();
    return id;
  }

  selectSubtitle(id: number): Promise<void> {
    return this.subs.select(id);
  }

  // ---- misc -------------------------------------------------------------------------------------

  osd(text: string, duration = 1400): void {
    this.events.emit('osd', { text, duration });
  }

  command(input: string | Array<string | number>): void {
    this.commands.run(input);
  }

  use(plugin: PlayerPlugin): this {
    if (this.plugins.some((p) => p.name === plugin.name)) return this;
    const dispose = plugin.install(this) ?? undefined;
    this.plugins.push({ name: plugin.name, dispose: dispose as (() => void) | undefined });
    return this;
  }

  /** Composite the current video frame (and optionally subtitles) into a PNG. */
  async screenshot(withSubs = true): Promise<Blob | null> {
    const base = this.snapshotCanvas(withSubs);
    if (!base) return null;
    return new Promise((resolve) => base.toBlob((b) => resolve(b), 'image/png'));
  }

  private snapshotCanvas(withSubs: boolean): HTMLCanvasElement | null {
    let base: HTMLCanvasElement | null = this.renderer?.snapshot() ?? null;
    if (!base && this.pipeline?.element && this.pipeline.element.videoWidth) {
      const el = this.pipeline.element;
      base = document.createElement('canvas');
      base.width = el.videoWidth;
      base.height = el.videoHeight;
      base.getContext('2d')!.drawImage(el, 0, 0);
    }
    if (!base) return null;
    if (withSubs) {
      const sub = this.subs.activeCanvas();
      if (sub && sub.width && sub.height) base.getContext('2d')!.drawImage(sub, 0, 0, base.width, base.height);
    }
    return base;
  }

  /** Key-frame thumbnail near `time` for seek-bar previews (null when the stream cannot be decoded natively). */
  async thumbnail(time: number, maxWidth = 192): Promise<{ bitmap: ImageBitmap | null; time: number }> {
    if (!this.probe?.readable || !this.probe.videoSupported || !this.source) return { bitmap: null, time };
    if (!this.thumbs) {
      this.thumbs = new MediaWorkerClient();
      this.thumbsReady = this.thumbs.open(this.source).then((r) => r.readable);
    }
    const client = this.thumbs;
    if (!(await this.thumbsReady)) return { bitmap: null, time };
    return client.thumbnail(time, maxWidth);
  }

  getStats(): PlayerStats {
    const s = this.store.state;
    const info = this.info;
    const v = info?.video;
    const a = info?.audio;
    const rs = this.renderer?.stats;
    const rep = this.audio.lastReport;
    const sub = this.subs.debug;
    const mem = (performance as any).memory;
    const c = v?.color;
    return {
      time: this.currentTime,
      duration: s.duration,
      speed: s.speed,
      tier: s.tier,
      mode: s.mode,
      routeReason: s.routeReason,
      renderer: s.renderer,
      rendererDetail: s.rendererDetail,
      chain: rs?.chain ?? (s.renderer === 'native' ? 'browser compositor' : 'idle'),
      hdrHandover: rs?.hdrHandover ?? '',
      container: info ? `${info.container} (${info.demuxer})` : '-',
      video: v
        ? `${v.codec} ${v.width}x${v.height} ${v.fps}fps ${v.bitDepth}-bit${v.codecString ? ' [' + v.codecString + ']' : ''}`
        : 'none',
      audio: a ? `${a.codec} ${a.sampleRate}Hz ${a.channels}ch${a.channels > 2 ? ' → stereo downmix' : ''}` : 'none',
      colorSpace: c ? `${c.matrix}/${c.primaries}/${c.transfer} ${c.fullRange ? 'full' : 'limited'}${v?.hdr ? ' HDR' : ''}` : '-',
      dimensions: {
        video: `${this.videoSize.width}x${this.videoSize.height}`,
        canvas: this.renderer ? `${this.renderer.canvas.width}x${this.renderer.canvas.height}` : '-',
        dpr: window.devicePixelRatio || 1,
      },
      pipeline: this.pipeline?.stats() ?? null,
      render: {
        texturesCreated: rs?.texturesCreated ?? 0,
        texturesDestroyed: rs?.texturesDestroyed ?? 0,
        framesRendered: rs?.framesRendered ?? 0,
        lastRenderMs: rs?.lastRenderMs ?? 0,
      },
      audioEngine: {
        state: this.audio.state,
        sampleRate: this.audio.sampleRate,
        latencyMs: this.audio.latency * 1000,
        bufferedMs: rep.buffered * 1000,
        underruns: rep.underruns,
      },
      subtitles: {
        engine: sub.engine,
        events: sub.events,
        fonts: sub.fonts,
        renders: sub.renders,
        completed: sub.completed,
        busySkips: sub.busySkips,
      },
      frames: { opened: frameLedger.opened, closed: frameLedger.closed, alive: frameLedger.opened - frameLedger.closed },
      capabilities: this.capabilities,
      jsHeapMB: mem ? mem.usedJSHeapSize / 1048576 : null,
      notes: [...this.notes],
    };
  }

  /** Introspection hooks used by the automated tests and handy from the console. */
  readonly debug = {
    /** Average RGB of normalised rectangles [x, y, w, h] of the video as currently rendered. */
    samplePixels: (rects: Array<[number, number, number, number]>, withSubs = false): Array<[number, number, number]> | null => {
      const c = this.snapshotCanvas(withSubs);
      if (!c) return null;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      return rects.map(([x, y, w, h]) => {
        const px = Math.max(1, Math.round(w * c.width));
        const py = Math.max(1, Math.round(h * c.height));
        const d = ctx.getImageData(Math.round(x * c.width), Math.round(y * c.height), px, py).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        const n = d.length / 4;
        return [r / n, g / n, b / n];
      });
    },
    /** Mean luma and standard deviation of the rendered video (non-black check). */
    frameStats: (): { mean: number; stdev: number; width: number; height: number } | null => {
      const c = this.snapshotCanvas(false);
      if (!c) return null;
      const small = document.createElement('canvas');
      small.width = 64;
      small.height = 36;
      const ctx = small.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(c, 0, 0, 64, 36);
      const d = ctx.getImageData(0, 0, 64, 36).data;
      let sum = 0;
      let sq = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += y;
        sq += y * y;
      }
      const mean = sum / n;
      return { mean, stdev: Math.sqrt(Math.max(0, sq / n - mean * mean)), width: c.width, height: c.height };
    },
    /** Fraction of non-transparent pixels in normalised rectangles of the subtitle overlay, plus their mean colour. */
    sampleSubtitles: (
      rects: Array<[number, number, number, number]>,
    ): Array<{ coverage: number; rgb: [number, number, number] }> | null => {
      const sub = this.subs.activeCanvas();
      if (!sub || !sub.width || !sub.height) return null;
      const c = document.createElement('canvas');
      c.width = sub.width;
      c.height = sub.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(sub, 0, 0);
      return rects.map(([x, y, w, h]) => {
        const px = Math.max(1, Math.round(w * c.width));
        const py = Math.max(1, Math.round(h * c.height));
        const d = ctx.getImageData(Math.round(x * c.width), Math.round(y * c.height), px, py).data;
        let hit = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 24) {
            hit++;
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
          }
        }
        const n = d.length / 4;
        return { coverage: hit / n, rgb: hit ? [r / hit, g / hit, b / hit] : [0, 0, 0] };
      });
    },
    /** Bounding box (normalised) of everything currently drawn on the subtitle overlay, or null if empty. */
    subtitleBounds: (): { x: number; y: number; w: number; h: number; coverage: number } | null => {
      const sub = this.subs.activeCanvas();
      if (!sub || !sub.width || !sub.height) return null;
      const c = document.createElement('canvas');
      c.width = sub.width;
      c.height = sub.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(sub, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let x0 = c.width;
      let y0 = c.height;
      let x1 = -1;
      let y1 = -1;
      let hit = 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] > 24) {
            hit++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return null;
      return {
        x: x0 / c.width,
        y: y0 / c.height,
        w: (x1 - x0 + 1) / c.width,
        h: (y1 - y0 + 1) / c.height,
        coverage: hit / (c.width * c.height),
      };
    },
    lastPresentedPts: (): number => this.lastFrame?.pts ?? -1,
    textureLedger,
    resetDrift: (): void => {
      (this.pipeline as any)?.resetDriftWindow?.();
    },
    frameLedger,
  };

  // ================================================================================================
  // Commands & properties (mpv vocabulary)
  // ================================================================================================

  private registerCommands(): void {
    const c = this.commands;
    const s = () => this.store.state;
    const bool = (name: string, get: () => boolean, set: (v: boolean) => void, label = name) =>
      c.defineProperty(name, { type: 'bool', get, set, osd: (v) => `${label}: ${v ? 'yes' : 'no'}` });

    c.defineProperty('pause', {
      type: 'bool',
      get: () => s().paused || s().ended,
      set: (v) => (v ? this.pause() : void this.play()),
      osd: () => null,
    });
    c.defineProperty('speed', {
      type: 'number',
      min: 0.1,
      max: 8,
      get: () => s().speed,
      set: (v) => this.setSpeed(v),
      osd: (v) => `Speed: ${Number(v).toFixed(2)}x`,
    });
    c.defineProperty('volume', {
      type: 'number',
      min: 0,
      max: 130,
      get: () => s().volume,
      set: (v) => this.setVolume(v),
      osd: (v) => `Volume: ${Math.round(v)}%`,
    });
    bool(
      'mute',
      () => s().muted,
      (v) => this.setMuted(v),
      'Mute',
    );
    c.defineProperty('time-pos', { type: 'number', get: () => this.currentTime, set: (v) => this.seek(v), osd: () => null });
    c.defineProperty('percent-pos', {
      type: 'number',
      get: () => (this.duration ? (this.currentTime / this.duration) * 100 : 0),
      set: (v) => this.seek((v / 100) * this.duration),
      osd: () => null,
    });
    c.defineProperty('duration', { type: 'number', get: () => this.duration });
    c.defineProperty('sub-delay', {
      type: 'number',
      get: () => s().subDelay,
      set: (v) => {
        this.store.set({ subDelay: v });
        this.subs.setDelay(v);
      },
      osd: (v) => `Sub delay: ${Math.round(v * 1000)} ms`,
    });
    bool(
      'sub-visibility',
      () => s().subVisible,
      (v) => {
        this.store.set({ subVisible: v });
        this.subs.setVisible(v);
      },
      'Subtitles',
    );
    c.defineProperty('sid', {
      type: 'choice',
      choices: () => ['no', ...s().subTracks.map((t) => String(t.id))],
      get: () => (s().subTrack < 0 ? 'no' : String(s().subTrack)),
      set: (v) => void this.subs.select(v === 'no' ? -1 : Number(v)),
      osd: (v) => {
        const t = s().subTracks.find((x) => String(x.id) === String(v));
        return `Subtitles: ${t ? t.label : 'off'}`;
      },
    });
    c.defineProperty('aid', {
      type: 'choice',
      choices: () => (this.info?.audioTracks ?? []).map((t) => String(t.index)),
      get: () => String(s().audioTrack),
      set: (v) => void this.setAudioTrack(Number(v)),
      osd: (v) => {
        const t = this.info?.audioTracks[Number(v)];
        return t ? `Audio: #${t.index + 1} ${t.language} ${t.codec} ${t.channels}ch` : 'Audio: -';
      },
    });
    bool(
      'fullscreen',
      () => s().fullscreen,
      (v) => {
        const el = this.opts.fullscreenElement ?? this.opts.container;
        if (v && !document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
        else if (!v && document.fullscreenElement) void document.exitFullscreen();
      },
      'Fullscreen',
    );
    bool(
      'loop-file',
      () => s().loop,
      (v) => this.store.set({ loop: v }),
      'Loop',
    );
    bool(
      'deband',
      () => s().deband,
      (v) => {
        this.store.set({ deband: v });
        this.applySettings({ deband: v });
      },
      'Deband',
    );
    c.defineProperty('sharpen', {
      type: 'number',
      min: 0,
      max: 1,
      step: 0.25,
      get: () => s().sharpen,
      set: (v) => {
        this.store.set({ sharpen: v });
        this.applySettings({ sharpen: v });
      },
      osd: (v) => `Sharpen: ${Number(v).toFixed(2)}`,
    });
    c.defineProperty('scale', {
      type: 'choice',
      choices: () => ['bilinear', 'bicubic', 'lanczos', 'fsr'],
      get: () => s().scaler,
      set: (v: Scaler) => {
        this.store.set({ scaler: v });
        this.applySettings({ scaler: v });
      },
      osd: (v) => `Scaler: ${v}`,
    });
    c.defineProperty('tone-mapping', {
      type: 'choice',
      choices: () => ['bt2390', 'hable', 'reinhard', 'clip'],
      get: () => s().toneMapping,
      set: (v: ToneMap) => {
        this.store.set({ toneMapping: v });
        this.applySettings({ toneMapping: v });
      },
      osd: (v) => `Tone mapping: ${v}`,
    });
    c.defineProperty('gamut-mapping', {
      type: 'choice',
      choices: () => ['soft', 'clip'],
      get: () => s().gamutMapping,
      set: (v: GamutMap) => {
        this.store.set({ gamutMapping: v });
        this.applySettings({ gamutMapping: v });
      },
      osd: (v) => `Gamut mapping: ${v}`,
    });
    bool(
      'dither',
      () => s().dither,
      (v) => {
        this.store.set({ dither: v });
        this.applySettings({ dither: v });
      },
      'Dither',
    );
    bool(
      'linear-scaling',
      () => s().linearScaling,
      (v) => {
        this.store.set({ linearScaling: v });
        this.applySettings({ linearScaling: v });
      },
      'Linear-light scaling',
    );
    c.defineProperty('renderer', {
      type: 'choice',
      choices: () => ['webgpu', 'webgl2', 'canvas2d'],
      get: () => s().renderer ?? 'webgpu',
      set: (v: RendererRequest) => void this.setRenderer(v).then(() => this.osd(`Renderer: ${this.store.state.renderer}`)),
      osd: () => null,
    });
    c.defineProperty('tier', {
      type: 'choice',
      choices: () => ['auto', 'webcodecs', 'mse', 'wasm'],
      get: () => s().tierRequest,
      set: (v: TierRequest) =>
        void this.setTier(v).then(
          () => this.osd(`Decode tier: ${this.store.state.tier} (${this.store.state.mode})`, 2200),
          (err) => this.osd(String(err?.message ?? err), 3000),
        ),
      osd: () => null,
    });
    bool(
      'audio-normalize',
      () => s().normalize,
      (v) => {
        this.store.set({ normalize: v });
        this.audio.setNormalize(v);
      },
      'Gain normalization',
    );
    bool(
      'audio-pitch-correction',
      () => s().pitchCorrection,
      (v) => {
        this.store.set({ pitchCorrection: v });
        this.audio.setPitchCorrection(v);
        this.pipeline?.setPitchCorrection(v);
      },
      'Pitch correction',
    );
    c.defineProperty('stats', { type: 'bool', get: () => s().stats, set: (v) => this.store.set({ stats: v }), osd: () => null });
    c.defineProperty('ab-loop-a', {
      type: 'number',
      get: () => s().abLoopA ?? -1,
      set: (v) => this.store.set({ abLoopA: v < 0 ? null : v }),
    });
    c.defineProperty('ab-loop-b', {
      type: 'number',
      get: () => s().abLoopB ?? -1,
      set: (v) => this.store.set({ abLoopB: v < 0 ? null : v }),
    });

    c.register('seek', ([target, ...flags]) => {
      const v = Number(target);
      if (!Number.isFinite(v)) throw new Error(`bad seek target "${target}"`);
      const f = new Set(flags.join('+').split('+').filter(Boolean));
      let t: number;
      if (f.has('absolute-percent')) t = (v / 100) * this.duration;
      else if (f.has('relative-percent')) t = this.currentTime + (v / 100) * this.duration;
      else if (f.has('absolute')) t = v;
      else t = this.currentTime + v;
      t = clamp(t, 0, this.duration);
      this.seek(t, !f.has('keyframes'));
      if (!f.has('quiet')) this.osd(`${formatTime(t)} / ${formatTime(this.duration)}`);
    });
    c.register('frame-step', () => {
      this.frameStep(1);
    });
    c.register('frame-back-step', () => {
      this.frameStep(-1);
    });
    c.register('ab-loop', () => {
      const { abLoopA, abLoopB } = s();
      const t = this.currentTime;
      if (abLoopA === null) {
        this.store.set({ abLoopA: t, abLoopB: null });
        this.osd(`A-B loop: A = ${formatTime(t, true)}`);
      } else if (abLoopB === null && t > abLoopA + 0.05) {
        this.store.set({ abLoopB: t });
        this.osd(`A-B loop: ${formatTime(abLoopA, true)} – ${formatTime(t, true)}`);
      } else {
        this.store.set({ abLoopA: null, abLoopB: null });
        this.osd('A-B loop: cleared');
      }
    });
    c.register('screenshot', async ([mode]) => {
      const blob = await this.screenshot(mode !== 'video');
      if (blob) {
        this.events.emit('screenshot', blob);
        this.osd('Screenshot saved');
      }
    });
    c.register('show-text', ([text, ms]) => this.osd(text ?? '', ms ? Number(ms) : 1400));
    c.register('loadfile', ([url]) => this.load(url, { autoplay: true }));
    c.register('sub-add', async ([url]) => {
      await this.addSubtitle({ name: url.split('/').pop() ?? 'subtitle', url });
    });
    c.register('stop', () => this.unload().then(() => this.store.set({ status: 'idle', mediaInfo: null, duration: 0, currentTime: 0 })));
    c.register('quit', () => this.destroy());
    c.register('play', () => this.play());
    c.register('playpause', () => this.togglePause());
  }

  // ================================================================================================

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.loadToken++;
    await this.unload();
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    for (const p of this.plugins.splice(0)) {
      try {
        p.dispose?.();
      } catch {
        /* ignore */
      }
    }
    await this.rendererBusy.catch(() => {});
    this.renderer?.destroy();
    this.renderer = null;
    await this.subs.destroy();
    await this.audio.destroy();
    this.events.emit('destroy', undefined);
    this.events.clear();
    this.stage.remove();
  }
}
