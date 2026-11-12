/** Shared type vocabulary for the whole player. No runtime code besides tiny helpers. */

export type Tier = 'webcodecs' | 'mse' | 'wasm' | 'native';
export type TierRequest = Tier | 'auto';
export type RendererKind = 'webgpu' | 'webgl2' | 'canvas2d' | 'native';
export type RendererRequest = RendererKind | 'auto';

/** Concrete routing decision. `tier` is the headline; `mode` says exactly which plumbing is live. */
export type PipelineMode =
  | 'webcodecs' // mediabunny demux -> VideoDecoder/AudioDecoder
  | 'webcodecs+wasm-audio' // WebCodecs video, FFmpeg-WASM software audio decode
  | 'mse-remux' // mediabunny demux -> fMP4 mux -> MSE
  | 'wasm-sw' // FFmpeg-WASM software decode -> YUV planes + PCM
  | 'wasm-remux-mse' // FFmpeg-WASM stream-copy remux -> fMP4 -> MSE
  | 'wasm-transcode-mse' // FFmpeg-WASM video copy + audio transcode -> fMP4 -> MSE
  | 'native'; // <video src>

export interface RoutePlan {
  tier: Tier;
  mode: PipelineMode;
  reason: string;
}

export type Primaries = 'bt709' | 'bt601' | 'bt2020' | 'p3' | 'unknown';
export type Transfer = 'bt709' | 'srgb' | 'pq' | 'hlg' | 'linear' | 'unknown';
export type Matrix = 'bt709' | 'bt601' | 'bt2020nc' | 'rgb' | 'unknown';

export interface ColorInfo {
  primaries: Primaries;
  transfer: Transfer;
  matrix: Matrix;
  fullRange: boolean;
}

export const DEFAULT_COLOR: ColorInfo = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

export interface VideoTrackInfo {
  id: number;
  codec: string;
  codecString: string | null;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  rotation: 0 | 90 | 180 | 270;
  fps: number;
  bitDepth: number;
  pixFmt: string | null;
  color: ColorInfo;
  hdr: boolean;
}

export interface AudioTrackInfo {
  id: number;
  /** 0-based index among audio tracks (what ffmpeg calls a:N). */
  index: number;
  codec: string;
  codecString: string | null;
  sampleRate: number;
  channels: number;
  language: string;
  name: string | null;
}

export interface MediaInfo {
  container: string;
  demuxer: 'mediabunny' | 'ffmpeg' | 'native';
  /** Seconds. Player timeline is always rebased so that playback starts at 0. */
  duration: number;
  /** Container timestamp of the first sample (what was subtracted to rebase). */
  startTime: number;
  video: VideoTrackInfo | null;
  audio: AudioTrackInfo | null;
  audioTracks: AudioTrackInfo[];
  title: string | null;
  /** FFmpeg probes only: whether the loaded WASM core has a software decoder for each track. */
  softwareDecodable?: { video: boolean; audio: boolean };
}

/** Raw software-decoded picture: tightly packed 4:2:0 planes, 8-bit or little-endian 16-bit samples. */
export interface PlanarFrame {
  kind: 'planar';
  pts: number;
  duration: number;
  width: number;
  height: number;
  bitDepth: number;
  /** Y, U, V. For bitDepth > 8 each sample is 2 bytes LE. */
  planes: [Uint8Array, Uint8Array, Uint8Array];
  chromaWidth: number;
  chromaHeight: number;
  color: ColorInfo;
  rotation: 0 | 90 | 180 | 270;
}

/** Hardware/WebCodecs picture. Owns a VideoFrame which MUST be closed exactly once. */
export interface ExternalFrame {
  kind: 'videoframe';
  pts: number;
  duration: number;
  width: number;
  height: number;
  frame: VideoFrame;
  color: ColorInfo;
  rotation: 0 | 90 | 180 | 270;
}

/** A frame that lives inside a <video> element (MSE / native tiers). Nothing to close. */
export interface ElementFrame {
  kind: 'element';
  pts: number;
  duration: number;
  width: number;
  height: number;
  el: HTMLVideoElement;
  color: ColorInfo;
  rotation: 0 | 90 | 180 | 270;
}

export type MediaFrame = PlanarFrame | ExternalFrame | ElementFrame;

export type Scaler = 'bilinear' | 'bicubic' | 'lanczos' | 'fsr';
export type ToneMap = 'bt2390' | 'hable' | 'reinhard' | 'clip';

export interface RenderSettings {
  scaler: Scaler;
  deband: boolean;
  /** 0..1, 0 disables the RCAS pass. */
  sharpen: number;
  toneMapping: ToneMap;
  dither: boolean;
  /** Scale in linear light instead of gamma light. */
  linearScaling: boolean;
  /** Assumed mastering peak for HDR sources, in nits. */
  hdrPeak: number;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  scaler: 'bicubic',
  deband: false,
  sharpen: 0,
  toneMapping: 'bt2390',
  dither: true,
  linearScaling: false,
  hdrPeak: 1000,
};

export interface SubtitleTrackInfo {
  id: number;
  label: string;
  language: string;
  codec: 'ass' | 'srt' | 'vtt' | 'pgs';
  external: boolean;
}

export type PlayerStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export interface PlayerState {
  status: PlayerStatus;
  paused: boolean;
  buffering: boolean;
  ended: boolean;
  seeking: boolean;
  currentTime: number;
  duration: number;
  /** Seconds of media decoded/buffered ahead of the playhead. */
  bufferAhead: number;
  speed: number;
  volume: number;
  muted: boolean;
  title: string;
  mediaInfo: MediaInfo | null;
  tier: Tier | null;
  mode: PipelineMode | null;
  tierRequest: TierRequest;
  routeReason: string;
  renderer: RendererKind | null;
  rendererRequest: RendererRequest;
  rendererDetail: string;
  scaler: Scaler;
  deband: boolean;
  sharpen: number;
  toneMapping: ToneMap;
  dither: boolean;
  linearScaling: boolean;
  normalize: boolean;
  pitchCorrection: boolean;
  subTracks: SubtitleTrackInfo[];
  subTrack: number;
  subVisible: boolean;
  subDelay: number;
  audioTrack: number;
  abLoopA: number | null;
  abLoopB: number | null;
  loop: boolean;
  fullscreen: boolean;
  skin: string;
  stats: boolean;
  error: string | null;
}

export function closeFrame(f: MediaFrame | null | undefined): void {
  if (f && f.kind === 'videoframe') {
    try {
      f.frame.close();
    } catch {
      /* already closed */
    }
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function formatTime(t: number, withMs = false): string {
  if (!Number.isFinite(t)) return '--:--';
  const neg = t < 0;
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t * 1000) % 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  let out = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  if (withMs) out += `.${pad(ms, 3)}`;
  return (neg ? '-' : '') + out;
}
