import type { ColorInfo, Matrix, RenderSettings, ToneMap, MediaFrame } from '../core/types';

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

/** Human-readable description of the pass chain for the stats overlay. */
export function describeChain(frame: MediaFrame | null, s: RenderSettings, outW: number, outH: number): string {
  if (!frame) return 'idle';
  const parts: string[] = [];
  if (frame.kind === 'planar') {
    parts.push(`yuv${frame.bitDepth > 8 ? frame.bitDepth + 'le' : ''}→rgb`);
    if (frame.color.transfer === 'pq' || frame.color.transfer === 'hlg') parts.push(`${frame.color.transfer}→sdr(${s.toneMapping})`);
    if (frame.color.primaries === 'bt2020') parts.push('2020→709');
  } else {
    parts.push('external');
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
