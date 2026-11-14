import type { ColorInfo, MediaFrame } from '../core/types';
import { type ExternalPacking, hdrToRelativeLight, isHdrTransfer, lumaWeights, srgbEotf, unpackExternal } from './color';

/**
 * HDR frames that the browser decoded: what did it hand over?
 *
 * A VideoFrame or a <video> element reaches the GPU through the browser's own import
 * (importExternalTexture, texImage2D), and for HDR that import is not what it is for SDR. Measured
 * in Chromium (Edge on Windows, hardware-decoded HEVC / AV1 / VP9, PQ and HLG):
 *
 *   WebGPU     sRGB-OETF( primaries->sRGB matrix x coded R'G'B' )   no EOTF, no tone mapping
 *   WebGL2     coded R'G'B', 8 bit                                   nothing but the Y'CbCr matrix
 *   Canvas 2D  tone-mapped SDR                                       the browser's real conversion
 *
 * So the two GPU paths show PQ code values as if they were SDR: flat, grey and desaturated. Both
 * are exactly reversible, and once reversed the samples go through the same colour pipeline as
 * software-decoded frames (see `colorManage` in the shaders).
 *
 * None of this is specified anywhere, and frames that live in CPU memory take other paths, so the
 * renderer does not just assume it. It starts from the packing its API is known to produce and
 * then checks that against the one conversion that is the browser's considered opinion, the 2D
 * canvas: a few hundred pixels of the same frame are read both ways, and a packing is accepted
 * only if the light it implies is, in the mid-tones, a constant multiple of what the canvas shows
 * (tone-mapping curves are straight lines there; they differ in the highlights). If the import
 * already equals the canvas, or matches nothing we know, the frame is left as the browser made it.
 */

/** The probe reads PROBE_TILES x PROBE_TILES tiles of PROBE_TILE x PROBE_TILE source pixels, 1:1. */
export const PROBE_TILES = 4;
export const PROBE_TILE = 16;
export const PROBE_SIZE = PROBE_TILES * PROBE_TILE;

export interface ProbeOrigins {
  x: [number, number, number, number];
  y: [number, number, number, number];
}

/** Top-left corners of the probed tiles, spread evenly over a picture of the given size. */
export function probeOrigins(width: number, height: number): ProbeOrigins | null {
  if (width < PROBE_SIZE || height < PROBE_SIZE) return null;
  const at = (i: number, size: number) =>
    Math.min(size - PROBE_TILE, Math.max(0, Math.floor(((i + 0.5) * size) / PROBE_TILES - PROBE_TILE / 2)));
  return { x: [at(0, width), at(1, width), at(2, width), at(3, width)], y: [at(0, height), at(1, height), at(2, height), at(3, height)] };
}

let scratch: { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null =
  null;

/**
 * The same tiles as the browser's 2D canvas draws them (RGBA, PROBE_SIZE x PROBE_SIZE, row 0 at
 * the top): its own HDR -> SDR conversion. Null if the source cannot be drawn right now.
 */
export function sampleBrowserSdr(source: CanvasImageSource, o: ProbeOrigins): Uint8ClampedArray | null {
  try {
    if (!scratch) {
      const canvas =
        typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(PROBE_SIZE, PROBE_SIZE) : document.createElement('canvas');
      canvas.width = PROBE_SIZE;
      canvas.height = PROBE_SIZE;
      const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' }) as CanvasRenderingContext2D | null;
      if (!ctx) return null;
      scratch = { canvas, ctx };
    }
    const { ctx } = scratch;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, PROBE_SIZE, PROBE_SIZE);
    for (let ty = 0; ty < PROBE_TILES; ty++) {
      for (let tx = 0; tx < PROBE_TILES; tx++) {
        ctx.drawImage(source, o.x[tx], o.y[ty], PROBE_TILE, PROBE_TILE, tx * PROBE_TILE, ty * PROBE_TILE, PROBE_TILE, PROBE_TILE);
      }
    }
    const data = ctx.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data;
    // A <video> that has no picture to give yet draws nothing, without an error.
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return null;
    return data;
  } catch {
    return null;
  }
}

/** IEEE 754 half -> number (rgba16float read-backs; Float16Array is not everywhere yet). */
export function halfToFloat(h: number): number {
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (e === 0) return sign * 6.103515625e-5 * (f / 1024);
  if (e === 31) return f ? NaN : sign * Infinity;
  return sign * Math.pow(2, e - 15) * (1 + f / 1024);
}

export interface ProbeVerdict {
  /** Null: this frame could not tell (too dark, too bright, too flat). */
  packing: ExternalPacking | null;
  /** Browser SDR light / implied light, mid-tones (0 when not measured). */
  gain: number;
  /** Half-width of the middle 68 % of that ratio, in natural-log units. */
  spread: number;
  samples: number;
}

const INCONCLUSIVE: ProbeVerdict = { packing: null, gain: 0, spread: 0, samples: 0 };

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Decide how `ext` (what the GPU import returned for the probed pixels: RGBA, 0..1, or 0..255 when
 * given as bytes) relates to `sdr` (what the 2D canvas drew for the same pixels).
 * Rows of `ext` may be in either order as long as both arrays use the same one.
 */
export function classifyExternal(
  ext: Float32Array | Uint8Array | Uint8ClampedArray,
  sdr: Uint8Array | Uint8ClampedArray,
  color: ColorInfo,
  candidates: ExternalPacking[] = ['coded-srgb', 'coded'],
): ProbeVerdict {
  const n = Math.min(ext.length, sdr.length) >> 2;
  const scale = ext instanceof Float32Array ? 1 : 1 / 255;
  const w709: [number, number, number] = [0.2126, 0.7152, 0.0722];
  const wSrc = lumaWeights(color);

  // Pixels the canvas shows in its mid-tones, with their luminance.
  const idx: number[] = [];
  const ySdr: number[] = [];
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = sdr[o];
    const g = sdr[o + 1];
    const b = sdr[o + 2];
    const hi = Math.max(r, g, b);
    if (hi >= 24)
      diffs.push(
        Math.max(Math.abs(ext[o] * scale - r / 255), Math.abs(ext[o + 1] * scale - g / 255), Math.abs(ext[o + 2] * scale - b / 255)),
      );
    // Mid-tones only: every channel below the knee of any tone curve (a saturated colour can be
    // dim in luminance and still have its brightest channel in the roll-off), and not in the noise.
    const lr = srgbEotf(r / 255);
    const lg = srgbEotf(g / 255);
    const lb = srgbEotf(b / 255);
    const y = w709[0] * lr + w709[1] * lg + w709[2] * lb;
    if (y < 0.004 || Math.max(lr, lg, lb) > 0.4) continue;
    idx.push(i);
    ySdr.push(y);
  }

  // The import already is the browser's conversion: the two agree pixel for pixel.
  if (diffs.length >= 64) {
    diffs.sort((a, b) => a - b);
    if (quantile(diffs, 0.5) < 0.025 && quantile(diffs, 0.9) < 0.08)
      return { packing: 'converted', gain: 1, spread: 0, samples: diffs.length };
  }
  if (idx.length < 48) return INCONCLUSIVE;

  // One brightness level proves nothing: any curve passes through a single point.
  const sortedY = [...ySdr].sort((a, b) => a - b);
  const varied = quantile(sortedY, 0.9) / Math.max(quantile(sortedY, 0.1), 1e-6) >= 1.5;

  let best: ProbeVerdict | null = null;
  let measured = 0;
  for (const packing of candidates) {
    const ratios: number[] = [];
    for (let k = 0; k < idx.length; k++) {
      const o = idx[k] * 4;
      const coded = unpackExternal([ext[o] * scale, ext[o + 1] * scale, ext[o + 2] * scale], packing, color);
      const lin = hdrToRelativeLight(coded, color);
      const y = wSrc[0] * lin[0] + wSrc[1] * lin[1] + wSrc[2] * lin[2];
      if (y > 1e-5) ratios.push(Math.log(ySdr[k] / y));
    }
    if (ratios.length < 48) continue;
    measured++;
    ratios.sort((a, b) => a - b);
    const gain = Math.exp(quantile(ratios, 0.5));
    const spread = (quantile(ratios, 0.84) - quantile(ratios, 0.16)) / 2;
    // A tone-mapping operator dims or keeps the mid-tones, by one factor for all of them.
    if (gain < 0.2 || gain > 1.4 || spread > 0.08) continue;
    if (!best || spread < best.spread) best = { packing, gain, spread, samples: ratios.length };
  }
  if (best) return varied ? best : INCONCLUSIVE;
  if (!measured || !varied) return INCONCLUSIVE;
  // Enough evidence, and it fits nothing we know how to undo: leave the browser's output alone.
  return { packing: 'converted', gain: 0, spread: 0, samples: idx.length };
}

function isChromium(): boolean {
  if (typeof navigator === 'undefined') return false;
  const brands = (navigator as { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData?.brands;
  if (brands) return brands.some((b) => b.brand === 'Chromium');
  return /Chrome\/\d+/.test(navigator.userAgent);
}

const MAX_ATTEMPTS = 8;
const RETRY_MS = 350;

/**
 * Per-renderer memory of how external HDR frames arrive. One stream at a time: a new source (another
 * <video> element, or VideoFrames with other colour tags or dimensions) starts over.
 */
export class ExternalHdrTracker {
  private source: object | null = null;
  private key = '';
  private packing: ExternalPacking = 'converted';
  private verified = false;
  private attempts = 0;
  /** Timestamps here are performance.now(), which starts near zero on a fresh page. */
  private lastAttempt = -Infinity;
  private lastPts = NaN;
  /** Counts streams: a read-back that comes home after a new stream began is not about it. */
  epoch = 0;
  /** Set while an asynchronous read-back is in flight. */
  busy = false;
  /** For the stats overlay. */
  detail = '';

  constructor(private api: 'webgpu' | 'webgl2') {}

  private begin(frame: Exclude<MediaFrame, { kind: 'planar' }>): void {
    const c = frame.color;
    const source = frame.kind === 'element' ? frame.el : null;
    const key = `${frame.kind}/${c.transfer}/${c.primaries}/${c.matrix}/${c.fullRange}/${frame.width}x${frame.height}`;
    if (key === this.key && source === this.source) return;
    this.key = key;
    this.source = source;
    this.epoch++;
    this.verified = false;
    this.attempts = 0;
    this.lastAttempt = -Infinity;
    this.lastPts = NaN;
    // What this API is known to do in Chromium, until the frame itself has been checked.
    this.packing = isChromium() ? (this.api === 'webgpu' ? 'coded-srgb' : 'coded') : 'converted';
    this.detail = `${this.packing} (assumed)`;
  }

  /**
   * The pipeline that produced the frames is gone. VideoFrames carry no identity of their stream,
   * and the next one may have the same tags, size and timestamps: start over.
   */
  reset(): void {
    this.key = '';
    this.source = null;
  }

  /** How to read this frame's samples. SDR frames are always the browser's business. */
  packingFor(frame: MediaFrame): ExternalPacking {
    if (frame.kind === 'planar' || !isHdrTransfer(frame.color)) return 'converted';
    this.begin(frame);
    return this.packing;
  }

  /** Whether this frame should be read back and compared with the browser's own conversion. */
  wantsProbe(frame: MediaFrame, now: number): boolean {
    if (frame.kind === 'planar' || !isHdrTransfer(frame.color)) return false;
    this.begin(frame);
    if (this.verified || this.busy || this.attempts >= MAX_ATTEMPTS) return false;
    if (frame.pts === this.lastPts || now - this.lastAttempt < RETRY_MS) return false;
    return true;
  }

  /**
   * The probe could not be made (the source had no picture for the 2D canvas yet). The same
   * picture may be tried again.
   */
  miss(now: number): void {
    this.attempts++;
    this.lastAttempt = now;
  }

  /** This stream cannot be probed at all (too small): stay with the assumption. */
  giveUp(): void {
    this.attempts = MAX_ATTEMPTS;
  }

  /**
   * Milliseconds until `frame` is due for a probe, or null when none is due. A paused player
   * draws nothing new, so the renderer uses this to come back by itself.
   */
  retryIn(frame: MediaFrame, now: number): number | null {
    if (frame.kind === 'planar' || !isHdrTransfer(frame.color)) return null;
    if (this.verified || this.attempts >= MAX_ATTEMPTS || frame.pts === this.lastPts) return null;
    return Math.max(0, RETRY_MS - (now - this.lastAttempt));
  }

  /** Candidate packings, the expected one first. */
  candidates(): ExternalPacking[] {
    return this.api === 'webgpu' ? ['coded-srgb', 'coded'] : ['coded', 'coded-srgb'];
  }

  /** Record a probe of `frame`. Returns true when the packing in use changed (re-render). */
  report(frame: MediaFrame, verdict: ProbeVerdict, now: number): boolean {
    this.attempts++;
    this.lastAttempt = now;
    this.lastPts = frame.pts;
    if (!verdict.packing) {
      if (!this.verified) this.detail = `${this.packing} (assumed: ${this.attempts} frame${this.attempts > 1 ? 's' : ''} could not tell)`;
      return false;
    }
    const changed = verdict.packing !== this.packing;
    this.packing = verdict.packing;
    this.verified = true;
    this.detail =
      verdict.packing === 'converted' && !verdict.gain
        ? 'converted (unrecognised hand-over, left to the browser)'
        : `${verdict.packing} (checked against the 2D canvas: gain ${verdict.gain.toFixed(2)} ±${(verdict.spread * 100).toFixed(0)}%, ${verdict.samples} px)`;
    return changed;
  }
}
