import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { addMatroskaHdrMetadata } from '../../scripts/mkv-hdr.mjs';
import { DEFAULT_RENDER_SETTINGS, type ColorInfo, type MediaFrame, type RenderSettings } from '../../src/core/types';
import {
  av1cHdrMetadata,
  av1HdrMetadata,
  cleanHdrMetadata,
  ffprobeHdrMetadata,
  hdrMetadataComplete,
  hvccHdrMetadata,
  MATROSKA_HEAD,
  matroskaHdrMetadata,
  matroskaTracks,
  mergeHdrMetadata,
  nalLengthSize,
  seiHdrMetadata,
} from '../../src/pipeline/hdr-metadata';
import { choosePeak, describeHdrMetadata, metadataPeak, PEAK_GRID, PEAK_TAU, peakKey, peakTaps, PeakTracker } from '../../src/render/peak';

/**
 * Static HDR10 metadata out of the bytes that carry it, and the decisions about the peak that do
 * not need a GPU. No browser: byte sequences are built here the way encoders and muxers write them.
 */

const u16 = (v: number) => [(v >> 8) & 255, v & 255];
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const bytes = (...parts: Array<number | number[] | Uint8Array>) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'number' ? [p] : [...p])));

// BT.2020 primaries and D65 in units of 0.00002, as every HDR10 stream has them.
const PRIMARIES = [...u16(8500), ...u16(39850), ...u16(6550), ...u16(2300), ...u16(35400), ...u16(14600), ...u16(15635), ...u16(16450)];

/** One SEI message: type and size in the 0xFF-run coding, then the payload. */
function seiMessage(type: number, payload: number[]): number[] {
  const run = (v: number) => [...Array(Math.floor(v / 255)).fill(255), v % 255];
  return [...run(type), ...run(payload.length), ...payload];
}

/** What an encoder does to a payload before it goes into a NAL unit: emulation prevention. */
function escape(rbsp: number[]): number[] {
  const out: number[] = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out;
}

// 4000-nit mastering display with a 0.005-nit black, MaxCLL 4000, MaxFALL 400.
const MDCV = seiMessage(137, [...PRIMARIES, ...u32(4000 * 10000), ...u32(50)]);
const CLL = seiMessage(144, [...u16(4000), ...u16(400)]);
const hevcSei = (...messages: number[][]) => [0x4e, 0x01, ...escape([...messages.flat(), 0x80])];
const avcSei = (...messages: number[][]) => [0x06, ...escape([...messages.flat(), 0x80])];
const HEVC_SLICE = [0x26, 0x01, 0xaf, 0x09, 0x40, 0x12, 0x34]; // an IDR slice, never looked into
const lengthPrefixed = (nals: number[][], size = 4) => bytes(...nals.map((n) => [...u32(n.length).slice(4 - size), ...n]));
const EXPECTED = { maxCll: 4000, maxFall: 400, masteringMax: 4000, masteringMin: 0.005 };

test.describe('HEVC and AVC: SEI messages 137 and 144', () => {
  test('are found in a length-prefixed access unit, behind other NAL units and other SEI messages', () => {
    // The mastering luminance contains 00 00 00 32: without undoing emulation prevention it reads wrong.
    expect(hevcSei(MDCV).length, 'the test data does contain emulation-prevention bytes').toBeGreaterThan(2 + MDCV.length + 1);
    const userData = seiMessage(5, Array(300).fill(0x41)); // a size that needs the 0xFF run
    const packet = lengthPrefixed([[0x40, 0x01, 0x0c], hevcSei(userData, MDCV, CLL), HEVC_SLICE]);
    expect(seiHdrMetadata(packet, 'hevc')).toEqual(EXPECTED);
    // One message per NAL unit, as x265 writes them, and a two-byte length field.
    expect(seiHdrMetadata(lengthPrefixed([hevcSei(CLL), hevcSei(MDCV), HEVC_SLICE], 2), 'hevc', 2)).toEqual(EXPECTED);
  });

  test('are found in an Annex B access unit (MPEG-TS), with three- and four-byte start codes', () => {
    const packet = bytes([0, 0, 0, 1], [0x46, 0x01, 0x50], [0, 0, 1], hevcSei(MDCV), [0, 0, 0, 1], hevcSei(CLL), [0, 0, 1], HEVC_SLICE);
    expect(seiHdrMetadata(packet, 'hevc')).toEqual(EXPECTED);
  });

  test('are found in the SEI array of an hvcC record, which also gives the NAL length size', () => {
    const sei = hevcSei(MDCV, CLL);
    const header = Array(22).fill(0);
    header[0] = 1;
    header[21] = 0xfc | 3; // lengthSizeMinusOne = 3
    const vps = [0x40, 0x01, 0x0c, 0x01];
    const hvcc = bytes(header, 2, [0xa0, ...u16(1), ...u16(vps.length), ...vps], [0xa7, ...u16(1), ...u16(sei.length), ...sei]);
    expect(hvccHdrMetadata(hvcc)).toEqual(EXPECTED);
    expect(nalLengthSize(hvcc, 'hevc')).toBe(4);
    header[21] = 0xfc | 1;
    expect(nalLengthSize(bytes(header, 0), 'hevc')).toBe(2);
    expect(hvccHdrMetadata(bytes(header, 0)), 'a record without SEI says nothing').toBeNull();
  });

  test('AVC carries the same messages in NAL type 6', () => {
    expect(seiHdrMetadata(lengthPrefixed([avcSei(MDCV, CLL), [0x65, 0x88, 0x84]]), 'avc')).toEqual(EXPECTED);
    expect(nalLengthSize(bytes([1, 100, 0, 40, 0xff]), 'avc')).toBe(4);
  });

  test('a stream that says half, nothing, or nonsense', () => {
    expect(seiHdrMetadata(lengthPrefixed([hevcSei(CLL), HEVC_SLICE]), 'hevc')).toEqual({ maxCll: 4000, maxFall: 400 });
    expect(seiHdrMetadata(lengthPrefixed([HEVC_SLICE]), 'hevc')).toBeNull();
    // MaxCLL 0 means "unknown", not "black".
    expect(seiHdrMetadata(lengthPrefixed([hevcSei(seiMessage(144, [0, 0, 0, 0]))]), 'hevc')).toBeNull();
    // Cut off in the middle of a message, a length that points past the end, plain noise.
    const whole = lengthPrefixed([hevcSei(MDCV, CLL)]);
    for (let n = 0; n < whole.length; n++) expect(() => seiHdrMetadata(whole.subarray(0, n), 'hevc')).not.toThrow();
    expect(seiHdrMetadata(bytes(u32(1000), hevcSei(CLL)), 'hevc')).toBeNull();
    let seed = 7;
    const noise = Uint8Array.from({ length: 4096 }, () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
    for (const codec of ['hevc', 'avc'] as const) expect(() => seiHdrMetadata(noise, codec)).not.toThrow();
    expect(() => hvccHdrMetadata(noise)).not.toThrow();
  });
});

test.describe('AV1: metadata OBUs', () => {
  const obu = (type: number, payload: number[]) => [(type << 3) | 2, payload.length, ...payload];
  const TD = obu(2, []);
  const SEQ = obu(1, [0x0a, 0x0b, 0x00, 0x00, 0x00, 0x24]);
  const cll = obu(5, [1, ...u16(4000), ...u16(400)]);
  // Luminance as 24.8 and 18.14 fixed point.
  const mdcv = obu(5, [2, ...PRIMARIES, ...u32(4000 * 256), ...u32(Math.round(0.005 * 16384))]);

  test('HDR_CLL and HDR_MDCV are found in a temporal unit and in av1C', () => {
    const found = av1HdrMetadata(bytes(TD, SEQ, cll, mdcv, obu(6, [1, 2, 3, 4])))!;
    expect(found.maxCll).toBe(4000);
    expect(found.maxFall).toBe(400);
    expect(found.masteringMax).toBe(4000);
    expect(found.masteringMin).toBeCloseTo(0.005, 4);
    expect(av1cHdrMetadata(bytes([0x81, 0x09, 0x0c, 0x00], SEQ, cll))).toEqual({ maxCll: 4000, maxFall: 400 });
    expect(av1cHdrMetadata(bytes([0x81, 0x09, 0x0c, 0x00], SEQ))).toBeNull();
  });

  test('other metadata types, an OBU with an extension byte, and damaged data are passed over', () => {
    const itut35 = obu(5, [4, 0xb5, 0x00, 0x3c, 0x00, 0x01, 0x04]);
    const withExtension = [(5 << 3) | 4 | 2, 0x00, 5, 1, ...u16(1000), ...u16(180)];
    expect(av1HdrMetadata(bytes(TD, itut35, withExtension))).toEqual({ maxCll: 1000, maxFall: 180 });
    const whole = bytes(TD, SEQ, cll, mdcv);
    for (let n = 0; n < whole.length; n++) expect(() => av1HdrMetadata(whole.subarray(0, n))).not.toThrow();
    expect(av1HdrMetadata(bytes(0x80, cll)), 'forbidden bit: not an OBU stream').toBeNull();
  });
});

test.describe('Matroska: the Colour element', () => {
  const PATCHED = readFileSync('public/media/hdr_pq_vp9_colour.webm');
  const PLAIN = readFileSync('public/media/vp9_10bit_opus.webm');

  test('a WebM file as the generator leaves it: found in the head, for the video track', () => {
    const r = matroskaTracks(PATCHED.subarray(0, MATROSKA_HEAD));
    expect(r && 'tracks' in r).toBe(true);
    const tracks = (r as { tracks: Uint8Array }).tracks;
    const found = matroskaHdrMetadata(tracks, 1)!;
    expect(found.maxCll).toBe(4000);
    expect(found.maxFall).toBe(1800);
    expect(found.masteringMax).toBe(4000);
    expect(found.masteringMin).toBeCloseTo(0.005, 6);
    // Track 2 is the audio track: the first video track answers for a number that is not one.
    expect(matroskaHdrMetadata(tracks, 2)?.maxCll).toBe(4000);
    expect(matroskaHdrMetadata(tracks)?.maxCll).toBe(4000);
  });

  test('a file whose track header says nothing', () => {
    const r = matroskaTracks(PLAIN.subarray(0, MATROSKA_HEAD)) as { tracks: Uint8Array };
    expect('tracks' in r).toBe(true);
    expect(matroskaHdrMetadata(r.tracks, 1)).toBeNull();
    expect(matroskaTracks(readFileSync('public/media/h264_aac.mp4').subarray(0, 4096)), 'not Matroska at all').toBeNull();
  });

  test('a head that ends inside Tracks asks for the rest of it, and no more', () => {
    const at = PATCHED.indexOf(Buffer.from([0x16, 0x54, 0xae, 0x6b]), 120);
    const r = matroskaTracks(PATCHED.subarray(0, at + 40)) as { read: { start: number; end: number } };
    expect(r.read.start).toBe(at);
    expect(r.read.end).toBeLessThan(at + 400);
    const again = matroskaTracks(PATCHED.subarray(r.read.start, r.read.end), r.read.start) as { tracks: Uint8Array };
    expect(matroskaHdrMetadata(again.tracks, 1)?.maxCll).toBe(4000);
  });

  test('Tracks behind something large is reached through the seek head', () => {
    // EBML header | Segment { SeekHead -> Tracks | 100 kB of attachments | Tracks } built by hand.
    const el = (id: number[], payload: number[] | Uint8Array) => {
      const n = payload.length;
      const size = n < 127 ? [0x80 | n] : [0x08, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
      return [...id, ...size, ...payload];
    };
    const colour = el([0x55, 0xb0], [...el([0x55, 0xbc], u16(1000)), ...el([0x55, 0xd0], el([0x55, 0xd9], [0x44, 0x7a, 0x00, 0x00]))]);
    const entry = el([0xae], [...el([0xd7], [3]), ...el([0x83], [1]), ...el([0xe0], colour)]);
    const tracks = el([0x16, 0x54, 0xae, 0x6b], entry);
    const attachments = el([0x19, 0x41, 0xa4, 0x69], new Uint8Array(100_000));
    const seekHead = (pos: number) =>
      el([0x11, 0x4d, 0x9b, 0x74], el([0x4d, 0xbb], [...el([0x53, 0xab], [0x16, 0x54, 0xae, 0x6b]), ...el([0x53, 0xac], u32(pos))]));
    const body = [...seekHead(seekHead(0).length + attachments.length), ...attachments, ...tracks];
    const ebml = el([0x1a, 0x45, 0xdf, 0xa3], [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
    const file = bytes(ebml, [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], body); // unknown-size Segment
    const first = matroskaTracks(file.subarray(0, MATROSKA_HEAD)) as { read: { start: number; end: number } };
    expect(first.read.start).toBe(file.length - tracks.length);
    const second = matroskaTracks(file.subarray(first.read.start, first.read.end), first.read.start) as { tracks: Uint8Array };
    expect(matroskaHdrMetadata(second.tracks, 3)).toEqual({ maxCll: 1000, masteringMax: 1000 });
    // Without a seek head the walk goes on behind what it could not read.
    const noIndex = bytes(ebml, [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], attachments, tracks);
    const hop = matroskaTracks(noIndex.subarray(0, MATROSKA_HEAD)) as { read: { start: number; end: number } };
    expect(hop.read.start).toBe(noIndex.length - tracks.length);
    // A file that begins with its clusters has no track header left to find.
    const cluster = el([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0x00]);
    expect(
      matroskaTracks(bytes(ebml, [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], cluster, tracks)),
    ).toBeNull();
  });

  test('the generator edits the track header without moving anything behind it', () => {
    const patched = addMatroskaHdrMetadata(PLAIN, { maxCll: 1200, maxFall: 300, masteringMax: 1000, masteringMin: 0.01 });
    expect(patched.length).toBe(PLAIN.length);
    const before = (matroskaTracks(PLAIN.subarray(0, MATROSKA_HEAD)) as { tracks: Uint8Array }).tracks;
    const after = (matroskaTracks(patched.subarray(0, MATROSKA_HEAD)) as { tracks: Uint8Array }).tracks;
    const end = (b: Buffer, t: Uint8Array) => t.byteOffset - b.byteOffset + t.length;
    expect(end(patched, after), 'Tracks ends where it ended').toBe(end(PLAIN, before));
    expect(patched.subarray(end(patched, after)).equals(PLAIN.subarray(end(PLAIN, before))), 'the rest of the file is untouched').toBe(
      true,
    );
    const found = matroskaHdrMetadata(after, 1)!;
    expect([found.maxCll, found.maxFall, found.masteringMax]).toEqual([1200, 300, 1000]);
    expect(found.masteringMin).toBeCloseTo(0.01, 6);
  });
});

test('ffprobe side data, of a stream or of a frame', () => {
  const list = [
    {
      side_data_type: 'Mastering display metadata',
      red_x: '35400/50000',
      min_luminance: '50/10000',
      max_luminance: '40000000/10000',
    },
    { side_data_type: 'Content light level metadata', max_content: 4000, max_average: 400 },
    { side_data_type: 'H.26[45] User Data Unregistered SEI message' },
  ];
  expect(ffprobeHdrMetadata(list)).toEqual(EXPECTED);
  expect(ffprobeHdrMetadata([list[2]])).toBeNull();
  expect(ffprobeHdrMetadata(undefined)).toBeNull();
  expect(ffprobeHdrMetadata([{ side_data_type: 'Content light level metadata', max_content: 0, max_average: 0 }])).toBeNull();
});

test('metadata is cleaned of what cannot be, and two sources complete each other', () => {
  expect(cleanHdrMetadata({ maxCll: 0, maxFall: 0, masteringMax: 0, masteringMin: 0 })).toBeNull();
  expect(cleanHdrMetadata({ maxCll: 65535, masteringMax: 1000, masteringMin: 0.0001 }), 'beyond what PQ can code').toEqual({
    masteringMax: 1000,
    masteringMin: 0.0001,
  });
  expect(cleanHdrMetadata({ maxCll: 800, maxFall: 900 }), 'an average above the maximum').toEqual({ maxCll: 800 });
  expect(cleanHdrMetadata({ masteringMin: 0.005 }), 'a black level alone is not metadata').toBeNull();
  expect(cleanHdrMetadata({ masteringMax: 1000, masteringMin: 2000 })).toEqual({ masteringMax: 1000 });
  expect(cleanHdrMetadata({ maxCll: NaN, masteringMax: Infinity })).toBeNull();
  // The first source wins where both speak.
  expect(mergeHdrMetadata({ maxCll: 1000 }, { maxCll: 4000, masteringMax: 4000 })).toEqual({ maxCll: 1000, masteringMax: 4000 });
  expect(mergeHdrMetadata(null, { masteringMax: 600 })).toEqual({ masteringMax: 600 });
  expect(mergeHdrMetadata(null, null)).toBeNull();
  expect(hdrMetadataComplete({ maxCll: 1000 })).toBe(false);
  expect(hdrMetadataComplete({ maxCll: 1000, masteringMax: 1000 })).toBe(true);
});

const PQ = (hdrMetadata?: ColorInfo['hdrMetadata']): ColorInfo => ({
  primaries: 'bt2020',
  transfer: 'pq',
  matrix: 'bt2020nc',
  fullRange: false,
  hdrMetadata,
});
const settings = (patch: Partial<RenderSettings>): RenderSettings => ({ ...DEFAULT_RENDER_SETTINGS, ...patch });

test('which peak a frame is tone-mapped with: measured, the stream, a number, each falling back on the next', () => {
  // MaxCLL describes the content, the mastering peak only the monitor.
  expect(metadataPeak(PQ({ maxCll: 1200, masteringMax: 4000 }))).toEqual({ nits: 1200, from: 'MaxCLL' });
  expect(metadataPeak(PQ({ masteringMax: 4000 }))).toEqual({ nits: 4000, from: 'mastering display' });
  // A "peak" far below SDR white is a muxer's placeholder, not a measurement.
  expect(metadataPeak(PQ({ maxCll: 12, masteringMax: 1000 }))).toEqual({ nits: 1000, from: 'mastering display' });
  expect(metadataPeak(PQ({ maxCll: 12 }))).toBeNull();
  expect(metadataPeak(PQ())).toBeNull();

  expect(DEFAULT_RENDER_SETTINGS.hdrPeakSource).toBe('measured');
  const tagged = PQ({ maxCll: 4000, masteringMax: 4000 });
  expect(choosePeak(tagged, settings({}), true).source).toBe('measured');
  // A renderer that cannot measure uses what the stream says, and says so.
  const cannot = choosePeak(tagged, settings({}), false);
  expect([cannot.source, cannot.nits]).toEqual(['metadata', 4000]);
  expect(cannot.detail).toContain('MaxCLL');
  expect(cannot.detail).toContain('cannot measure');
  expect(choosePeak(tagged, settings({ hdrPeakSource: 'metadata' }), true)).toEqual({
    source: 'metadata',
    nits: 4000,
    detail: '4000 nits (MaxCLL)',
  });
  // Nothing in the stream: the fixed value, and the overlay says it is an assumption.
  const untagged = choosePeak(PQ(), settings({ hdrPeakSource: 'metadata', hdrPeak: 1000 }), true);
  expect([untagged.source, untagged.nits]).toEqual(['fixed', 1000]);
  expect(untagged.detail).toContain('assumed');
  expect(choosePeak(tagged, settings({ hdrPeakSource: 'fixed', hdrPeak: 600 }), true)).toEqual({
    source: 'fixed',
    nits: 600,
    detail: '600 nits (fixed)',
  });
  expect(describeHdrMetadata(tagged)).toBe('MaxCLL 4000, mastering display 0–4000 nits');
  expect(describeHdrMetadata(PQ({ maxCll: 1000, maxFall: 400, masteringMax: 1000, masteringMin: 0.005 }))).toBe(
    'MaxCLL 1000, MaxFALL 400, mastering display 0.005–1000 nits',
  );
  expect(describeHdrMetadata(PQ())).toBe('');
});

test('the measuring grid sees every pixel up to 4K and stays bounded beyond', () => {
  expect(peakTaps(640, 360)).toEqual([5, 3]);
  expect(peakTaps(1920, 1080)).toEqual([15, 9]);
  for (const [w, h] of [
    [320, 180],
    [1920, 1080],
    [3840, 2160],
  ]) {
    const [nx, ny] = peakTaps(w, h);
    // A bilinear tap covers two pixels: the taps of a cell must span the cell.
    expect(nx * 2 * PEAK_GRID).toBeGreaterThanOrEqual(w);
    expect(ny * 2 * PEAK_GRID).toBeGreaterThanOrEqual(h);
  }
  expect(peakTaps(7680, 4320)).toEqual([32, 32]);
  expect(peakTaps(16, 16)).toEqual([1, 1]);
});

test('the peak state follows a run of pictures, and starts over at anything else', () => {
  const planar = (pts: number, duration = 1 / 24): MediaFrame =>
    ({
      kind: 'planar',
      pts,
      duration,
      width: 640,
      height: 360,
      bitDepth: 10,
      planes: [new Uint8Array(1), new Uint8Array(1), new Uint8Array(1)],
      chromaWidth: 320,
      chromaHeight: 180,
      color: PQ(),
      rotation: 0,
    }) as MediaFrame;
  const t = new PeakTracker();
  const a = planar(10);
  const key = peakKey(a, '');
  // The first picture is all there is to go by.
  expect(t.step(a, key)).toEqual({ reset: true, alpha: 1 });
  // Drawn again (a resize, a setting, a screenshot): nothing is measured, the state stands.
  expect(t.step(a, key)).toBeNull();
  expect(t.step(a, key)).toBeNull();
  // The next picture is blended in according to how much time it stands for.
  const b = t.step(planar(10 + 1 / 24), key)!;
  expect(b.reset).toBe(false);
  expect(b.alpha).toBeCloseTo(1 - Math.exp(-1 / 24 / PEAK_TAU), 6);
  // A few dropped frames are still the same run, with more weight.
  const c = t.step(planar(10 + 5 / 24), key)!;
  expect(c.reset).toBe(false);
  expect(c.alpha).toBeGreaterThan(b.alpha * 3);
  // A seek forwards, a step backwards, another picture at the same time: each starts over.
  expect(t.step(planar(40), key)).toEqual({ reset: true, alpha: 1 });
  expect(t.step(planar(40 - 1 / 24), key)).toEqual({ reset: true, alpha: 1 });
  expect(t.step(planar(40 - 1 / 24), key)).toEqual({ reset: true, alpha: 1 });
  // So does a stream with other tags or another way of unpacking, and a pipeline that went away.
  const next = planar(40);
  expect(t.step(next, peakKey(next, 'coded'))).toEqual({ reset: true, alpha: 1 });
  expect(peakKey(next, 'coded')).not.toBe(peakKey(next, 'coded-srgb'));
  expect(peakKey({ ...next, color: { ...next.color, transfer: 'hlg' } } as MediaFrame, '')).not.toBe(key);
  t.reset();
  expect(t.step(next, peakKey(next, 'coded'))).toEqual({ reset: true, alpha: 1 });
  // A slide show at one picture a second is a run too.
  const slow = new PeakTracker();
  expect(slow.step(planar(0, 1), key)!.reset).toBe(true);
  expect(slow.step(planar(1, 1), key)!.reset).toBe(false);
  // A <video> element is one object for all of its pictures: the time tells them apart.
  const el = {} as HTMLVideoElement;
  const element = (pts: number): MediaFrame => ({
    kind: 'element',
    pts,
    duration: 1 / 30,
    width: 640,
    height: 360,
    el,
    color: PQ(),
    rotation: 0,
  });
  const v = new PeakTracker();
  const vk = peakKey(element(0), 'coded');
  expect(v.step(element(2), vk)!.reset).toBe(true);
  expect(v.step(element(2), vk)).toBeNull();
  expect(v.step(element(2 + 1 / 30), vk)!.reset).toBe(false);
});
