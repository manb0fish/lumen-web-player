import type { ColorInfo, MediaFrame, PeakSource, RenderSettings } from '../core/types';

/**
 * The peak of the source: what a tone curve has to bring down to display white.
 *
 * A fixed guess is wrong both ways. A film mastered at 4000 nits clips where the guess ends, and a
 * scene that never passes 400 nits is squeezed as if it reached the guess. Three sources, each
 * falling back on the next:
 *
 *   measured   The GPU finds the brightest area and the average of every picture and follows them
 *              over time, in the manner of libplacebo's peak detection. Nothing is read back: the
 *              result stays in a 1x1 texture that the ingest shader looks up.
 *   metadata   MaxCLL, or else the peak of the mastering display, as the stream states them.
 *   fixed      A number of nits.
 *
 * Measuring takes two small passes per new picture:
 *
 *   measure    PEAK_GRID x PEAK_GRID cells, each the maximum and the mean over its part of the
 *              picture (bilinear taps two pixels apart, so every pixel counts and a single hot
 *              pixel does not set the peak), in PQ units of the brightest channel: the quantity
 *              the tone curve works on.
 *   reduce     Maximum and mean of all cells, blended into the state of the previous picture:
 *              a first-order low-pass with time constant PEAK_TAU, in PQ space. When the mean
 *              moves by more than a few percent of the PQ range the scene has changed, and the
 *              state jumps instead of following.
 *
 * The state belongs to a stream position: a seek, a new stream or a step backwards starts it
 * afresh from the picture itself, and drawing the same picture again (a resize, a setting, a
 * screenshot) measures nothing and changes nothing.
 */

/** Cells per side of the measuring grid. */
export const PEAK_GRID = 64;
/** Time constant of the smoothing, in seconds of media time (20 frames at 24 fps, as libplacebo). */
export const PEAK_TAU = 0.8;
/** Change of the mean, as a fraction of the PQ range, where a scene change begins and is certain. */
export const PEAK_SCENE_LOW = 0.01;
export const PEAK_SCENE_HIGH = 0.03;
/** Most taps a cell takes per axis: enough to see every pixel of a 4K picture. */
const MAX_TAPS = 32;

/** Taps per cell and axis for a picture of this size: one for every two pixels. */
export function peakTaps(width: number, height: number): [number, number] {
  const n = (size: number) => Math.max(1, Math.min(MAX_TAPS, Math.ceil(size / PEAK_GRID / 2)));
  return [n(width), n(height)];
}

/** A peak below this is no HDR peak; a stream that claims one is not believed. */
const MIN_PLAUSIBLE_PEAK = 100;

/** The peak a stream's static metadata states, in nits, and which field it came from. */
export function metadataPeak(color: ColorInfo): { nits: number; from: string } | null {
  const m = color.hdrMetadata;
  if (!m) return null;
  // MaxCLL is about the content, the mastering peak only about the monitor it was graded on.
  if (m.maxCll !== undefined && m.maxCll >= MIN_PLAUSIBLE_PEAK) return { nits: m.maxCll, from: 'MaxCLL' };
  if (m.masteringMax !== undefined && m.masteringMax >= MIN_PLAUSIBLE_PEAK) return { nits: m.masteringMax, from: 'mastering display' };
  return null;
}

export interface PeakChoice {
  /** The source in effect, after falling back. */
  source: PeakSource;
  /** Nits for the shader; with 'measured' only what it starts from before the first measurement. */
  nits: number;
  /** For the stats overlay. */
  detail: string;
}

const nitsText = (n: number): string => `${n >= 100 ? Math.round(n) : n.toFixed(1)} nits`;

/** Which peak an HDR frame is tone-mapped with. `canMeasure`: this renderer can measure it. */
export function choosePeak(color: ColorInfo, s: RenderSettings, canMeasure: boolean): PeakChoice {
  if (s.hdrPeakSource === 'measured' && canMeasure) return { source: 'measured', nits: s.hdrPeak, detail: 'measured per scene' };
  const cannot = s.hdrPeakSource === 'measured' ? '; this renderer cannot measure' : '';
  if (s.hdrPeakSource !== 'fixed') {
    const m = metadataPeak(color);
    if (m) return { source: 'metadata', nits: m.nits, detail: `${nitsText(m.nits)} (${m.from}${cannot})` };
    return { source: 'fixed', nits: s.hdrPeak, detail: `${nitsText(s.hdrPeak)} (assumed: the stream states no peak${cannot})` };
  }
  return { source: 'fixed', nits: s.hdrPeak, detail: `${nitsText(s.hdrPeak)} (fixed)` };
}

/** Stats text for a state read back from the GPU, in nits. */
export function describeMeasuredPeak(peak: number, mean: number): string {
  return `${nitsText(peak)} (measured; picture average ${nitsText(mean)})`;
}

/** Static metadata as one line, or '' when the stream has none. */
export function describeHdrMetadata(color: ColorInfo | null | undefined): string {
  const m = color?.hdrMetadata;
  if (!m) return '';
  const parts: string[] = [];
  if (m.maxCll !== undefined) parts.push(`MaxCLL ${Math.round(m.maxCll)}`);
  if (m.maxFall !== undefined) parts.push(`MaxFALL ${Math.round(m.maxFall)}`);
  if (m.masteringMax !== undefined) parts.push(`mastering display ${+(m.masteringMin ?? 0).toFixed(4)}–${Math.round(m.masteringMax)}`);
  return parts.join(', ') + ' nits';
}

export interface PeakStep {
  /** Start over from this picture instead of following the previous state. */
  reset: boolean;
  /** Weight of this picture in the low-pass (1 on a reset). */
  alpha: number;
}

/**
 * Decides, for each frame drawn with a measured peak, whether it is a picture the state has not
 * seen yet and how it follows the previous one. The numbers themselves never leave the GPU.
 */
export class PeakTracker {
  private key = '';
  private id: object | null = null;
  private pts = NaN;
  private duration = 0;
  private valid = false;

  /**
   * Null: this is the picture measured last, the state stands. `key` names everything that makes
   * samples comparable (stream tags, size, how an external frame is unpacked).
   */
  step(frame: MediaFrame, key: string): PeakStep | null {
    // A <video> element is one object for all its pictures; the others are one object per picture.
    const id = frame.kind === 'videoframe' ? frame.frame : frame.kind === 'element' ? frame.el : frame.planes[0];
    if (this.valid && key === this.key && id === this.id && frame.pts === this.pts) return null;
    let reset = !this.valid || key !== this.key;
    let alpha = 1;
    if (!reset) {
      // The next picture of the same run follows; anything else (a seek, a step back, another
      // picture at the same time) starts over.
      const dt = frame.pts - this.pts;
      const run = Math.max(0.5, 4 * Math.max(this.duration, frame.duration || 0));
      if (dt > 0 && dt <= run) alpha = 1 - Math.exp(-dt / PEAK_TAU);
      else reset = true;
    }
    this.key = key;
    this.id = id;
    this.pts = frame.pts;
    this.duration = frame.duration || 0;
    this.valid = true;
    return { reset, alpha: reset ? 1 : alpha };
  }

  /** The stream is gone, or the state texture is: the next picture starts over. */
  reset(): void {
    this.valid = false;
    this.id = null;
  }
}

/** Everything that decides whether two frames' samples can share a state. */
export function peakKey(frame: MediaFrame, packing: string): string {
  const c = frame.color;
  const depth = frame.kind === 'planar' ? frame.bitDepth : 0;
  return `${frame.kind}/${c.transfer}/${c.primaries}/${c.matrix}/${c.fullRange}/${frame.width}x${frame.height}/${depth}/${packing}`;
}
