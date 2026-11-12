/**
 * Presentation Graphic Stream (Blu-ray "PGS" / .sup) decoder and canvas renderer.
 *
 * A display set is PCS (composition) [WDS] [PDS…] [ODS…] END. Objects and palettes persist within
 * an epoch, so later compositions may reference bitmaps defined earlier. Each completed display
 * set becomes one timed event; an event with no items clears the screen.
 */

const SEG_PDS = 0x14;
const SEG_ODS = 0x15;
const SEG_PCS = 0x16;
const SEG_WDS = 0x17;
const SEG_END = 0x80;

interface CompositionObject {
  objectId: number;
  x: number;
  y: number;
  crop: { x: number; y: number; w: number; h: number } | null;
}

interface Composition {
  pts: number;
  width: number;
  height: number;
  state: number;
  paletteId: number;
  objects: CompositionObject[];
}

interface PgsObject {
  width: number;
  height: number;
  rle: Uint8Array;
}

export interface PgsItem {
  x: number;
  y: number;
  image: ImageData;
}

export interface PgsEvent {
  pts: number;
  width: number;
  height: number;
  items: PgsItem[];
}

export class PgsStream {
  events: PgsEvent[] = [];
  private palettes = new Map<number, Uint32Array>();
  private objects = new Map<number, PgsObject>();
  private partial = new Map<number, { width: number; height: number; chunks: Uint8Array[] }>();
  private pcs: Composition | null = null;
  private sorted = true;

  /** Feed a whole .sup file (segments carry their own "PG" headers with 90 kHz timestamps). */
  feedSup(bytes: Uint8Array): void {
    let o = 0;
    while (o + 13 <= bytes.length) {
      if (bytes[o] !== 0x50 || bytes[o + 1] !== 0x47) {
        o++;
        continue;
      }
      const pts = ((bytes[o + 2] << 24) | (bytes[o + 3] << 16) | (bytes[o + 4] << 8) | bytes[o + 5]) >>> 0;
      const type = bytes[o + 10];
      const size = (bytes[o + 11] << 8) | bytes[o + 12];
      const start = o + 13;
      if (start + size > bytes.length) break;
      this.segment(type, bytes.subarray(start, start + size), pts / 90000);
      o = start + size;
    }
  }

  /** Feed one Matroska block (segments without the PG header; timing comes from the container). */
  feedBlock(bytes: Uint8Array, pts: number): void {
    let o = 0;
    while (o + 3 <= bytes.length) {
      const type = bytes[o];
      const size = (bytes[o + 1] << 8) | bytes[o + 2];
      const start = o + 3;
      if (start + size > bytes.length) break;
      this.segment(type, bytes.subarray(start, start + size), pts);
      o = start + size;
    }
  }

  private segment(type: number, d: Uint8Array, pts: number): void {
    switch (type) {
      case SEG_PCS: {
        if (d.length < 11) return;
        const state = d[7];
        if (state === 0x80) {
          // Epoch start: all previous objects/palettes are invalid.
          this.palettes.clear();
          this.objects.clear();
          this.partial.clear();
        }
        const count = d[10];
        const objects: CompositionObject[] = [];
        let o = 11;
        for (let i = 0; i < count && o + 8 <= d.length; i++) {
          const objectId = (d[o] << 8) | d[o + 1];
          const cropped = (d[o + 3] & 0x80) !== 0;
          const x = (d[o + 4] << 8) | d[o + 5];
          const y = (d[o + 6] << 8) | d[o + 7];
          o += 8;
          let crop: CompositionObject['crop'] = null;
          if (cropped && o + 8 <= d.length) {
            crop = {
              x: (d[o] << 8) | d[o + 1],
              y: (d[o + 2] << 8) | d[o + 3],
              w: (d[o + 4] << 8) | d[o + 5],
              h: (d[o + 6] << 8) | d[o + 7],
            };
            o += 8;
          }
          objects.push({ objectId, x, y, crop });
        }
        this.pcs = { pts, width: (d[0] << 8) | d[1], height: (d[2] << 8) | d[3], state, paletteId: d[9], objects };
        break;
      }
      case SEG_WDS:
        break; // windows only bound the drawing area; not needed to composite
      case SEG_PDS: {
        if (d.length < 2) return;
        const id = d[0];
        const pal = this.palettes.get(id) ?? new Uint32Array(256);
        const hd = (this.pcs?.height ?? 1080) >= 600;
        for (let o = 2; o + 5 <= d.length; o += 5) {
          const idx = d[o];
          const y = d[o + 1] - 16;
          const cr = d[o + 2] - 128;
          const cb = d[o + 3] - 128;
          const a = d[o + 4];
          let r: number;
          let g: number;
          let b: number;
          if (hd) {
            r = 1.164 * y + 1.793 * cr;
            g = 1.164 * y - 0.213 * cb - 0.533 * cr;
            b = 1.164 * y + 2.112 * cb;
          } else {
            r = 1.164 * y + 1.596 * cr;
            g = 1.164 * y - 0.392 * cb - 0.813 * cr;
            b = 1.164 * y + 2.017 * cb;
          }
          const c = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
          pal[idx] = ((a << 24) | (c(b) << 16) | (c(g) << 8) | c(r)) >>> 0; // little-endian RGBA
        }
        this.palettes.set(id, pal);
        break;
      }
      case SEG_ODS: {
        if (d.length < 4) return;
        const id = (d[0] << 8) | d[1];
        const flag = d[3];
        const first = (flag & 0x80) !== 0;
        const last = (flag & 0x40) !== 0;
        if (first) {
          if (d.length < 11) return;
          const width = (d[7] << 8) | d[8];
          const height = (d[9] << 8) | d[10];
          this.partial.set(id, { width, height, chunks: [d.subarray(11)] });
        } else {
          this.partial.get(id)?.chunks.push(d.subarray(4));
        }
        if (last) {
          const p = this.partial.get(id);
          if (p) {
            const total = p.chunks.reduce((n, c) => n + c.length, 0);
            const rle = new Uint8Array(total);
            let o = 0;
            for (const c of p.chunks) {
              rle.set(c, o);
              o += c.length;
            }
            this.objects.set(id, { width: p.width, height: p.height, rle });
            this.partial.delete(id);
          }
        }
        break;
      }
      case SEG_END: {
        const pcs = this.pcs;
        if (!pcs) return;
        const pal = this.palettes.get(pcs.paletteId);
        const items: PgsItem[] = [];
        for (const co of pcs.objects) {
          const obj = this.objects.get(co.objectId);
          if (!obj || !pal || !obj.width || !obj.height) continue;
          const image = decodeObject(obj, pal);
          if (image) items.push({ x: co.x, y: co.y, image });
        }
        const prev = this.events[this.events.length - 1];
        if (prev && prev.pts > pcs.pts) this.sorted = false;
        this.events.push({ pts: pcs.pts, width: pcs.width, height: pcs.height, items });
        this.pcs = null;
        break;
      }
    }
  }

  /** Index of the display set active at `time`, or -1. */
  find(time: number): number {
    if (!this.sorted) {
      this.events.sort((a, b) => a.pts - b.pts);
      this.sorted = true;
    }
    const ev = this.events;
    let lo = 0;
    let hi = ev.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ev[mid].pts <= time + 1e-4) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }
}

function decodeObject(obj: PgsObject, pal: Uint32Array): ImageData | null {
  const { width: w, height: h, rle } = obj;
  let image: ImageData;
  try {
    image = new ImageData(w, h);
  } catch {
    return null;
  }
  const px = new Uint32Array(image.data.buffer);
  let o = 0;
  let x = 0;
  let y = 0;
  while (o < rle.length && y < h) {
    let color = rle[o++];
    let run = 1;
    if (color === 0) {
      if (o >= rle.length) break;
      const flags = rle[o++];
      run = flags & 0x3f;
      if (flags & 0x40) {
        if (o >= rle.length) break;
        run = (run << 8) | rle[o++];
      }
      if (flags & 0x80) {
        if (o >= rle.length) break;
        color = rle[o++];
      } else color = 0;
      if (run === 0) {
        // end of line
        x = 0;
        y++;
        continue;
      }
    }
    const rgba = pal[color];
    const row = y * w;
    const end = Math.min(w, x + run);
    if (rgba >>> 24) for (let i = x; i < end; i++) px[row + i] = rgba;
    x += run;
  }
  return image;
}

/** Draws a PgsStream onto a canvas whose backing store matches the stream's composition size. */
export class PgsRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private shown = -2;
  private stream: PgsStream | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'lp-sub-canvas lp-sub-pgs';
    this.canvas.width = 1920;
    this.canvas.height = 1080;
    this.ctx = this.canvas.getContext('2d')!;
  }

  setStream(stream: PgsStream | null): void {
    this.stream = stream;
    this.shown = -2;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Returns true if something is currently drawn. */
  draw(time: number, force = false): boolean {
    const s = this.stream;
    if (!s) return false;
    const idx = s.find(time);
    if (idx === this.shown && !force) return idx >= 0 && s.events[idx].items.length > 0;
    this.shown = idx;
    const ev = idx >= 0 ? s.events[idx] : null;
    if (ev && (this.canvas.width !== ev.width || this.canvas.height !== ev.height)) {
      this.canvas.width = ev.width;
      this.canvas.height = ev.height;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!ev) return false;
    for (const item of ev.items) this.ctx.putImageData(item.image, item.x, item.y);
    return ev.items.length > 0;
  }

  destroy(): void {
    this.stream = null;
    this.canvas.remove();
  }
}
