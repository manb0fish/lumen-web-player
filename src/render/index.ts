import type { RendererKind, RendererRequest } from '../core/types';
import { Canvas2DRenderer } from './canvas2d';
import type { Renderer } from './renderer';
import { WebGL2Renderer } from './webgl2';
import { WebGPURenderer } from './webgpu';

export type { Renderer, RendererStats } from './renderer';
export { textureLedger } from './renderer';

const ORDER: Array<Exclude<RendererKind, 'native'>> = ['webgpu', 'webgl2', 'canvas2d'];

function make(kind: Exclude<RendererKind, 'native'>): Renderer {
  if (kind === 'webgpu') return new WebGPURenderer();
  if (kind === 'webgl2') return new WebGL2Renderer();
  return new Canvas2DRenderer();
}

export interface RendererChoice {
  renderer: Renderer;
  /** Renderers that were tried first and failed, with the reason — surfaced in stats. */
  skipped: Array<{ kind: RendererKind; reason: string }>;
}

/**
 * Create the best available renderer, degrading WebGPU -> WebGL2 -> Canvas2D.
 * A specific request starts the chain at that renderer (so `webgl2` never silently upgrades to
 * WebGPU, but still degrades to Canvas2D if the context cannot be created).
 */
export async function createRenderer(request: RendererRequest): Promise<RendererChoice> {
  const start = request === 'auto' || request === 'native' ? 0 : Math.max(0, ORDER.indexOf(request));
  const skipped: RendererChoice['skipped'] = [];
  for (let i = start; i < ORDER.length; i++) {
    const renderer = make(ORDER[i]);
    try {
      await renderer.init();
      return { renderer, skipped };
    } catch (err: any) {
      skipped.push({ kind: ORDER[i], reason: err?.message ?? String(err) });
      try {
        renderer.destroy();
      } catch {
        /* ignore */
      }
    }
  }
  throw new Error('No renderer could be initialised: ' + skipped.map((s) => `${s.kind}: ${s.reason}`).join('; '));
}
