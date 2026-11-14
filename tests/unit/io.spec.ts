import { expect, test } from '@playwright/test';
import { BlockCache, createReader, IO_KEEP_BEHIND, IO_WINDOW, M_READ_BLOCK, M_WAKE } from '../../src/pipeline/ffmpeg-io';

/**
 * The block cache FFmpeg's input is read through, without a browser: every byte must come back
 * exactly, whatever the order of reads, and eviction must never take a block the reader still
 * needs. A small block size keeps the test fast and makes boundaries frequent.
 */

const BLOCK = 1024;

/** A file whose byte at offset i is a function of i, so any misplaced block is visible. */
function makeFile(size: number): Uint8Array {
  const f = new Uint8Array(size);
  for (let i = 0; i < size; i++) f[i] = (i * 31 + (i >> 8) * 7 + (i >> 16)) & 0xff;
  return f;
}

/** Fill callback that serves blocks from `file`, recording what was asked for. */
function fillFrom(cache: BlockCache, file: Uint8Array, asked: number[]): (b: number) => boolean {
  return (b) => {
    asked.push(b);
    const slot = cache.claim();
    if (slot < 0) return false;
    const bytes = file.subarray(b * BLOCK, Math.min(file.length, (b + 1) * BLOCK));
    cache.data.set(bytes, slot * BLOCK);
    cache.publish(slot, b, bytes.length);
    return true;
  };
}

function setup(size: number, slots: number) {
  const file = makeFile(size);
  const cache = new BlockCache(new ArrayBuffer(BlockCache.bytes(slots, BLOCK)), slots, BLOCK);
  const asked: number[] = [];
  const read = createReader(cache, size, fillFrom(cache, file, asked));
  const readAt = (position: number, length: number): Uint8Array => {
    const out = new Uint8Array(length + 8).fill(0xee);
    const n = read(out, 4, length, position);
    expect(out[3], 'nothing written before the destination').toBe(0xee);
    expect(out[4 + Math.max(0, n)], 'nothing written past what was returned').toBe(0xee);
    return out.subarray(4, 4 + Math.max(0, n));
  };
  return { file, cache, asked, read, readAt };
}

test('sequential reads of FFmpeg-sized pieces return the file byte for byte', () => {
  const size = BLOCK * 37 + 311; // ends in a short block
  const { file, readAt, asked } = setup(size, 160);
  const got = new Uint8Array(size);
  let pos = 0;
  while (pos < size) {
    const part = readAt(pos, 333); // not a divisor of the block size: every boundary case occurs
    expect(part.length).toBeGreaterThan(0);
    got.set(part, pos);
    pos += part.length;
  }
  expect(Buffer.compare(Buffer.from(got), Buffer.from(file))).toBe(0);
  expect(asked, 'each block fetched once, in order').toEqual(Array.from({ length: 38 }, (_, i) => i));
  expect(readAt(size, 100).length, 'reading at the end of the file').toBe(0);
  expect(readAt(size - 5, 100).length, 'a read is cut at the end of the file').toBe(5);
});

test('random access over a file far larger than the cache stays correct', () => {
  const size = BLOCK * 600 + 17;
  const slots = 160;
  const { file, readAt } = setup(size, slots);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let i = 0; i < 4000; i++) {
    // Mostly short forward steps (a demuxer), sometimes a jump (a seek, an index at the end).
    const pos = i % 9 === 0 ? Math.floor(rnd() * size) : Math.min(size - 1, Math.floor(rnd() * BLOCK * 3) + ((i * 257) % size));
    const len = 1 + Math.floor(rnd() * BLOCK * 2.5);
    const part = readAt(pos, len);
    const want = file.subarray(pos, Math.min(size, pos + len));
    expect(part.length, `length of read ${i} at ${pos}`).toBe(want.length);
    if (Buffer.compare(Buffer.from(part), Buffer.from(want)) !== 0) throw new Error(`read ${i} at ${pos}+${len} returned wrong bytes`);
  }
});

test('eviction keeps the window around the reader and drops the least recently used block outside it', () => {
  const slots = 160;
  const { cache, readAt } = setup(BLOCK * 2000, slots);
  // Read far more than the cache holds, front to back.
  for (let b = 0; b < 400; b++) readAt(b * BLOCK, BLOCK);
  const at = 399;
  const ready = cache.ready(new Set<number>());
  for (let b = at - IO_KEEP_BEHIND; b <= at; b++) expect(ready.has(b), `block ${b} just behind the reader is kept`).toBe(true);
  expect(ready.has(0), 'the oldest block is gone').toBe(false);
  expect(ready.size).toBeLessThanOrEqual(slots);

  // Whatever the state, room is made without touching the protected window.
  cache.makeRoom(at, 40);
  const after = cache.ready(new Set<number>());
  expect(slots - after.size, 'free slots after making room').toBeGreaterThanOrEqual(40);
  for (let b = at - IO_KEEP_BEHIND; b <= at; b++) expect(after.has(b), `block ${b} survives making room`).toBe(true);
  // Of the unprotected blocks, the survivors are the most recently used ones.
  const survivors = [...after].filter((b) => b < at - IO_KEEP_BEHIND);
  const evicted = [...ready].filter((b) => !after.has(b));
  expect(Math.min(...survivors), 'evicted blocks are older than every surviving one').toBeGreaterThan(Math.max(...evicted));
  expect(IO_WINDOW + IO_KEEP_BEHIND, 'the protected window always fits in the cache').toBeLessThan(slots);
});

test('the reader publishes its position and wakes the writer whenever it moves to another block', () => {
  const { cache, readAt } = setup(BLOCK * 50, 160);
  const wake0 = cache.meta[M_WAKE];
  readAt(BLOCK * 7 + 10, 20);
  expect(cache.meta[M_READ_BLOCK]).toBe(7);
  expect(cache.meta[M_WAKE]).toBe(wake0 + 1);
  readAt(BLOCK * 7 + 40, 20); // same block: no new wake-up
  expect(cache.meta[M_WAKE]).toBe(wake0 + 1);
  readAt(BLOCK * 31, 20);
  expect(cache.meta[M_READ_BLOCK]).toBe(31);
  expect(cache.meta[M_WAKE]).toBe(wake0 + 2);
});

test('a block that cannot be delivered fails the read instead of returning garbage', () => {
  const file = makeFile(BLOCK * 10);
  const cache = new BlockCache(new ArrayBuffer(BlockCache.bytes(160, BLOCK)), 160, BLOCK);
  const asked: number[] = [];
  const good = fillFrom(cache, file, asked);
  const read = createReader(cache, file.length, (b) => (b === 3 ? false : good(b)));
  const out = new Uint8Array(BLOCK * 6);
  expect(read(out, 0, 100, BLOCK * 3 + 5), 'nothing readable').toBe(-1);
  // A read that starts in a good block returns what it has; the next one reports the failure.
  expect(read(out, 0, BLOCK * 3, BLOCK * 2)).toBe(BLOCK);
  expect(Buffer.compare(Buffer.from(out.subarray(0, BLOCK)), Buffer.from(file.subarray(BLOCK * 2, BLOCK * 3)))).toBe(0);
});
