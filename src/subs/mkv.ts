/**
 * Minimal streaming Matroska/WebM scanner.
 *
 * mediabunny does not expose subtitle tracks, so this walks the EBML tree itself and extracts just
 * what the subtitle engine needs: subtitle TrackEntries (with CodecPrivate), every subtitle Block
 * with its timing, and Attachments (embedded fonts). Audio/video block payloads are skipped
 * without being parsed. The file is read sequentially in windows, and results are delivered
 * incrementally so subtitles appear while a large file is still being scanned.
 */

export interface MkvSubtitleTrack {
  number: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  language: string;
  name: string | null;
  isDefault: boolean;
  isForced: boolean;
  /** 0 = zlib, 3 = header stripping, -1 = none */
  compression: number;
  compressionSettings: Uint8Array | null;
}

export interface MkvAttachment {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface MkvCue {
  track: number;
  /** milliseconds */
  start: number;
  /** milliseconds; 0 when the block carried no duration */
  duration: number;
  data: Uint8Array;
}

export interface MkvScanHandlers {
  onTracks?(tracks: MkvSubtitleTrack[]): void;
  onAttachment?(a: MkvAttachment): void;
  onCue?(cue: MkvCue): void;
  signal?: AbortSignal;
}

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  Attachments: 0x1941a469,
  AttachedFile: 0x61a7,
  FileName: 0x466e,
  FileMimeType: 0x4660,
  FileData: 0x465c,
  Cluster: 0x1f43b675,
  ClusterTimestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
} as const;

const UNKNOWN = -1;

/** Sequential-ish reader over a Blob with a sliding window. */
class BlobReader {
  private buf = new Uint8Array(0);
  private start = 0;
  readonly size: number;
  constructor(
    private blob: Blob,
    private window = 4 << 20,
  ) {
    this.size = blob.size;
  }

  /** Returns a view of [pos, pos+len), clamped to the file size. */
  async read(pos: number, len: number): Promise<Uint8Array> {
    const end = Math.min(this.size, pos + len);
    if (pos < this.start || end > this.start + this.buf.length) {
      const span = Math.max(len, this.window);
      const to = Math.min(this.size, pos + span);
      this.buf = new Uint8Array(await this.blob.slice(pos, to).arrayBuffer());
      this.start = pos;
    }
    return this.buf.subarray(pos - this.start, end - this.start);
  }
}

function readId(b: Uint8Array, o: number): { id: number; len: number } | null {
  if (o >= b.length) return null;
  const first = b[o];
  let len = 1;
  if (first & 0x80) len = 1;
  else if (first & 0x40) len = 2;
  else if (first & 0x20) len = 3;
  else if (first & 0x10) len = 4;
  else return null;
  if (o + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[o + i];
  return { id, len };
}

function readSize(b: Uint8Array, o: number): { size: number; len: number } | null {
  if (o >= b.length) return null;
  const first = b[o];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) {
    len++;
    mask >>= 1;
  }
  if (len > 8 || o + len > b.length) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[o + i];
    if (b[o + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? UNKNOWN : value, len };
}

function uint(b: Uint8Array): number {
  let v = 0;
  for (let i = 0; i < b.length; i++) v = v * 256 + b[i];
  return v;
}

const utf8 = new TextDecoder('utf-8');

/** Iterate the children of a fully-buffered master element. */
function* children(b: Uint8Array): Generator<{ id: number; data: Uint8Array }> {
  let o = 0;
  while (o < b.length) {
    const id = readId(b, o);
    if (!id) return;
    const sz = readSize(b, o + id.len);
    if (!sz) return;
    const start = o + id.len + sz.len;
    const end = sz.size === UNKNOWN ? b.length : Math.min(b.length, start + sz.size);
    yield { id: id.id, data: b.subarray(start, end) };
    o = end;
  }
}

function parseTracks(b: Uint8Array): MkvSubtitleTrack[] {
  const out: MkvSubtitleTrack[] = [];
  for (const entry of children(b)) {
    if (entry.id !== ID.TrackEntry) continue;
    let type = 0;
    const t: MkvSubtitleTrack = {
      number: 0,
      codecId: '',
      codecPrivate: null,
      language: 'eng',
      name: null,
      isDefault: true,
      isForced: false,
      compression: -1,
      compressionSettings: null,
    };
    for (const c of children(entry.data)) {
      switch (c.id) {
        case ID.TrackNumber:
          t.number = uint(c.data);
          break;
        case ID.TrackType:
          type = uint(c.data);
          break;
        case ID.CodecID:
          t.codecId = utf8.decode(c.data).replace(/\0+$/, '');
          break;
        case ID.CodecPrivate:
          t.codecPrivate = c.data.slice();
          break;
        case ID.Language:
          t.language = utf8.decode(c.data).replace(/\0+$/, '');
          break;
        case ID.LanguageBCP47:
          t.language = utf8.decode(c.data).replace(/\0+$/, '');
          break;
        case ID.Name:
          t.name = utf8.decode(c.data).replace(/\0+$/, '');
          break;
        case ID.FlagDefault:
          t.isDefault = uint(c.data) !== 0;
          break;
        case ID.FlagForced:
          t.isForced = uint(c.data) !== 0;
          break;
        case ID.ContentEncodings:
          for (const enc of children(c.data)) {
            if (enc.id !== ID.ContentEncoding) continue;
            for (const e of children(enc.data)) {
              if (e.id !== ID.ContentCompression) continue;
              t.compression = 0;
              for (const k of children(e.data)) {
                if (k.id === ID.ContentCompAlgo) t.compression = uint(k.data);
                else if (k.id === ID.ContentCompSettings) t.compressionSettings = k.data.slice();
              }
            }
          }
          break;
      }
    }
    if (type === 0x11 && t.number) out.push(t);
  }
  return out;
}

function parseAttachments(b: Uint8Array, emit: (a: MkvAttachment) => void): void {
  for (const file of children(b)) {
    if (file.id !== ID.AttachedFile) continue;
    let name = '';
    let mime = '';
    let data: Uint8Array | null = null;
    for (const c of children(file.data)) {
      if (c.id === ID.FileName) name = utf8.decode(c.data);
      else if (c.id === ID.FileMimeType) mime = utf8.decode(c.data);
      else if (c.id === ID.FileData) data = c.data.slice();
    }
    if (data) emit({ name, mime, data });
  }
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Scan a Matroska file. Resolves when the whole file has been walked (or the signal aborts).
 * Returns false if the blob is not EBML at all.
 */
export async function scanMatroska(blob: Blob, h: MkvScanHandlers): Promise<boolean> {
  const r = new BlobReader(blob);
  const head = await r.read(0, 64);
  const first = readId(head, 0);
  if (!first || first.id !== ID.EBML) return false;
  const headSize = readSize(head, first.len);
  if (!headSize || headSize.size === UNKNOWN) return false;
  let pos = first.len + headSize.len + headSize.size;

  // Segment header
  const segHead = await r.read(pos, 16);
  const segId = readId(segHead, 0);
  if (!segId || segId.id !== ID.Segment) return false;
  const segSize = readSize(segHead, segId.len);
  if (!segSize) return false;
  pos += segId.len + segSize.len;
  const segEnd = segSize.size === UNKNOWN ? r.size : Math.min(r.size, pos + segSize.size);

  let scale = 1_000_000; // ns per tick
  const wanted = new Map<number, MkvSubtitleTrack>();
  const emitCue = async (track: number, tsTicks: number, durTicks: number, payload: Uint8Array) => {
    const t = wanted.get(track);
    if (!t) return;
    let data = payload;
    try {
      if (t.compression === 0) data = await inflate(payload);
      else if (t.compression === 3 && t.compressionSettings) {
        const merged = new Uint8Array(t.compressionSettings.length + payload.length);
        merged.set(t.compressionSettings, 0);
        merged.set(payload, t.compressionSettings.length);
        data = merged;
      } else data = payload.slice();
    } catch {
      return;
    }
    const ms = scale / 1e6;
    h.onCue?.({ track, start: tsTicks * ms, duration: durTicks * ms, data });
  };

  /** Parse a (Simple)Block header: returns track number, relative timestamp and payload offset. */
  const blockHeader = (b: Uint8Array): { track: number; rel: number; off: number } | null => {
    const tn = readSize(b, 0);
    if (!tn || b.length < tn.len + 3) return null;
    let rel = (b[tn.len] << 8) | b[tn.len + 1];
    if (rel & 0x8000) rel -= 0x10000;
    return { track: tn.size, rel, off: tn.len + 3 };
  };

  while (pos < segEnd) {
    if (h.signal?.aborted) return true;
    const hd = await r.read(pos, 16);
    const id = readId(hd, 0);
    if (!id) break;
    const sz = readSize(hd, id.len);
    if (!sz) break;
    const dataPos = pos + id.len + sz.len;
    const dataEnd = sz.size === UNKNOWN ? segEnd : Math.min(segEnd, dataPos + sz.size);

    if (id.id === ID.Info) {
      for (const c of children(await r.read(dataPos, dataEnd - dataPos))) {
        if (c.id === ID.TimestampScale) scale = uint(c.data) || scale;
      }
    } else if (id.id === ID.Tracks) {
      const tracks = parseTracks(await r.read(dataPos, dataEnd - dataPos));
      for (const t of tracks) wanted.set(t.number, t);
      h.onTracks?.(tracks);
    } else if (id.id === ID.Attachments) {
      if (h.onAttachment) parseAttachments(await r.read(dataPos, dataEnd - dataPos), h.onAttachment);
    } else if (id.id === ID.Cluster) {
      if (wanted.size) {
        let clusterTs = 0;
        let p = dataPos;
        while (p < dataEnd) {
          if (h.signal?.aborted) return true;
          const eh = await r.read(p, 24);
          const eid = readId(eh, 0);
          if (!eid) break;
          const esz = readSize(eh, eid.len);
          if (!esz) break;
          const ePos = p + eid.len + esz.len;
          if (esz.size === UNKNOWN) break;
          const eEnd = ePos + esz.size;
          if (eid.id === ID.ClusterTimestamp) {
            clusterTs = uint(await r.read(ePos, esz.size));
          } else if (eid.id === ID.SimpleBlock) {
            const bh = blockHeader(await r.read(ePos, Math.min(esz.size, 12)));
            if (bh && wanted.has(bh.track)) {
              const full = await r.read(ePos, esz.size);
              await emitCue(bh.track, clusterTs + bh.rel, 0, full.subarray(bh.off));
            }
          } else if (eid.id === ID.BlockGroup) {
            // Peek at the group's first child (normally the Block) before deciding to read it all.
            const peek = await r.read(ePos, Math.min(esz.size, 32));
            const cid = readId(peek, 0);
            const csz = cid ? readSize(peek, cid.len) : null;
            let interesting = true;
            if (cid && csz && cid.id === ID.Block) {
              const bh = blockHeader(peek.subarray(cid.len + csz.len));
              interesting = !!bh && wanted.has(bh.track);
            }
            if (interesting && esz.size < 64 << 20) {
              const group = await r.read(ePos, esz.size);
              let block: Uint8Array | null = null;
              let dur = 0;
              for (const c of children(group)) {
                if (c.id === ID.Block) block = c.data;
                else if (c.id === ID.BlockDuration) dur = uint(c.data);
              }
              if (block) {
                const bh = blockHeader(block);
                if (bh && wanted.has(bh.track)) await emitCue(bh.track, clusterTs + bh.rel, dur, block.subarray(bh.off));
              }
            }
          } else if (eid.id === ID.Cluster || eid.id === ID.Tracks || eid.id === ID.Attachments) {
            break; // unknown-size cluster ended; re-parse this element at the top level
          }
          p = eEnd;
        }
        if (sz.size === UNKNOWN) {
          pos = p;
          continue;
        }
      }
    }
    pos = dataEnd;
  }
  return true;
}

export function isFontAttachment(a: MkvAttachment): boolean {
  return /font|opentype|truetype|sfnt/i.test(a.mime) || /\.(ttf|otf|ttc|woff2?)$/i.test(a.name);
}
