// Minimal Presentation Graphic Stream (.sup) writer for test media: FFmpeg has no PGS encoder,
// so the bitmap-subtitle sample is synthesised here (PCS / WDS / PDS / ODS / END with RLE).

const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const u24 = (v) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

function segment(type, pts, payload) {
  const ticks = Math.round(pts * 90000);
  return Uint8Array.from([0x50, 0x47, ...u32(ticks), ...u32(ticks), type, ...u16(payload.length), ...payload]);
}

/** Run-length encode an indexed bitmap (rows of palette indices). */
function rle(pixels, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const c = pixels[y * w + x];
      let run = 1;
      while (x + run < w && pixels[y * w + x + run] === c && run < 16383) run++;
      if (c !== 0 && run <= 2) {
        for (let i = 0; i < run; i++) out.push(c);
      } else if (c === 0) {
        if (run < 64) out.push(0, run);
        else out.push(0, 0x40 | (run >> 8), run & 0xff);
      } else if (run < 64) {
        out.push(0, 0x80 | run, c);
      } else {
        out.push(0, 0xc0 | (run >> 8), run & 0xff, c);
      }
      x += run;
    }
    out.push(0, 0); // end of line
  }
  return out;
}

/** BT.709 limited-range RGB -> Y, Cr, Cb as stored in a PGS palette entry. */
function ycrcb(r, g, b) {
  const y = 16 + (0.2126 * r + 0.7152 * g + 0.0722 * b) * (219 / 255);
  const cb = 128 + (-0.1146 * r - 0.3854 * g + 0.5 * b) * (224 / 255);
  const cr = 128 + (0.5 * r - 0.4542 * g - 0.0458 * b) * (224 / 255);
  return [Math.round(y), Math.round(cr), Math.round(cb)];
}

/**
 * items: [{ start, end, x, y, w, h, rgb, border }]
 * Each item becomes an epoch-start display set at `start` and an empty one (clear) at `end`.
 */
export function buildSup(items, width = 1920, height = 1080) {
  const parts = [];
  let comp = 0;
  for (const it of items) {
    const { w, h } = it;
    const px = new Uint8Array(w * h).fill(1);
    const bw = it.border ?? 6;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < bw || y < bw || x >= w - bw || y >= h - bw) px[y * w + x] = 2;
      }
    }
    const data = rle(px, w, h);
    const palette = [
      [0, 16, 128, 128, 0],
      [1, ...ycrcb(...it.rgb), 255],
      [2, ...ycrcb(255, 255, 255), 255],
    ].flat();
    parts.push(
      segment(0x16, it.start, [
        ...u16(width),
        ...u16(height),
        0x10,
        ...u16(comp++),
        0x80,
        0x00,
        0x00,
        0x01,
        ...u16(0),
        0x00,
        0x00,
        ...u16(it.x),
        ...u16(it.y),
      ]),
      segment(0x17, it.start, [0x01, 0x00, ...u16(it.x), ...u16(it.y), ...u16(w), ...u16(h)]),
      segment(0x14, it.start, [0x00, 0x00, ...palette]),
      segment(0x15, it.start, [...u16(0), 0x00, 0xc0, ...u24(data.length + 4), ...u16(w), ...u16(h), ...data]),
      segment(0x80, it.start, []),
      // clear
      segment(0x16, it.end, [...u16(width), ...u16(height), 0x10, ...u16(comp++), 0x00, 0x00, 0x00, 0x00]),
      segment(0x17, it.end, [0x01, 0x00, ...u16(it.x), ...u16(it.y), ...u16(w), ...u16(h)]),
      segment(0x80, it.end, []),
    );
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const PGS_ITEMS = [
  { name: 'yellow', start: 1.0, end: 3.0, x: 192, y: 216, w: 384, h: 162, rgb: [255, 220, 0] },
  { name: 'cyan', start: 4.0, end: 6.0, x: 1344, y: 756, w: 384, h: 162, rgb: [0, 220, 255] },
];
