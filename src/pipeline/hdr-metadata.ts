/**
 * Static HDR10 metadata, read from wherever a stream keeps it.
 *
 * The browser's decoders know these numbers and hand none of them on (a VideoFrame has an empty
 * `metadata()`, a <video> element nothing at all), and mediabunny does not expose them either. So
 * they are read from the bytes:
 *
 *   HEVC / AVC   SEI messages 137 (mastering display colour volume) and 144 (content light level),
 *                in the decoder configuration record and in key frames
 *   AV1          metadata OBUs of type HDR_CLL and HDR_MDCV, in av1C and in key frames
 *   Matroska     the Colour element of the video track (the only place VP9 has for them)
 *   FFmpeg       ffprobe's side data, of the stream or of its first frame
 *
 * Everything here is pure: bytes in, numbers out.
 */
import type { HdrMetadata } from '../core/types';
import { readId, readSize } from '../subs/mkv';

const u16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number): number => b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);

/** PQ cannot code more than this, so nothing a stream says beyond it means anything. */
const MAX_NITS = 10000;

/** Drop what is absent (zero), impossible or contradictory. Null when nothing is left. */
export function cleanHdrMetadata(m: HdrMetadata | null | undefined): HdrMetadata | null {
  if (!m) return null;
  const ok = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_NITS;
  const out: HdrMetadata = {};
  if (ok(m.maxCll)) out.maxCll = m.maxCll;
  if (ok(m.maxFall) && (out.maxCll === undefined || m.maxFall <= out.maxCll)) out.maxFall = m.maxFall;
  if (ok(m.masteringMax)) {
    out.masteringMax = m.masteringMax;
    if (typeof m.masteringMin === 'number' && m.masteringMin >= 0 && m.masteringMin < m.masteringMax) out.masteringMin = m.masteringMin;
  }
  return Object.keys(out).length ? out : null;
}

/** Fields of `a` win; `b` fills the gaps. */
export function mergeHdrMetadata(a: HdrMetadata | null | undefined, b: HdrMetadata | null | undefined): HdrMetadata | null {
  return cleanHdrMetadata({ ...(b ?? {}), ...(a ?? {}) });
}

/** True once both halves are known and there is nothing left to look for. */
export function hdrMetadataComplete(m: HdrMetadata | null | undefined): boolean {
  return !!m && m.maxCll !== undefined && m.masteringMax !== undefined;
}

// ---- HEVC / AVC: SEI ---------------------------------------------------------------------------

/** NAL units of a packet: Annex B (start codes) or length-prefixed, whichever it is. */
function* nalUnits(data: Uint8Array, lengthSize: number): Generator<Uint8Array> {
  const n = data.length;
  const annexB = n >= 4 && data[0] === 0 && data[1] === 0 && (data[2] === 1 || (data[2] === 0 && data[3] === 1));
  if (annexB) {
    let start = -1;
    for (let i = 0; i + 2 < n; i++) {
      if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 1) continue;
      if (start >= 0) yield data.subarray(start, i > 0 && data[i - 1] === 0 ? i - 1 : i);
      start = i + 3;
      i += 2;
    }
    if (start >= 0 && start < n) yield data.subarray(start);
    return;
  }
  let o = 0;
  while (o + lengthSize <= n) {
    let len = 0;
    for (let i = 0; i < lengthSize; i++) len = len * 256 + data[o + i];
    o += lengthSize;
    if (!len || o + len > n) return;
    yield data.subarray(o, o + len);
    o += len;
  }
}

/** Raw byte sequence payload: the NAL unit without its emulation-prevention bytes. */
function rbsp(nal: Uint8Array, header: number): Uint8Array {
  const out = new Uint8Array(nal.length - header);
  let n = 0;
  let zeros = 0;
  for (let i = header; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    zeros = b === 0 ? zeros + 1 : 0;
    out[n++] = b;
  }
  return out.subarray(0, n);
}

function readSei(payload: Uint8Array, out: HdrMetadata): void {
  let o = 0;
  while (o + 2 <= payload.length) {
    let type = 0;
    while (o < payload.length && payload[o] === 0xff) {
      type += 255;
      o++;
    }
    type += payload[o++] ?? 0;
    let size = 0;
    while (o < payload.length && payload[o] === 0xff) {
      size += 255;
      o++;
    }
    size += payload[o++] ?? 0;
    if (o + size > payload.length) return;
    if (type === 137 && size >= 24) {
      // Three primaries and the white point (16 bytes), then luminance in units of 0.0001 nits.
      out.masteringMax = u32(payload, o + 16) / 10000;
      out.masteringMin = u32(payload, o + 20) / 10000;
    } else if (type === 144 && size >= 4) {
      out.maxCll = u16(payload, o);
      out.maxFall = u16(payload, o + 2);
    }
    o += size;
  }
}

function seiOfNal(nal: Uint8Array, codec: 'hevc' | 'avc', out: HdrMetadata): void {
  if (codec === 'hevc') {
    // PREFIX_SEI_NUT
    if (nal.length > 2 && ((nal[0] >> 1) & 0x3f) === 39) readSei(rbsp(nal, 2), out);
  } else if (nal.length > 1 && (nal[0] & 0x1f) === 6) {
    readSei(rbsp(nal, 1), out);
  }
}

/** Static HDR metadata in the SEI messages of one coded picture. */
export function seiHdrMetadata(packet: Uint8Array, codec: 'hevc' | 'avc', lengthSize = 4): HdrMetadata | null {
  const out: HdrMetadata = {};
  for (const nal of nalUnits(packet, lengthSize)) seiOfNal(nal, codec, out);
  return cleanHdrMetadata(out);
}

/** NAL length size used by the samples that go with an hvcC (HEVC) or avcC (AVC) record. */
export function nalLengthSize(record: Uint8Array | null, codec: 'hevc' | 'avc'): number {
  if (codec === 'hevc') return record && record.length > 21 ? (record[21] & 3) + 1 : 4;
  return record && record.length > 4 ? (record[4] & 3) + 1 : 4;
}

/** Static HDR metadata in the SEI arrays of an HEVCDecoderConfigurationRecord (hvcC). */
export function hvccHdrMetadata(hvcc: Uint8Array): HdrMetadata | null {
  const out: HdrMetadata = {};
  if (hvcc.length < 23 || hvcc[0] !== 1) return null;
  let o = 23;
  for (let a = 0; a < hvcc[22] && o + 3 <= hvcc.length; a++) {
    const count = u16(hvcc, o + 1);
    o += 3;
    for (let i = 0; i < count && o + 2 <= hvcc.length; i++) {
      const len = u16(hvcc, o);
      o += 2;
      if (o + len > hvcc.length) return cleanHdrMetadata(out);
      seiOfNal(hvcc.subarray(o, o + len), 'hevc', out);
      o += len;
    }
  }
  return cleanHdrMetadata(out);
}

// ---- AV1: metadata OBUs ------------------------------------------------------------------------

function leb128(b: Uint8Array, o: number): { value: number; len: number } | null {
  let value = 0;
  for (let i = 0; i < 8 && o + i < b.length; i++) {
    value += (b[o + i] & 0x7f) * 2 ** (7 * i);
    if (!(b[o + i] & 0x80)) return { value, len: i + 1 };
  }
  return null;
}

/** Static HDR metadata in a sequence of AV1 OBUs (a temporal unit, or the configOBUs of av1C). */
export function av1HdrMetadata(data: Uint8Array): HdrMetadata | null {
  const out: HdrMetadata = {};
  let o = 0;
  while (o < data.length) {
    const header = data[o++];
    if (header & 0x80) break; // forbidden bit: this is not an OBU
    const type = (header >> 3) & 0xf;
    if (header & 4) o++; // extension byte
    let size = data.length - o;
    if (header & 2) {
      const s = leb128(data, o);
      if (!s) break;
      size = s.value;
      o += s.len;
    }
    if (size < 0 || o + size > data.length) break;
    if (type === 5) {
      // OBU_METADATA
      const p = data.subarray(o, o + size);
      const kind = leb128(p, 0);
      if (kind?.value === 1 && p.length >= kind.len + 4) {
        out.maxCll = u16(p, kind.len);
        out.maxFall = u16(p, kind.len + 2);
      } else if (kind?.value === 2 && p.length >= kind.len + 24) {
        // Primaries and white point (16 bytes), then 24.8 and 18.14 fixed point.
        out.masteringMax = u32(p, kind.len + 16) / 256;
        out.masteringMin = u32(p, kind.len + 20) / 16384;
      }
    }
    o += size;
  }
  return cleanHdrMetadata(out);
}

/** The same for an AV1CodecConfigurationRecord (av1C): four bytes, then OBUs. */
export function av1cHdrMetadata(av1c: Uint8Array): HdrMetadata | null {
  return av1c.length > 4 && av1c[0] === 0x81 ? av1HdrMetadata(av1c.subarray(4)) : null;
}

// ---- Matroska / WebM: the Colour element -------------------------------------------------------

const MKV = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Video: 0xe0,
  Colour: 0x55b0,
  MaxCLL: 0x55bc,
  MaxFALL: 0x55bd,
  MasteringMetadata: 0x55d0,
  LuminanceMax: 0x55d9,
  LuminanceMin: 0x55da,
} as const;

interface Element {
  id: number;
  /** Offset of the payload in the buffer, and its length (-1: unknown size). */
  data: number;
  size: number;
}

function element(b: Uint8Array, o: number): Element | null {
  const id = readId(b, o);
  if (!id) return null;
  const size = readSize(b, o + id.len);
  if (!size) return null;
  return { id: id.id, data: o + id.len + size.len, size: size.size };
}

/** Complete child elements of b[from, to). Stops at the first one that is cut off. */
function* childElements(b: Uint8Array, from: number, to: number): Generator<Element> {
  let o = from;
  while (o < to) {
    const e = element(b, o);
    if (!e || e.size < 0 || e.data + e.size > to) return;
    yield e;
    o = e.data + e.size;
  }
}

function ebmlUint(b: Uint8Array, e: Element): number {
  let v = 0;
  for (let i = 0; i < e.size && i < 8; i++) v = v * 256 + b[e.data + i];
  return v;
}

function ebmlFloat(b: Uint8Array, e: Element): number {
  const view = new DataView(b.buffer, b.byteOffset + e.data, e.size);
  return e.size === 4 ? view.getFloat32(0) : e.size === 8 ? view.getFloat64(0) : NaN;
}

/** A byte range of the file, end exclusive. */
export interface ByteRange {
  start: number;
  end: number;
}

/** How much of a Matroska file's head is read at first; Tracks is nearly always inside it. */
export const MATROSKA_HEAD = 64 * 1024;
/** No Tracks element is larger than this unless something is wrong. */
const MAX_TRACKS = 4 * 1024 * 1024;

/**
 * Find the Tracks element. `buf` holds the bytes of the file from `offset` on: the head of the
 * file (offset 0), or a range this function asked for earlier. Returns the Tracks payload, or the
 * range to read and come back with, or null when there is nothing to find.
 */
export function matroskaTracks(buf: Uint8Array, offset = 0): { tracks: Uint8Array } | { read: ByteRange } | null {
  let o = 0;
  let segmentData = 0;
  if (offset === 0) {
    const head = element(buf, 0);
    if (!head || head.id !== MKV.EBML || head.size < 0) return null;
    const segment = element(buf, head.data + head.size);
    if (!segment || segment.id !== MKV.Segment) return null;
    o = segmentData = segment.data;
  }
  // Level-1 elements, one after the other, until Tracks turns up or the first cluster begins.
  let seek = -1;
  while (o < buf.length) {
    const e = element(buf, o);
    if (!e) break; // its header is cut off: continue from here
    if (e.id === MKV.Tracks) {
      if (e.size < 0 || e.size > MAX_TRACKS) return null;
      if (e.data + e.size <= buf.length) return { tracks: buf.subarray(e.data, e.data + e.size) };
      return { read: { start: offset + o, end: offset + e.data + e.size } };
    }
    if (e.id === MKV.Cluster || e.size < 0) return null;
    if (offset === 0 && e.id === MKV.SeekHead && e.data + e.size <= buf.length) {
      for (const s of childElements(buf, e.data, e.data + e.size)) {
        if (s.id !== MKV.Seek) continue;
        let id = 0;
        let pos = -1;
        for (const c of childElements(buf, s.data, s.data + s.size)) {
          if (c.id === MKV.SeekID) id = ebmlUint(buf, c);
          else if (c.id === MKV.SeekPosition) pos = ebmlUint(buf, c);
        }
        if (id === MKV.Tracks && pos >= 0) seek = segmentData + pos;
      }
    }
    o = e.data + e.size;
  }
  // Not in what was read: go where the seek index points, or on to the next element.
  if (seek >= 0 && seek < buf.length) return null;
  const next = seek >= 0 ? seek : offset + o;
  return { read: { start: next, end: next + MATROSKA_HEAD } };
}

/**
 * Static HDR metadata of a video track, from the payload of a Tracks element: the track with
 * this number if there is one, the first video track otherwise.
 */
export function matroskaHdrMetadata(tracks: Uint8Array, trackNumber?: number): HdrMetadata | null {
  let first: HdrMetadata | null | undefined;
  for (const entry of childElements(tracks, 0, tracks.length)) {
    if (entry.id !== MKV.TrackEntry) continue;
    let number = -1;
    let type = -1;
    const out: HdrMetadata = {};
    for (const e of childElements(tracks, entry.data, entry.data + entry.size)) {
      if (e.id === MKV.TrackNumber) number = ebmlUint(tracks, e);
      else if (e.id === MKV.TrackType) type = ebmlUint(tracks, e);
      else if (e.id === MKV.Video) {
        for (const v of childElements(tracks, e.data, e.data + e.size)) {
          if (v.id !== MKV.Colour) continue;
          for (const c of childElements(tracks, v.data, v.data + v.size)) {
            if (c.id === MKV.MaxCLL) out.maxCll = ebmlUint(tracks, c);
            else if (c.id === MKV.MaxFALL) out.maxFall = ebmlUint(tracks, c);
            else if (c.id === MKV.MasteringMetadata) {
              for (const m of childElements(tracks, c.data, c.data + c.size)) {
                if (m.id === MKV.LuminanceMax) out.masteringMax = ebmlFloat(tracks, m);
                else if (m.id === MKV.LuminanceMin) out.masteringMin = ebmlFloat(tracks, m);
              }
            }
          }
        }
      }
    }
    if (type !== 1) continue;
    const found = cleanHdrMetadata(out);
    if (number === trackNumber) return found;
    if (first === undefined) first = found;
  }
  return first ?? null;
}

// ---- FFmpeg: ffprobe side data -----------------------------------------------------------------

function rational(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const [a, b] = v.split('/').map(Number);
  return b ? a / b : a;
}

/** Static HDR metadata in a `side_data_list` of ffprobe's JSON (of a stream or of a frame). */
export function ffprobeHdrMetadata(list: unknown): HdrMetadata | null {
  if (!Array.isArray(list)) return null;
  const out: HdrMetadata = {};
  for (const sd of list) {
    const type = String(sd?.side_data_type ?? '');
    if (/mastering display/i.test(type)) {
      out.masteringMax = rational(sd.max_luminance);
      out.masteringMin = rational(sd.min_luminance);
    } else if (/content light level/i.test(type)) {
      out.maxCll = Number(sd.max_content);
      out.maxFall = Number(sd.max_average);
    }
  }
  return cleanHdrMetadata(out);
}
