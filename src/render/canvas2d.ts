import type { MediaFrame, PlanarFrame, RenderSettings } from '../core/types';
import { resolveMatrix } from './color';
import { copyCanvas, makeCanvas, newStats, type Renderer, type RendererStats } from './renderer';

/**
 * Canvas 2D compatibility renderer. No shaders: the browser converts and scales. Software-decoded
 * planes are converted to RGBA on the CPU (BT.601/709/2020 matrix, limited or full range), so this
 * path works even where neither a GPU context nor WebCodecs exists.
 */
export class Canvas2DRenderer implements Renderer {
  readonly kind = 'canvas2d' as const;
  readonly canvas = makeCanvas();
  detail = 'CanvasRenderingContext2D';
  stats: RendererStats = newStats();
  onLost: ((reason: string) => void) | null = null;

  private ctx!: CanvasRenderingContext2D;
  private scratch: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
  private last: { frame: MediaFrame; settings: RenderSettings } | null = null;
  private destroyed = false;

  async init(): Promise<void> {
    const ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      if (this.last) this.render(this.last.frame, this.last.settings);
    }
  }

  private planarToCanvas(frame: PlanarFrame): HTMLCanvasElement {
    const { width: w, height: h } = frame;
    if (!this.scratch || this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch = document.createElement('canvas');
      this.scratch.width = w;
      this.scratch.height = h;
      this.scratchCtx = this.scratch.getContext('2d', { alpha: false })!;
      this.image = this.scratchCtx.createImageData(w, h);
    }
    const out = this.image!.data;
    const [py, pu, pv] = frame.planes;
    const cw = frame.chromaWidth;
    const wide = frame.bitDepth > 8;
    const shift = frame.bitDepth - 8;
    const m = resolveMatrix(frame.color, h);
    const [kr, kb] = m === 'bt601' ? [0.299, 0.114] : m === 'bt2020nc' ? [0.2627, 0.0593] : [0.2126, 0.0722];
    const kg = 1 - kr - kb;
    const full = frame.color.fullRange;
    const ys = full ? 1 : 255 / 219;
    const cs = full ? 1 : 255 / 224;
    const yo = full ? 0 : 16;
    const rv = 2 * (1 - kr) * cs;
    const bu = 2 * (1 - kb) * cs;
    const gu = ((-2 * kb * (1 - kb)) / kg) * cs;
    const gv = ((-2 * kr * (1 - kr)) / kg) * cs;
    const subX = cw < w ? 1 : 0;
    const subY = frame.chromaHeight < h ? 1 : 0;
    let o = 0;
    for (let y = 0; y < h; y++) {
      const cy = (y >> subY) * cw;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const ci = cy + (x >> subX);
        let Y: number;
        let U: number;
        let V: number;
        if (wide) {
          const yi = (row + x) << 1;
          Y = (py[yi] | (py[yi + 1] << 8)) >> shift;
          U = (pu[ci << 1] | (pu[(ci << 1) + 1] << 8)) >> shift;
          V = (pv[ci << 1] | (pv[(ci << 1) + 1] << 8)) >> shift;
        } else {
          Y = py[row + x];
          U = pu[ci];
          V = pv[ci];
        }
        const yy = (Y - yo) * ys;
        const u = U - 128;
        const v = V - 128;
        out[o++] = yy + rv * v;
        out[o++] = yy + gu * u + gv * v;
        out[o++] = yy + bu * u;
        out[o++] = 255;
      }
    }
    this.scratchCtx!.putImageData(this.image!, 0, 0);
    return this.scratch;
  }

  render(frame: MediaFrame, settings: RenderSettings): void {
    if (this.destroyed) return;
    const t0 = performance.now();
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    let src: CanvasImageSource;
    try {
      if (frame.kind === 'planar') src = this.planarToCanvas(frame);
      else if (frame.kind === 'videoframe') src = frame.frame;
      else src = frame.el;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = settings.scaler === 'bilinear' ? 'low' : 'high';
      const rot = frame.rotation;
      if (rot === 0) {
        ctx.drawImage(src, 0, 0, W, H);
      } else {
        const swap = rot === 90 || rot === 270;
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.rotate((rot * Math.PI) / 180);
        const dw = swap ? H : W;
        const dh = swap ? W : H;
        ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
      }
    } catch {
      return; // source not ready
    }
    this.last = { frame, settings };
    this.stats.framesRendered++;
    this.stats.lastRenderMs = performance.now() - t0;
    this.stats.chain = frame.kind === 'planar' ? 'yuv→rgb (cpu) → drawImage' : 'drawImage';
  }

  snapshot(): HTMLCanvasElement | null {
    if (!this.last || this.destroyed) return null;
    this.render(this.last.frame, this.last.settings);
    return copyCanvas(this.canvas);
  }

  forget(): void {
    this.last = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.last = null;
    this.scratch = null;
    this.scratchCtx = null;
    this.image = null;
    this.canvas.width = this.canvas.height = 0;
    this.canvas.remove();
  }
}
