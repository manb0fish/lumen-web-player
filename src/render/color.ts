import type { ColorInfo, GamutMap, Matrix, RenderSettings, ToneMap, MediaFrame } from '../core/types';

/**
 * Colour math shared by the WebGPU and WebGL2 shader pipelines.
 *
 * The planar ingest shader computes
 *     n   = dot(texel.rg, pack)            // normalised code value (handles 16-bit LE packed in RG8)
 *     yuv = (n - off) * scl                // range expansion, chroma centred on 0
 *     rgb = M * yuv                        // non-constant-luminance Y'CbCr -> R'G'B'
 * and all three of pack/off/scl/M are derived here from the stream's colour metadata.
 */

const KR_KB: Record<string, [number, number]> = {
  bt601: [0.299, 0.114],
  bt709: [0.2126, 0.0722],
  bt2020nc: [0.2627, 0.0593],
};

export function resolveMatrix(color: ColorInfo, height: number): Exclude<Matrix, 'unknown' | 'rgb'> {
  if (color.matrix === 'bt601' || color.matrix === 'bt709' || color.matrix === 'bt2020nc') return color.matrix;
  if (color.primaries === 'bt2020') return 'bt2020nc';
  // Untagged: the usual heuristic — SD is BT.601, HD and up is BT.709.
  return height >= 720 ? 'bt709' : 'bt601';
}

export interface YuvUniforms {
  /** Row-major 3x3. */
  matrix: [number, number, number, number, number, number, number, number, number];
  offset: [number, number, number];
  scale: [number, number, number];
  pack: [number, number];
}

export function yuvUniforms(color: ColorInfo, bitDepth: number, height: number): YuvUniforms {
  const [kr, kb] = KR_KB[resolveMatrix(color, height)];
  const kg = 1 - kr - kb;
  const matrix: YuvUniforms['matrix'] = [1, 0, 2 * (1 - kr), 1, (-2 * kb * (1 - kb)) / kg, (-2 * kr * (1 - kr)) / kg, 1, 2 * (1 - kb), 0];
  const max = (1 << bitDepth) - 1;
  const shift = 1 << (bitDepth - 8);
  let offset: YuvUniforms['offset'];
  let scale: YuvUniforms['scale'];
  if (color.fullRange) {
    const c = (1 << (bitDepth - 1)) / max;
    offset = [0, c, c];
    scale = [1, 1, 1];
  } else {
    offset = [(16 * shift) / max, (128 * shift) / max, (128 * shift) / max];
    scale = [max / (219 * shift), max / (224 * shift), max / (224 * shift)];
  }
  // 8-bit: R8 texture, value is already code/255. >8-bit: RG8 texture holding a little-endian u16.
  const pack: [number, number] = bitDepth > 8 ? [255 / max, 65280 / max] : [1, 0];
  return { matrix, offset, scale, pack };
}

export const TRANSFER_SDR = 0;
export const TRANSFER_PQ = 1;
export const TRANSFER_HLG = 2;

export function transferCode(color: ColorInfo): number {
  return color.transfer === 'pq' ? TRANSFER_PQ : color.transfer === 'hlg' ? TRANSFER_HLG : TRANSFER_SDR;
}

export function primariesCode(color: ColorInfo): number {
  return color.primaries === 'bt2020' ? 1 : color.primaries === 'p3' ? 2 : 0;
}

export function toneMapCode(t: ToneMap): number {
  return t === 'bt2390' ? 0 : t === 'hable' ? 1 : t === 'reinhard' ? 2 : 3;
}

export function gamutMapCode(g: GamutMap): number {
  return g === 'clip' ? 0 : 1;
}

/**
 * How a frame that the browser decoded (a VideoFrame or a <video> element) reaches a shader.
 *
 *   converted   the browser has already made display-referred sRGB of it; nothing to do.
 *   coded       the R'G'B' samples as coded in the stream: still PQ or HLG, still in the source
 *               primaries. Only the Y'CbCr matrix and range have been applied.
 *   coded-srgb  the same samples, but pushed through a primaries-to-sRGB matrix and the sRGB OETF
 *               as if they were linear light.
 *
 * Chromium does the last two with HDR frames that live on the GPU (see external-hdr.ts): its
 * WebGL and WebGPU import paths have no PQ / HLG transfer function, so they leave it out.
 */
export type ExternalPacking = 'converted' | 'coded' | 'coded-srgb';

export function packingCode(p: ExternalPacking): number {
  return p === 'coded' ? 1 : p === 'coded-srgb' ? 2 : 0;
}

export function isHdrTransfer(color: ColorInfo): boolean {
  return color.transfer === 'pq' || color.transfer === 'hlg';
}

export function rotationCode(r: number): number {
  return ((Math.round(r / 90) % 4) + 4) % 4;
}

/** True when the frame must go through our own colour pipeline instead of the browser's. */
export function needsColorManagement(color: ColorInfo): boolean {
  return color.transfer === 'pq' || color.transfer === 'hlg' || color.primaries === 'bt2020' || color.primaries === 'p3';
}

export function kernelCode(s: RenderSettings['scaler']): number {
  return s === 'bilinear' ? 0 : s === 'lanczos' ? 2 : 1;
}

export function frameDisplaySize(frame: MediaFrame): { width: number; height: number } {
  const swap = frame.rotation === 90 || frame.rotation === 270;
  return swap ? { width: frame.height, height: frame.width } : { width: frame.width, height: frame.height };
}

/**
 * Human-readable description of the pass chain for the stats overlay. `packing` says how an
 * external frame was handed over; anything but 'converted' goes through our own colour pipeline.
 */
export function describeChain(
  frame: MediaFrame | null,
  s: RenderSettings,
  outW: number,
  outH: number,
  packing: ExternalPacking = 'converted',
): string {
  if (!frame) return 'idle';
  const parts: string[] = [];
  const managed = frame.kind === 'planar' || packing !== 'converted';
  if (frame.kind === 'planar') parts.push(`yuv${frame.bitDepth > 8 ? frame.bitDepth + 'le' : ''}→rgb`);
  else parts.push(managed ? `external(${frame.color.transfer} samples)` : 'external');
  if (managed) {
    const soft = s.gamutMapping === 'clip' ? '' : '(soft)';
    if (isHdrTransfer(frame.color)) parts.push(`${frame.color.transfer}→sdr(${s.toneMapping})`);
    if (frame.color.primaries === 'bt2020') parts.push(`2020→709${soft}`);
    else if (frame.color.primaries === 'p3') parts.push(`p3→709${soft}`);
  }
  if (s.deband) parts.push('deband');
  const { width, height } = frameDisplaySize(frame);
  const up = outW > width || outH > height;
  if (s.scaler === 'fsr') parts.push(up ? 'easu' : 'bicubic');
  else parts.push(s.scaler + (s.linearScaling && s.scaler !== 'bilinear' ? '(linear)' : ''));
  if (s.sharpen > 0) parts.push(`rcas ${s.sharpen.toFixed(2)}`);
  if (s.dither) parts.push('dither');
  return parts.join(' → ');
}

// ---- the same colour science on the CPU ---------------------------------------------------------
// Used to check what the browser hands over (external-hdr.ts) and by the unit tests; the shaders
// in wgsl.ts / glsl.ts are the per-pixel implementation.

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const SDR_WHITE_NITS = 203;

/** Linear-light primaries conversions, row-major. */
export const M_2020_TO_709: Mat3 = [1.660491, -0.587641, -0.07285, -0.12455, 1.1329, -0.008349, -0.018151, -0.100579, 1.11873];
export const M_709_TO_2020: Mat3 = [0.627404, 0.329283, 0.043313, 0.069097, 0.91954, 0.011362, 0.016391, 0.088013, 0.895595];
export const M_P3_TO_709: Mat3 = [1.22494, -0.22494, 0, -0.042057, 1.042057, 0, -0.019638, -0.078636, 1.098274];
export const M_709_TO_P3: Mat3 = [0.822462, 0.177538, 0, 0.033194, 0.966806, 0, 0.017083, 0.072397, 0.91052];

export function mul3(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** sRGB EOTF, extended to negative values by symmetry (as GPU colour conversions do). */
export function srgbEotf(v: number): number {
  const a = Math.abs(v);
  return Math.sign(v) * (a <= 0.04045 ? a / 12.92 : Math.pow((a + 0.055) / 1.055, 2.4));
}

export function srgbOetf(v: number): number {
  const a = Math.abs(v);
  return Math.sign(v) * (a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055);
}

const PQ_M1 = 0.1593017578125;
const PQ_M2 = 78.84375;
const PQ_C1 = 0.8359375;
const PQ_C2 = 18.8515625;
const PQ_C3 = 18.6875;

/** SMPTE ST 2084: signal (0..1) -> nits. */
export function pqEotf(e: number): number {
  const p = Math.pow(Math.max(e, 0), 1 / PQ_M2);
  return 10000 * Math.pow(Math.max(p - PQ_C1, 0) / (PQ_C2 - PQ_C3 * p), 1 / PQ_M1);
}

/** SMPTE ST 2084: nits -> signal (0..1). */
export function pqOetf(nits: number): number {
  const y = Math.pow(Math.max(nits, 0) / 10000, PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * y) / (1 + PQ_C3 * y), PQ_M2);
}

/** ARIB STD-B67 inverse OETF: signal (0..1) -> scene light (0..1). */
export function hlgInverseOetf(e: number): number {
  return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - 0.55991073) / 0.17883277) + 0.28466892) / 12;
}

/** Luminance weights of a set of primaries (the middle row of its RGB -> XYZ matrix). */
export function lumaWeights(color: ColorInfo): Vec3 {
  if (color.primaries === 'bt2020') return [0.2627, 0.678, 0.0593];
  if (color.primaries === 'p3') return [0.229, 0.6917, 0.0793];
  return [0.2126, 0.7152, 0.0722];
}

/** Undo `packing`: what an external frame's sample was in the stream (R'G'B', source primaries). */
export function unpackExternal(rgb: Vec3, packing: ExternalPacking, color: ColorInfo): Vec3 {
  if (packing !== 'coded-srgb') return rgb;
  const lin: Vec3 = [srgbEotf(rgb[0]), srgbEotf(rgb[1]), srgbEotf(rgb[2])];
  if (color.primaries === 'bt2020') return mul3(M_709_TO_2020, lin);
  if (color.primaries === 'p3') return mul3(M_709_TO_P3, lin);
  return lin;
}

/**
 * Display light of a coded HDR sample, relative to SDR reference white (203 nits), in the source
 * primaries. HLG gets the reference OOTF for a 1000-nit display, as in the shaders.
 */
export function hdrToRelativeLight(coded: Vec3, color: ColorInfo): Vec3 {
  const c: Vec3 = [Math.min(1, Math.max(0, coded[0])), Math.min(1, Math.max(0, coded[1])), Math.min(1, Math.max(0, coded[2]))];
  if (color.transfer === 'pq') return [pqEotf(c[0]) / SDR_WHITE_NITS, pqEotf(c[1]) / SDR_WHITE_NITS, pqEotf(c[2]) / SDR_WHITE_NITS];
  const scene: Vec3 = [hlgInverseOetf(c[0]), hlgInverseOetf(c[1]), hlgInverseOetf(c[2])];
  const ys = 0.2627 * scene[0] + 0.678 * scene[1] + 0.0593 * scene[2];
  const k = (Math.pow(Math.max(ys, 1e-6), 0.2) * 1000) / SDR_WHITE_NITS;
  return [scene[0] * k, scene[1] * k, scene[2] * k];
}
