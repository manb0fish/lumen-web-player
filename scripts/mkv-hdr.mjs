// Writes static HDR10 metadata into the Colour element of a Matroska / WebM file's video track.
//
// The ffmpeg build that generates the test media has no way to do this (its encoders do not pass
// the metadata on to the muxer), and for VP9 the container is the only place such metadata can
// live. So the track header is edited in place: the Colour element grows by a few bytes, which
// are taken from the Void element the muxer leaves in front of the segment information. Nothing
// behind the Tracks element moves; the seek-head entries of what does move are adjusted.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Void: 0xec,
  Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675,
  TrackEntry: 0xae,
  TrackType: 0x83,
  Video: 0xe0,
  Colour: 0x55b0,
  MaxCLL: 0x55bc,
  MaxFALL: 0x55bd,
  MasteringMetadata: 0x55d0,
  LuminanceMax: 0x55d9,
  LuminanceMin: 0x55da,
};

/** Element header at offset o: { id, start, data, size, end, sizeLen }. */
function element(b, o) {
  const f = b[o];
  const idLen = f & 0x80 ? 1 : f & 0x40 ? 2 : f & 0x20 ? 3 : 4;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + b[o + i];
  const s = b[o + idLen];
  let sizeLen = 1;
  let mask = 0x80;
  while (!(s & mask)) {
    sizeLen++;
    mask >>= 1;
  }
  let size = s & (mask - 1);
  for (let i = 1; i < sizeLen; i++) size = size * 256 + b[o + idLen + i];
  const data = o + idLen + sizeLen;
  return { id, start: o, data, size, end: data + size, sizeLen };
}

function children(b, from, to) {
  const out = [];
  for (let o = from; o < to;) {
    const e = element(b, o);
    out.push(e);
    o = e.end;
  }
  return out;
}

function idBytes(id) {
  const out = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return Buffer.from(out);
}

/** EBML size field for n, in `len` bytes (the shortest that fits when len is not given). */
function sizeBytes(n, len) {
  if (!len) for (len = 1; n >= 2 ** (7 * len) - 1; len++);
  if (n >= 2 ** (7 * len) - 1) throw new Error(`size ${n} does not fit ${len} bytes`);
  const out = Buffer.alloc(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

const master = (id, payload, sizeLen) => Buffer.concat([idBytes(id), sizeBytes(payload.length, sizeLen), payload]);

function uint(id, value) {
  const bytes = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return master(id, Buffer.from(bytes.length ? bytes : [0]));
}

function float(id, value) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(value);
  return master(id, b);
}

/**
 * @param {Buffer} file  a Matroska / WebM file written by ffmpeg
 * @param {{maxCll?: number, maxFall?: number, masteringMax?: number, masteringMin?: number}} meta  nits
 * @returns {Buffer} the same file, same length, with the metadata in its first video track
 */
export function addMatroskaHdrMetadata(file, meta) {
  const head = element(file, 0);
  if (head.id !== ID.EBML) throw new Error('not an EBML file');
  const segment = element(file, head.end);
  if (segment.id !== ID.Segment) throw new Error('no Segment');

  // Level-1 elements up to and including Tracks.
  const level1 = [];
  for (let o = segment.data; ;) {
    const e = element(file, o);
    if (e.id === ID.Cluster) throw new Error('no Tracks before the first Cluster');
    level1.push(e);
    if (e.id === ID.Tracks) break;
    o = e.end;
  }
  const tracks = level1[level1.length - 1];
  const voidIndex = level1.findLastIndex((e) => e.id === ID.Void);
  if (voidIndex < 0) throw new Error('no Void element in front of Tracks to take the space from');
  const spare = level1[voidIndex];

  // Rebuild Tracks with a longer Colour element in the first video track.
  const added = [];
  if (meta.maxCll) added.push(uint(ID.MaxCLL, Math.round(meta.maxCll)));
  if (meta.maxFall) added.push(uint(ID.MaxFALL, Math.round(meta.maxFall)));
  if (meta.masteringMax) {
    added.push(
      master(
        ID.MasteringMetadata,
        Buffer.concat([float(ID.LuminanceMax, meta.masteringMax), float(ID.LuminanceMin, meta.masteringMin ?? 0)]),
      ),
    );
  }
  let done = false;
  const entries = children(file, tracks.data, tracks.end).map((entry) => {
    const raw = file.subarray(entry.start, entry.end);
    if (done || entry.id !== ID.TrackEntry) return raw;
    const parts = children(file, entry.data, entry.end);
    const type = parts.find((p) => p.id === ID.TrackType);
    const video = parts.find((p) => p.id === ID.Video);
    if (!type || file[type.data] !== 1 || !video) return raw;
    done = true;
    const inVideo = children(file, video.data, video.end);
    const colour = inVideo.find((p) => p.id === ID.Colour);
    const newColour = master(ID.Colour, Buffer.concat([colour ? file.subarray(colour.data, colour.end) : Buffer.alloc(0), ...added]));
    const videoPayload = Buffer.concat([
      ...inVideo.map((p) => (p === colour ? newColour : file.subarray(p.start, p.end))),
      ...(colour ? [] : [newColour]),
    ]);
    const entryPayload = Buffer.concat(parts.map((p) => (p === video ? master(ID.Video, videoPayload) : file.subarray(p.start, p.end))));
    return master(ID.TrackEntry, entryPayload, entry.sizeLen);
  });
  if (!done) throw new Error('no video track');
  const newTracks = master(ID.Tracks, Buffer.concat(entries));
  const delta = newTracks.length - (tracks.end - tracks.start);
  if (spare.size < delta) throw new Error(`the Void element has ${spare.size} bytes, ${delta} are needed`);
  const newVoid = master(ID.Void, Buffer.alloc(spare.size - delta), spare.sizeLen);

  const out = Buffer.concat([
    file.subarray(0, spare.start),
    newVoid,
    file.subarray(spare.end, tracks.start),
    newTracks,
    file.subarray(tracks.end),
  ]);
  if (out.length !== file.length) throw new Error('length changed');

  // What lay between the Void and the end of Tracks now starts `delta` bytes earlier.
  const moved = new Set(level1.slice(voidIndex + 1).map((e) => e.start - segment.data));
  for (const sh of level1.filter((e) => e.id === ID.SeekHead && e.start < spare.start)) {
    for (const seek of children(out, sh.data, sh.end)) {
      if (seek.id !== ID.Seek) continue;
      const pos = children(out, seek.data, seek.end).find((p) => p.id === ID.SeekPosition);
      if (!pos) continue;
      let value = 0;
      for (let i = 0; i < pos.size; i++) value = value * 256 + out[pos.data + i];
      if (!moved.has(value)) continue;
      let v = value - delta;
      for (let i = pos.size - 1; i >= 0; i--) {
        out[pos.data + i] = v % 256;
        v = Math.floor(v / 256);
      }
    }
  }
  return out;
}
