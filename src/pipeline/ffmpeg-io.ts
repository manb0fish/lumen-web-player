/**
 * Input I/O for the FFmpeg tier.
 *
 * FFmpeg reads its input through synchronous read() calls, typically 32 KiB at a time, on the
 * thread that also demuxes and (single-threaded) decodes. Served straight from a `File` on a
 * network share or from an HTTP server, each of those calls is a round trip, and the decoder
 * stalls for every one of them. So reads go through a block cache instead:
 *
 *   - With SharedArrayBuffer the cache lives in shared memory and a separate I/O worker fills it,
 *     streaming from the source and staying a read-ahead window in front of the reader. FFmpeg's
 *     read() is then a memcpy; it only waits when it gets ahead of the network.
 *   - Without SharedArrayBuffer nothing can run beside a blocking exec(), so the reader fills the
 *     cache itself, synchronously, but in large sequential pieces rather than 32 KiB at a time.
 *
 * Either way a URL is read with HTTP range requests on demand instead of being downloaded in full
 * before playback can start.
 *
 * Concurrency (shared mode): one writer (the I/O worker) and one reader (the FFmpeg worker's main
 * thread, where Emscripten runs all file system code). The writer only ever touches slots it has
 * claimed (free -> filling -> ready) and only the reader frees ready slots, so a slot's bytes
 * never change while the reader can see it. No locks are needed.
 */

export const IO_BLOCK = 256 * 1024;
/** Shared-mode cache: 192 blocks = 48 MiB. */
export const IO_SLOTS = 192;
/** Blocks kept ready ahead of the reader (16 MiB). */
export const IO_WINDOW = 64;
/** Blocks kept behind the reader, for the short backward seeks demuxers make. */
export const IO_KEEP_BEHIND = 8;
/** The writer reads through a gap of up to this many blocks rather than reconnecting. */
export const IO_SKIP = 4;

// Header cells
export const M_READ_BLOCK = 0; // block the reader is at: the anchor of the read-ahead window
export const M_WAKE = 1; // bumped by the reader whenever it moves or misses
export const M_SEQ = 2; // bumped by the writer whenever a block becomes ready (or on error)
export const M_CLOCK = 3; // LRU stamp counter
export const M_ERROR = 4; // non-zero: the source failed for good
const HEADER = 8;

// Slot cells
const S_STATE = 0;
const S_BLOCK = 1;
const S_BYTES = 2;
const S_STAMP = 3;
const SLOT_CELLS = 4;
const FREE = 0;
const FILLING = 1;
const READY = 2;

export class BlockCache {
  readonly meta: Int32Array;
  readonly data: Uint8Array;
  /** Called with every block the reader evicts (used where the writer cannot see the cache). */
  onEvict: ((block: number) => void) | null = null;

  constructor(
    readonly buffer: ArrayBufferLike,
    readonly slots = IO_SLOTS,
    readonly block = IO_BLOCK,
  ) {
    const cells = HEADER + slots * SLOT_CELLS;
    this.meta = new Int32Array(buffer, 0, cells);
    this.data = new Uint8Array(buffer, BlockCache.dataOffset(slots), slots * block);
  }

  private static dataOffset(slots: number): number {
    return Math.ceil(((HEADER + slots * SLOT_CELLS) * 4) / 64) * 64;
  }

  static bytes(slots = IO_SLOTS, block = IO_BLOCK): number {
    return BlockCache.dataOffset(slots) + slots * block;
  }

  private cell(slot: number, field: number): number {
    return HEADER + slot * SLOT_CELLS + field;
  }

  reset(): void {
    this.meta.fill(0);
  }

  /** Slot holding block `b`, or -1. */
  find(b: number): number {
    const m = this.meta;
    for (let s = 0, i = HEADER; s < this.slots; s++, i += SLOT_CELLS) {
      if (Atomics.load(m, i + S_STATE) === READY && m[i + S_BLOCK] === b) return s;
    }
    return -1;
  }

  /** Every block currently ready (writer side, to plan what to fetch next). */
  ready(into: Set<number>): Set<number> {
    into.clear();
    const m = this.meta;
    for (let s = 0, i = HEADER; s < this.slots; s++, i += SLOT_CELLS) {
      if (Atomics.load(m, i + S_STATE) === READY) into.add(m[i + S_BLOCK]);
    }
    return into;
  }

  bytesIn(slot: number): number {
    return this.meta[this.cell(slot, S_BYTES)];
  }

  touch(slot: number): void {
    this.meta[this.cell(slot, S_STAMP)] = Atomics.add(this.meta, M_CLOCK, 1);
  }

  /**
   * Reader side: free the least recently used blocks outside the window around `b` until at least
   * `minFree` slots are free, so the writer always has room to keep reading ahead.
   */
  makeRoom(b: number, minFree: number): void {
    const m = this.meta;
    let free = 0;
    for (let s = 0, i = HEADER; s < this.slots; s++, i += SLOT_CELLS) if (Atomics.load(m, i + S_STATE) === FREE) free++;
    while (free < minFree) {
      let victim = -1;
      let oldest = Infinity;
      for (let s = 0, i = HEADER; s < this.slots; s++, i += SLOT_CELLS) {
        if (Atomics.load(m, i + S_STATE) !== READY) continue;
        const blk = m[i + S_BLOCK];
        if (blk >= b - IO_KEEP_BEHIND && blk <= b + IO_WINDOW) continue; // still wanted
        // Stamps wrap after 2^31 uses; a signed difference keeps the comparison right across that.
        const age = (m[M_CLOCK] - m[i + S_STAMP]) | 0;
        if (victim < 0 || age > oldest) {
          victim = s;
          oldest = age;
        }
      }
      if (victim < 0) return; // everything left is inside the window
      Atomics.store(m, this.cell(victim, S_STATE), FREE);
      this.onEvict?.(m[this.cell(victim, S_BLOCK)]);
      free++;
    }
  }

  /** Writer side: claim a free slot to fill, or -1 when there is none. */
  claim(): number {
    const m = this.meta;
    for (let s = 0, i = HEADER; s < this.slots; s++, i += SLOT_CELLS) {
      if (Atomics.compareExchange(m, i + S_STATE, FREE, FILLING) === FREE) return s;
    }
    return -1;
  }

  /** Writer side: give back a slot that was claimed but not completed. */
  release(slot: number): void {
    Atomics.compareExchange(this.meta, this.cell(slot, S_STATE), FILLING, FREE);
  }

  /** Writer side: the slot now holds `bytes` bytes of block `b`. */
  publish(slot: number, b: number, bytes: number): void {
    const m = this.meta;
    m[this.cell(slot, S_BLOCK)] = b;
    m[this.cell(slot, S_BYTES)] = bytes;
    m[this.cell(slot, S_STAMP)] = Atomics.add(m, M_CLOCK, 1);
    Atomics.store(m, this.cell(slot, S_STATE), READY);
    Atomics.add(m, M_SEQ, 1);
    Atomics.notify(m, M_SEQ);
  }
}

export type ReadFn = (dst: Uint8Array, dstOffset: number, length: number, position: number) => number;

/**
 * Build the read() FFmpeg's input file uses. `fill(block)` is called when a block is missing and
 * must return true once it is in the cache, or false to fail the read (abort, dead source).
 */
export function createReader(
  cache: BlockCache,
  size: number,
  fill: (block: number) => boolean,
  /** Told whenever the reader moves on to another block. */
  onMove?: (block: number) => void,
): ReadFn {
  const B = cache.block;
  const m = cache.meta;
  // Enough free slots that the writer can keep going between two reads.
  const minFree = Math.min(32, cache.slots >> 2);
  let anchor = -1;
  return (dst, dstOffset, length, position) => {
    if (position >= size || length <= 0) return 0;
    length = Math.min(length, size - position);
    let done = 0;
    while (done < length) {
      const pos = position + done;
      const b = Math.floor(pos / B);
      if (b !== anchor) {
        anchor = b;
        Atomics.store(m, M_READ_BLOCK, b);
        Atomics.add(m, M_WAKE, 1);
        Atomics.notify(m, M_WAKE);
        cache.makeRoom(b, minFree);
        onMove?.(b);
      }
      let slot = cache.find(b);
      if (slot < 0) {
        if (!fill(b)) return done > 0 ? done : -1;
        slot = cache.find(b);
        if (slot < 0) return done > 0 ? done : -1;
      }
      const off = pos - b * B;
      const n = Math.min(length - done, cache.bytesIn(slot) - off);
      if (n <= 0) break; // short block: end of the file
      dst.set(cache.data.subarray(slot * B + off, slot * B + off + n), dstOffset + done);
      cache.touch(slot);
      done += n;
    }
    return done;
  };
}

/** Shared mode: wait until the I/O worker has delivered the block. */
export function waitForBlock(cache: BlockCache, aborted: () => boolean): (block: number) => boolean {
  const m = cache.meta;
  return (b) => {
    for (;;) {
      const seq = Atomics.load(m, M_SEQ);
      if (cache.find(b) >= 0) return true;
      if (Atomics.load(m, M_ERROR) !== 0 || aborted()) return false;
      Atomics.wait(m, M_SEQ, seq, 100);
    }
  };
}

export interface RangeSource {
  blob?: Blob;
  url?: string;
  size: number;
}

/** Fetch `[start, end)` synchronously. Only usable in a worker. */
function readRangeSync(src: RangeSource, start: number, end: number): Uint8Array | null {
  try {
    if (src.blob) {
      return new Uint8Array(new (self as any).FileReaderSync().readAsArrayBuffer(src.blob.slice(start, end)));
    }
    const xhr = new XMLHttpRequest();
    xhr.open('GET', src.url!, false);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Range', `bytes=${start}-${end - 1}`);
    xhr.send();
    if (xhr.status !== 206 && !(xhr.status === 200 && start === 0)) return null;
    const bytes = new Uint8Array(xhr.response as ArrayBuffer);
    return bytes.length >= end - start ? bytes.subarray(0, end - start) : null;
  } catch {
    return null;
  }
}

/**
 * Unshared mode: fetch the missing block ourselves, blocking the decoder while we do. Sequential
 * reading doubles the amount fetched per round trip (256 KiB up to `maxRun` blocks), so a steady
 * read costs few requests; a seek starts small. With a read-ahead worker posting blocks in the
 * background this is only the path for whatever it has not delivered yet, so `maxRun` stays low
 * there to keep each stall short.
 */
export function syncFill(
  cache: BlockCache,
  src: RangeSource,
  maxRun = 16,
  /** Told which blocks were just fetched. */
  onFilled?: (first: number, count: number) => void,
): (block: number) => boolean {
  const B = cache.block;
  const last = Math.max(0, Math.ceil(src.size / B) - 1);
  let next = -1;
  let run = 1;
  return (b) => {
    run = b === next ? Math.min(maxRun, run * 2) : 1;
    let count = 0;
    while (count < run && b + count <= last && cache.find(b + count) < 0) count++;
    if (!count) return true;
    cache.makeRoom(b, count + 2);
    const start = b * B;
    const end = Math.min(src.size, (b + count) * B);
    const bytes = readRangeSync(src, start, end);
    if (!bytes) return false;
    for (let k = 0; k < count; k++) {
      const slot = cache.claim();
      if (slot < 0) break;
      const from = k * B;
      const n = Math.min(B, bytes.length - from);
      cache.data.set(bytes.subarray(from, from + n), slot * B);
      cache.publish(slot, b + k, n);
    }
    next = b + count;
    onFilled?.(b, count);
    return cache.find(b) >= 0;
  };
}

/**
 * Find out how a URL can be read. A server that answers a range request with 206 is read lazily;
 * one that ignores it is already sending the whole file, which is then kept as a Blob.
 */
export async function probeUrl(url: string): Promise<{ size: number; blob?: Blob }> {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (res.status === 206) {
    await res.arrayBuffer().catch(() => {});
    const total = /\/(\d+)\s*$/.exec(res.headers.get('Content-Range') ?? '');
    if (total) return { size: Number(total[1]) };
    // Cross-origin responses hide Content-Range unless the server exposes it; Content-Length of a
    // HEAD request is always readable.
    const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
    const length = Number(head?.headers.get('Content-Length'));
    if (head?.ok && length > 0) return { size: length };
    const whole = await fetch(url);
    if (!whole.ok) throw new Error(`HTTP ${whole.status} while fetching the source`);
    const blob = await whole.blob();
    return { size: blob.size, blob };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} while fetching the source`);
  const blob = await res.blob();
  return { size: blob.size, blob };
}
