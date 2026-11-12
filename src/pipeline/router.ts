import type { MediaInfo, RoutePlan, TierRequest } from '../core/types';
import type { ProbeResult } from './media-client';

export interface Capabilities {
  webcodecs: boolean;
  mse: boolean;
  /** SharedArrayBuffer usable (page is cross-origin isolated). */
  sab: boolean;
  webgpu: boolean;
  audioWorklet: boolean;
}

export function detectCapabilities(): Capabilities {
  const g = globalThis as any;
  return {
    webcodecs: typeof g.VideoDecoder === 'function' && typeof g.AudioDecoder === 'function',
    mse: typeof g.MediaSource === 'function' || typeof g.ManagedMediaSource === 'function',
    sab: typeof g.SharedArrayBuffer === 'function' && g.crossOriginIsolated === true,
    webgpu: !!g.navigator?.gpu,
    audioWorklet: typeof g.AudioWorkletNode === 'function',
  };
}

export type WasmMode = 'auto' | 'sw' | 'remux';

export function buildMime(info: MediaInfo): string | null {
  const v = info.video?.codecString ?? null;
  const a = info.audio?.codecString ?? null;
  if (info.video && !v) return null;
  if (info.audio && !a) return null;
  if (!info.video && !info.audio) return null;
  const codecs = [v, a].filter(Boolean).join(', ');
  return `${info.video ? 'video' : 'audio'}/mp4; codecs="${codecs}"`;
}

function mseSupports(mime: string | null): boolean {
  if (!mime) return false;
  const MS: any = (globalThis as any).ManagedMediaSource ?? (globalThis as any).MediaSource;
  try {
    return !!MS?.isTypeSupported?.(mime);
  } catch {
    return false;
  }
}

function single(kind: 'video' | 'audio', codec: string | null | undefined): boolean {
  return !!codec && mseSupports(`${kind}/mp4; codecs="${codec}"`);
}

/**
 * Ordered list of ways to play a file whose container mediabunny can read. The first entry is the
 * route to use; the rest are runtime fallbacks, tried in order if a pipeline fails fatally.
 *
 *   Tier 1  WebCodecs for everything the browser can decode
 *   Tier 2  MSE (on-the-fly fMP4 remux) when WebCodecs is missing or rejects a track
 *   Tier 3  FFmpeg-WASM: audio-only assist when just the audio codec is foreign,
 *           full software decode when the video codec is
 */
export function planReadable(probe: ProbeResult, request: TierRequest, caps: Capabilities, wasmMode: WasmMode): RoutePlan[] {
  const info = probe.info!;
  const v = info.video;
  const a = info.audio;
  const vOK = !v || probe.videoSupported === true;
  const aOK = !a || !!probe.audioSupport?.[a.id];
  const mime = buildMime(info);
  const mseOK = caps.mse && !!probe.muxable && mseSupports(mime);
  const what = [v ? v.codec : null, a ? a.codec : null].filter(Boolean).join(' + ');

  const wc: RoutePlan | null =
    caps.webcodecs && caps.audioWorklet && vOK && aOK
      ? { tier: 'webcodecs', mode: 'webcodecs', reason: `${info.container}: WebCodecs decodes ${what}` }
      : null;
  const hybrid: RoutePlan | null =
    caps.webcodecs && caps.audioWorklet && v && vOK && a && !aOK
      ? {
          tier: 'webcodecs',
          mode: 'webcodecs+wasm-audio',
          reason: `WebCodecs decodes ${v.codec}; ${a.codec} audio is not supported natively → FFmpeg-WASM audio decode`,
        }
      : null;
  const mse: RoutePlan | null = mseOK
    ? { tier: 'mse', mode: 'mse-remux', reason: `on-the-fly fMP4 remux of ${what} into Media Source Extensions` }
    : null;
  const sw: RoutePlan = {
    tier: 'wasm',
    mode: 'wasm-sw',
    reason: !vOK ? `${v!.codec} is not decodable by this browser → FFmpeg-WASM software decode` : `FFmpeg-WASM software decode of ${what}`,
  };
  const remuxViaWasm: RoutePlan | null =
    caps.mse && (!v || single('video', v.codecString)) && (!a || single('audio', a.codecString))
      ? { tier: 'wasm', mode: 'wasm-remux-mse', reason: `FFmpeg-WASM stream-copy remux of ${what} → fMP4 → MSE` }
      : caps.mse && v && single('video', v.codecString) && a
        ? { tier: 'wasm', mode: 'wasm-transcode-mse', reason: `FFmpeg-WASM: copy ${v.codec}, transcode ${a.codec} → AAC → fMP4 → MSE` }
        : null;
  const native: RoutePlan = { tier: 'native', mode: 'native', reason: 'native <video> element' };

  const pick = (...plans: Array<RoutePlan | null>) => plans.filter(Boolean) as RoutePlan[];
  switch (request) {
    case 'webcodecs':
      return pick(wc, hybrid);
    case 'mse':
      return pick(mse);
    case 'wasm':
      if (wasmMode === 'remux') return pick(remuxViaWasm);
      return pick(sw);
    case 'native':
      return [native];
    default:
      return pick(wc, mse, hybrid, sw, native);
  }
}

/** Routes for a container only FFmpeg can open (AVI, FLV, …), given FFmpeg's own probe. */
export function planForeign(info: MediaInfo, request: TierRequest, caps: Capabilities, wasmMode: WasmMode): RoutePlan[] {
  const v = info.video;
  const a = info.audio;
  const what = [v ? v.codec : null, a ? a.codec : null].filter(Boolean).join(' + ');
  const vMse = !v || single('video', v.codecString);
  const aMse = !a || single('audio', a.codecString);
  const plans: RoutePlan[] = [];
  if (request !== 'auto' && request !== 'wasm') return plans;
  if (wasmMode !== 'sw' && caps.mse && (v || a)) {
    if (vMse && aMse) {
      plans.push({
        tier: 'wasm',
        mode: 'wasm-remux-mse',
        reason: `${info.container} is not readable in JS → FFmpeg-WASM stream-copy remux of ${what} → fMP4 → MSE`,
      });
    } else if (v && vMse && a && !aMse) {
      plans.push({
        tier: 'wasm',
        mode: 'wasm-transcode-mse',
        reason: `${info.container}: copy ${v.codec}, transcode ${a.codec} → AAC with FFmpeg-WASM → fMP4 → MSE`,
      });
    }
  }
  if (wasmMode !== 'remux') {
    plans.push({
      tier: 'wasm',
      mode: 'wasm-sw',
      reason: !vMse && v ? `${v.codec} in ${info.container} → FFmpeg-WASM software decode` : `FFmpeg-WASM software decode of ${what}`,
    });
  }
  return plans;
}
