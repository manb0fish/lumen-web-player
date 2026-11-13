import type { MediaFrame, RendererKind, RenderSettings } from '../core/types';

export interface RendererStats {
  texturesCreated: number;
  texturesDestroyed: number;
  framesRendered: number;
  /** CPU time spent issuing the last frame's draw calls. */
  lastRenderMs: number;
  chain: string;
  /** How HDR frames decoded by the browser are being read (empty when none have been shown). */
  hdrHandover: string;
}

/**
 * A renderer owns one <canvas> and knows how to put a MediaFrame on it. It never owns frames:
 * the caller keeps the frame alive for as long as it may be re-rendered and closes it afterwards.
 */
export interface Renderer {
  readonly kind: RendererKind;
  readonly canvas: HTMLCanvasElement;
  /** Adapter / context description for the stats overlay. */
  detail: string;
  stats: RendererStats;
  /** Invoked when the GPU context is lost so the player can fall back to the next renderer. */
  onLost: ((reason: string) => void) | null;
  init(): Promise<void>;
  /** Drawing-buffer size in device pixels. */
  resize(width: number, height: number): void;
  render(frame: MediaFrame, settings: RenderSettings): void;
  /** Re-render the last frame and return a 2D copy of the canvas (null if nothing was drawn yet). */
  snapshot(): HTMLCanvasElement | null;
  /** Drop the reference to the last frame (the owner is about to close it). */
  forget(): void;
  destroy(): void;
}

/** Process-wide GPU texture accounting; must balance after every renderer has been destroyed. */
export const textureLedger = { created: 0, destroyed: 0 };

export function countTexture(stats: RendererStats, delta: 1 | -1): void {
  if (delta > 0) {
    stats.texturesCreated++;
    textureLedger.created++;
  } else {
    stats.texturesDestroyed++;
    textureLedger.destroyed++;
  }
}

export function newStats(): RendererStats {
  return { texturesCreated: 0, texturesDestroyed: 0, framesRendered: 0, lastRenderMs: 0, chain: 'idle', hdrHandover: '' };
}

export function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.className = 'lp-video-canvas';
  c.width = 16;
  c.height = 16;
  return c;
}

export function copyCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')!.drawImage(src, 0, 0);
  return c;
}
