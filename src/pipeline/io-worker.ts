/**
 * Read-ahead worker for the FFmpeg tier (see ffmpeg-io.ts for the design).
 *
 * It streams the source (a Blob, or a URL through one HTTP range request) and keeps a window of
 * blocks ready in front of wherever FFmpeg is reading. Whenever the first missing block of that
 * window is not where the current stream is heading, the stream is reopened there. A seek is
 * therefore one new request, and steady playback is one long download that pauses (by not
 * reading) whenever the window is full.
 *
 * Two ways of handing the blocks over:
 *   - shared: straight into the SharedArrayBuffer cache FFmpeg reads from, following the reader's
 *     position through shared memory. FFmpeg sees a block the moment it is complete.
 *   - posted: without SharedArrayBuffer, blocks are posted to the FFmpeg worker, which is told
 *     where the reader is by messages. They are picked up between two exec() calls, so what one
 *     segment downloads in the background is there when the next one starts.
 */
import { BlockCache, IO_SKIP, IO_WINDOW, M_ERROR, M_READ_BLOCK, M_SEQ, M_WAKE } from './ffmpeg-io';

const post = (msg: unknown, transfer: Transferable[] = []) => (self as any).postMessage(msg, transfer);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Where finished blocks go, and where the reader is. */
interface Sink {
  /** Block the reader is at. */
  anchor(): number;
  /** Collect the blocks that need no fetching. */
  known(into: Set<number>): void;
  has(b: number): boolean;
  /** Storage for one block, or null when none is free yet. */
  begin(): { buffer: Uint8Array; token: number } | null;
  commit(token: number, buffer: Uint8Array, b: number, bytes: number): void;
  cancel(token: number): void;
  /** Resolve when the reader has moved (or after a short while). */
  idle(): Promise<void>;
  failed(on: boolean): void;
}

function sharedSink(cache: BlockCache): Sink {
  const m = cache.meta;
  const B = cache.block;
  const waitAsync = (Atomics as any).waitAsync as ((a: Int32Array, i: number, v: number, t: number) => { value: unknown }) | undefined;
  return {
    anchor: () => Atomics.load(m, M_READ_BLOCK),
    known: (into) => void cache.ready(into),
    has: (b) => cache.find(b) >= 0,
    begin() {
      const slot = cache.claim();
      return slot < 0 ? null : { buffer: cache.data.subarray(slot * B, slot * B + B), token: slot };
    },
    commit: (slot, _buffer, b, bytes) => cache.publish(slot, b, bytes),
    cancel: (slot) => cache.release(slot),
    async idle() {
      const seen = Atomics.load(m, M_WAKE);
      if (waitAsync) await waitAsync(m, M_WAKE, seen, 250).value;
      else await sleep(25);
    },
    failed(on) {
      if ((Atomics.load(m, M_ERROR) !== 0) === on) return;
      Atomics.store(m, M_ERROR, on ? 1 : 0);
      Atomics.add(m, M_SEQ, 1);
      Atomics.notify(m, M_SEQ);
    },
  };
}

let postedAnchor = 0;
let postedWake: (() => void) | null = null;
/**
 * Posted mode: the blocks the reader holds. It reports every eviction and every block it fetched
 * for itself, so this mirrors its cache; guessing instead makes the stream jump back and forth
 * between the file header (re-read by every decode slice) and the data.
 */
const held = new Set<number>();

function postedSink(blockSize: number): Sink {
  return {
    anchor: () => postedAnchor,
    known(into) {
      into.clear();
      for (const b of held) into.add(b);
    },
    has: (b) => held.has(b),
    begin: () => ({ buffer: new Uint8Array(blockSize), token: 0 }),
    commit(_token, buffer, b, bytes) {
      held.add(b);
      const data = bytes === buffer.length ? buffer : buffer.slice(0, bytes);
      post({ type: 'block', index: b, data: data.buffer }, [data.buffer]);
    },
    cancel() {},
    idle: () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, 250);
        function done() {
          clearTimeout(timer);
          if (postedWake === done) postedWake = null;
          resolve();
        }
        postedWake = done;
      }),
    failed() {},
  };
}

interface Cursor {
  /** Block the next bytes of the stream belong to. */
  next: number;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  abort: AbortController | null;
  /** Storage being filled for `next`. */
  buffer: Uint8Array | null;
  token: number;
  fill: number;
  /** `next` is already there: let its bytes go by. */
  skip: boolean;
}

let sink: Sink | null = null;
let blob: Blob | null = null;
let url = '';
let size = 0;
let blockSize = 0;
let lastBlock = 0;
let cursor: Cursor | null = null;
let epoch = 0;
let paused = false;
const have = new Set<number>();

/** Thrown inside the pump when the reader has moved somewhere this stream is not going. */
const MOVED = Symbol('moved');

function closeCursor(): void {
  const c = cursor;
  if (!c) return;
  cursor = null;
  if (c.buffer) sink!.cancel(c.token);
  c.abort?.abort();
  c.reader.cancel().catch(() => {});
}

/** First block of the read-ahead window that is not there yet, or -1 when the window is full. */
function nextMissing(): number {
  const s = sink!;
  const anchor = s.anchor();
  s.known(have);
  const end = Math.min(lastBlock, anchor + IO_WINDOW);
  for (let b = anchor; b <= end; b++) if (!have.has(b)) return b;
  return -1;
}

/** Would continuing the current stream reach `target` soon enough? */
function onCourse(target: number): boolean {
  return !!cursor && target >= cursor.next && target - cursor.next <= IO_SKIP;
}

async function open(block: number): Promise<void> {
  closeCursor();
  const start = block * blockSize;
  const blank = { buffer: null, token: 0, fill: 0, skip: false };
  if (blob) {
    cursor = { next: block, reader: blob.slice(start).stream().getReader(), abort: null, ...blank };
    return;
  }
  const abort = new AbortController();
  const res = await fetch(url, { headers: { Range: `bytes=${start}-` }, signal: abort.signal });
  if (res.status !== 206 && !(res.status === 200 && start === 0)) {
    abort.abort();
    throw new Error(`HTTP ${res.status} for a range request`);
  }
  cursor = { next: block, reader: res.body!.getReader(), abort, ...blank };
}

/** Read one chunk from the stream and file it into blocks. */
async function pump(myEpoch: number): Promise<void> {
  const s = sink!;
  const cur = cursor!;
  const B = blockSize;
  const { done, value } = await cur.reader.read();
  if (epoch !== myEpoch || cursor !== cur) return;
  if (done) {
    // A stream that stops short of the end of the file was cut off: reopen where it stopped.
    if (cur.next <= lastBlock) throw new Error('stream ended early');
    closeCursor();
    return;
  }
  let off = 0;
  while (off < value.length) {
    if (cur.next > lastBlock) break; // more bytes than the size we were told: ignore the surplus
    const b = cur.next;
    const blockBytes = Math.min(B, size - b * B);
    if (!cur.buffer && !cur.skip) {
      if (s.has(b)) cur.skip = true;
      else {
        // No room means the reader has not freed any yet; it does so on its next read.
        for (;;) {
          const got = s.begin();
          if (got) {
            cur.buffer = got.buffer;
            cur.token = got.token;
            break;
          }
          await sleep(4);
          if (epoch !== myEpoch || cursor !== cur) return;
          const target = nextMissing();
          if (target >= 0 && !onCourse(target)) throw MOVED;
        }
      }
    }
    const n = Math.min(value.length - off, blockBytes - cur.fill);
    if (cur.buffer) cur.buffer.set(value.subarray(off, off + n), cur.fill);
    cur.fill += n;
    off += n;
    if (cur.fill >= blockBytes) {
      if (cur.buffer) s.commit(cur.token, cur.buffer, b, blockBytes);
      cur.buffer = null;
      cur.skip = false;
      cur.fill = 0;
      cur.next++;
    }
  }
}

async function run(myEpoch: number): Promise<void> {
  const s = sink!;
  let failures = 0;
  while (epoch === myEpoch) {
    if (paused) {
      closeCursor();
      await sleep(50);
      continue;
    }
    const target = nextMissing();
    if (target < 0) {
      await s.idle();
      continue;
    }
    try {
      if (!onCourse(target)) await open(target);
      if (epoch !== myEpoch) return;
      await pump(myEpoch);
      failures = 0;
      s.failed(false);
    } catch (err) {
      if (epoch !== myEpoch) return;
      closeCursor();
      if (err === MOVED) continue;
      failures++;
      if (failures >= 4) {
        // Tell the reader to stop waiting; keep trying in case the source comes back.
        s.failed(true);
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      await sleep(Math.min(4000, 150 * 2 ** failures));
    }
  }
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'at') {
    postedAnchor = msg.block;
    for (const b of msg.gone ?? []) held.delete(b);
    postedWake?.();
    return;
  }
  if (msg.type === 'have') {
    for (let k = 0; k < msg.count; k++) held.add(msg.first + k);
    return;
  }
  if (msg.type === 'pause') {
    paused = !!msg.on;
    return;
  }
  if (msg.type !== 'open') return;
  epoch++;
  closeCursor();
  blob = msg.blob ?? null;
  url = msg.url ?? '';
  size = msg.size;
  paused = false;
  if (msg.sab) {
    const cache = new BlockCache(msg.sab);
    cache.reset();
    blockSize = cache.block;
    sink = sharedSink(cache);
  } else {
    blockSize = msg.block;
    postedAnchor = 0;
    held.clear();
    sink = postedSink(blockSize);
  }
  lastBlock = Math.max(0, Math.ceil(size / blockSize) - 1);
  post({ type: 'ready' });
  void run(epoch);
};
