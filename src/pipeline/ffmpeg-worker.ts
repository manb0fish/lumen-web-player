/**
 * Tier 3 worker: hosts an FFmpeg WebAssembly core and turns its blocking CLI into streams.
 *
 * The trick that makes "on the fly" possible with a synchronous `exec()` is a set of custom
 * Emscripten character devices. FFmpeg is told to write
 *     raw video   -> /dev/lumen_v      (rawvideo, yuv420p or yuv420p10le)
 *     raw audio   -> /dev/lumen_a      (f32le, native channel count)
 *     fMP4        -> /dev/lumen_m      (stream copy / audio transcode for the MSE tier)
 * and every write() lands in JS *while exec is still running*, where it is framed and posted out
 * immediately. Exact frame timestamps come from the `showinfo` filter's log lines, which are
 * emitted synchronously just before the matching frame reaches the muxer.
 *
 * Flow control:
 *   - With SharedArrayBuffer the device callbacks block on Atomics.wait() until the main thread
 *     has consumed enough frames / the clock has advanced, and abort the run as soon as the
 *     generation counter changes (seek, stop). One exec() covers the whole remaining file.
 *   - Without SharedArrayBuffer the worker cannot be reached while exec() runs, so the client asks
 *     for short, self-terminating segments (`-ss T -t D`) and paces them itself.
 */
import type { AudioTrackInfo, ColorInfo, MediaInfo, VideoTrackInfo } from '../core/types';
import { CTRL_CLOCK_MS, CTRL_GEN, CTRL_MSE_GATE, CTRL_RELEASED } from './ffmpeg-shared';

const post = (msg: any, transfer: Transferable[] = []) => (self as any).postMessage(msg, transfer);

const AUDIO_AHEAD_MS = 1500;
const AUDIO_CHUNK_FRAMES = 4096;
const EIO = 29;
const ESPIPE = 70;

let core: any = null;
let FS: any = null;
let ctrl: Int32Array | null = null;
let audioPort: MessagePort | null = null;
let inputPath = '';
let multiThread = false;
let logTail: string[] = [];
let capture: string[] | null = null;
const decoders = new Set<string>();

interface Job {
  gen: number;
  kind: 'decode' | 'remux';
  aborted: boolean;
  // video
  baseTime: number;
  width: number;
  height: number;
  bytesPerSample: number;
  bitDepth: number;
  frameBytes: number;
  dimsFromLog: boolean;
  cur: Uint8Array | null;
  curFill: number;
  ptsQueue: number[];
  lastRel: number;
  fps: number;
  sentFrames: number;
  maxQueue: number;
  // audio
  aChannels: number;
  aRate: number;
  aBuf: Uint8Array | null;
  aFill: number;
  aFramesSent: number;
  /** Player-timeline PTS of the first PCM sample. */
  audioBase: number;
  // remux
  bytes: number;
}

let job: Job | null = null;

function shouldAbort(): boolean {
  const j = job;
  if (!j) return true;
  if (j.aborted) return true;
  if (ctrl && Atomics.load(ctrl, CTRL_GEN) !== j.gen) {
    j.aborted = true;
    return true;
  }
  return false;
}

function onLog(line: string): void {
  const j = job;
  if (j && j.kind === 'decode' && line.includes('Parsed_showinfo')) {
    const m = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (m) {
      j.ptsQueue.push(parseFloat(m[1]));
      if (!j.dimsFromLog) {
        const s = /\bs:(\d+)x(\d+)/.exec(line);
        if (s) {
          j.width = +s[1];
          j.height = +s[2];
          j.frameBytes = frameSize(j.width, j.height, j.bytesPerSample);
          j.dimsFromLog = true;
        }
      }
    }
    return;
  }
  if (capture) {
    capture.push(line);
    return;
  }
  logTail.push(line);
  if (logTail.length > 80) logTail.shift();
}

function frameSize(w: number, h: number, bps: number): number {
  const cw = (w + 1) >> 1;
  const ch = (h + 1) >> 1;
  return (w * h + 2 * cw * ch) * bps;
}

function onVideoBytes(src: Uint8Array): void {
  const j = job!;
  let off = 0;
  while (off < src.length) {
    if (!j.cur) {
      j.cur = new Uint8Array(j.frameBytes);
      j.curFill = 0;
    }
    const n = Math.min(src.length - off, j.frameBytes - j.curFill);
    j.cur.set(src.subarray(off, off + n), j.curFill);
    j.curFill += n;
    off += n;
    if (j.curFill === j.frameBytes) emitFrame(j);
  }
}

function emitFrame(j: Job): void {
  const buf = j.cur!;
  j.cur = null;
  const rel = j.ptsQueue.length ? j.ptsQueue.shift()! : j.lastRel + 1 / j.fps;
  j.lastRel = rel;
  j.sentFrames++;
  post({ type: 'vframe', gen: j.gen, pts: j.baseTime + rel, width: j.width, height: j.height, bitDepth: j.bitDepth, buffer: buf.buffer }, [
    buf.buffer,
  ]);
  if (ctrl) {
    // Block FFmpeg until the presentation queue has room again.
    for (;;) {
      if (Atomics.load(ctrl, CTRL_GEN) !== j.gen) {
        j.aborted = true;
        break;
      }
      const released = Atomics.load(ctrl, CTRL_RELEASED);
      if (j.sentFrames - released < j.maxQueue) break;
      Atomics.wait(ctrl, CTRL_RELEASED, released, 40);
    }
  }
}

function onAudioBytes(src: Uint8Array): void {
  const j = job!;
  const chunkBytes = AUDIO_CHUNK_FRAMES * j.aChannels * 4;
  let off = 0;
  while (off < src.length) {
    if (!j.aBuf) {
      j.aBuf = new Uint8Array(chunkBytes);
      j.aFill = 0;
    }
    const n = Math.min(src.length - off, chunkBytes - j.aFill);
    j.aBuf.set(src.subarray(off, off + n), j.aFill);
    j.aFill += n;
    off += n;
    if (j.aFill === chunkBytes) emitAudio(j);
  }
}

function emitAudio(j: Job): void {
  const buf = j.aBuf;
  if (!buf) return;
  const ch = j.aChannels;
  const frames = Math.floor(j.aFill / (4 * ch));
  j.aBuf = null;
  j.aFill = 0;
  if (!frames) return;
  const inter = new Float32Array(buf.buffer, 0, frames * ch);
  const planes: Float32Array[] = [];
  for (let c = 0; c < ch; c++) {
    const p = new Float32Array(frames);
    for (let i = 0, k = c; i < frames; i++, k += ch) p[i] = inter[k];
    planes.push(p);
  }
  const pts = j.audioBase + j.aFramesSent / j.aRate;
  j.aFramesSent += frames;
  audioPort?.postMessage(
    { type: 'pcm', gen: j.gen, pts, channels: planes },
    planes.map((p) => p.buffer),
  );
  if (ctrl) {
    const endMs = (pts + frames / j.aRate) * 1000;
    for (;;) {
      if (Atomics.load(ctrl, CTRL_GEN) !== j.gen) {
        j.aborted = true;
        break;
      }
      const clock = Atomics.load(ctrl, CTRL_CLOCK_MS);
      if (endMs - clock <= AUDIO_AHEAD_MS) break;
      Atomics.wait(ctrl, CTRL_CLOCK_MS, clock, 40);
    }
  }
}

function onMuxBytes(src: Uint8Array): void {
  const j = job!;
  const copy = src.slice();
  j.bytes += copy.length;
  post({ type: 'chunk', gen: j.gen, data: copy.buffer }, [copy.buffer]);
  if (ctrl) {
    for (;;) {
      if (Atomics.load(ctrl, CTRL_GEN) !== j.gen) {
        j.aborted = true;
        break;
      }
      if (Atomics.load(ctrl, CTRL_MSE_GATE) !== 0) break;
      Atomics.wait(ctrl, CTRL_MSE_GATE, 0, 60);
    }
  }
}

function registerDevice(path: string, major: number, onWrite: (bytes: Uint8Array) => void): void {
  const dev = FS.makedev(major, 0);
  FS.registerDevice(dev, {
    open() {},
    close() {},
    read() {
      return 0;
    },
    write(_stream: any, buffer: Int8Array | Uint8Array, offset: number, length: number) {
      if (shouldAbort()) throw new FS.ErrnoError(EIO);
      onWrite(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length));
      return length;
    },
    llseek() {
      throw new FS.ErrnoError(ESPIPE);
    },
  });
  FS.mkdev(path, dev);
}

async function init(m: any): Promise<void> {
  multiThread = !!m.multiThread;
  if (m.sab) ctrl = new Int32Array(m.sab);
  if (m.audioPort) audioPort = m.audioPort;
  const { default: createFFmpegCore } = await import(/* @vite-ignore */ m.coreURL);
  const hash = btoa(JSON.stringify({ wasmURL: m.wasmURL, workerURL: m.workerURL ?? '' }));
  const opts: any = { mainScriptUrlOrBlob: `${m.coreURL}#${hash}` };
  let compiled: WebAssembly.Module | null = m.wasmModule ?? null;
  if (compiled) {
    // Re-instantiate from a cached, already-compiled module (fast worker respawn).
    opts.instantiateWasm = (imports: WebAssembly.Imports, done: (inst: WebAssembly.Instance, mod: WebAssembly.Module) => void) => {
      WebAssembly.instantiate(compiled!, imports).then((inst) => done(inst, compiled!));
      return {};
    };
  } else {
    opts.instantiateWasm = (imports: WebAssembly.Imports, done: (inst: WebAssembly.Instance, mod: WebAssembly.Module) => void) => {
      WebAssembly.compileStreaming(fetch(m.wasmURL))
        .then((mod) => {
          compiled = mod;
          return WebAssembly.instantiate(mod, imports);
        })
        .then((inst) => done(inst, compiled!));
      return {};
    };
  }
  core = await createFFmpegCore(opts);
  FS = core.FS;
  core.setLogger(({ message }: { type: string; message: string }) => onLog(message));
  try {
    FS.mkdir('/in');
  } catch {
    /* exists */
  }
  registerDevice('/dev/lumen_v', 71, onVideoBytes);
  registerDevice('/dev/lumen_a', 72, onAudioBytes);
  registerDevice('/dev/lumen_m', 73, onMuxBytes);
  // Learn which decoders this particular core was built with (a prebuilt core is not "all of FFmpeg").
  capture = [];
  try {
    core.exec('-hide_banner', '-decoders');
  } catch {
    /* listing is best-effort */
  }
  core.reset?.();
  for (const line of capture) {
    const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m) decoders.add(m[1]);
  }
  capture = null;
  post({ type: 'ready', id: m.id, wasmModule: m.wasmModule ? undefined : compiled, multiThread });
}

async function openInput(m: any): Promise<void> {
  let blob: Blob = m.blob;
  if (!blob && m.url) {
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} while fetching the source`);
    blob = await res.blob();
  }
  try {
    FS.unmount('/in');
  } catch {
    /* not mounted */
  }
  const ext = (m.ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  const name = `input.${ext}`;
  FS.mount(FS.filesystems.WORKERFS, { blobs: [{ name, data: blob }] }, '/in');
  inputPath = `/in/${name}`;
  post({ type: 'opened', id: m.id, size: blob.size });
}

// ---- probing -----------------------------------------------------------------------------------

function ratio(s: string | undefined): number {
  if (!s) return 0;
  const [a, b] = s.split('/').map(Number);
  return b ? a / b : a || 0;
}

function mapColor(s: any): ColorInfo {
  const p = s.color_primaries;
  const t = s.color_transfer;
  const m = s.color_space;
  return {
    primaries:
      p === 'bt709'
        ? 'bt709'
        : p === 'bt2020'
          ? 'bt2020'
          : p === 'smpte432'
            ? 'p3'
            : p === 'bt470bg' || p === 'smpte170m'
              ? 'bt601'
              : 'unknown',
    transfer:
      t === 'smpte2084'
        ? 'pq'
        : t === 'arib-std-b67'
          ? 'hlg'
          : t === 'iec61966-2-1'
            ? 'srgb'
            : t === 'linear'
              ? 'linear'
              : t && t !== 'unknown'
                ? 'bt709'
                : 'unknown',
    matrix:
      m === 'bt709'
        ? 'bt709'
        : m === 'bt2020nc'
          ? 'bt2020nc'
          : m === 'bt470bg' || m === 'smpte170m'
            ? 'bt601'
            : m === 'gbr'
              ? 'rgb'
              : 'unknown',
    fullRange: s.color_range === 'pc' || /^yuvj/.test(s.pix_fmt ?? ''),
  };
}

const H264_PROFILE: Record<string, string> = {
  'Constrained Baseline': '42E0',
  Baseline: '4200',
  Main: '4D00',
  Extended: '5800',
  High: '6400',
  'High 10': '6E00',
  'High 4:2:2': '7A00',
  'High 4:4:4 Predictive': 'F400',
};

/** Best-effort RFC 6381 string for MediaSource.isTypeSupported / addSourceBuffer. */
function videoCodecString(s: any, bitDepth: number): string | null {
  const level = Number(s.level) > 0 ? Number(s.level) : 0;
  switch (s.codec_name) {
    case 'h264':
      return `avc1.${H264_PROFILE[s.profile] ?? '6400'}${(level || 40).toString(16).padStart(2, '0').toUpperCase()}`;
    case 'hevc':
      return bitDepth > 8 ? `hvc1.2.4.L${level || 120}.B0` : `hvc1.1.6.L${level || 120}.B0`;
    case 'vp9':
      return `vp09.${bitDepth > 8 ? '02' : '00'}.${String(level || 40).padStart(2, '0')}.${String(bitDepth).padStart(2, '0')}`;
    case 'av1':
      return `av01.0.${String(level || 8).padStart(2, '0')}M.${String(bitDepth).padStart(2, '0')}`;
    case 'vp8':
      return 'vp8';
    default:
      return null;
  }
}

function audioCodecString(codec: string): string | null {
  switch (codec) {
    case 'aac':
      return 'mp4a.40.2';
    case 'mp3':
      return 'mp3';
    case 'opus':
      return 'opus';
    case 'flac':
      return 'flac';
    case 'ac3':
      return 'ac-3';
    case 'eac3':
      return 'ec-3';
    default:
      return null;
  }
}

/** FFmpeg decoder names that can software-decode a given codec_name. */
const SW_DECODERS: Record<string, string[]> = {
  // FFmpeg's built-in "av1" decoder is hwaccel-only; software AV1 needs an external library.
  av1: ['libdav1d', 'libaom-av1', 'libgav1'],
  dts: ['dca'],
  opus: ['opus', 'libopus'],
  vorbis: ['vorbis', 'libvorbis'],
  vp8: ['vp8', 'libvpx'],
  vp9: ['vp9', 'libvpx-vp9'],
  mp3: ['mp3', 'mp3float'],
};

function canSoftwareDecode(codecName: string | undefined): boolean {
  if (!codecName) return true;
  if (!decoders.size) return true; // listing failed: do not block playback on a guess
  return (SW_DECODERS[codecName] ?? [codecName]).some((d) => decoders.has(d));
}

const CODEC_ALIAS: Record<string, string> = { h264: 'avc', hevc: 'hevc', vp9: 'vp9', av1: 'av1', vp8: 'vp8', dts: 'dts' };

function probe(m: any): void {
  try {
    FS.unlink('/tmp/probe.json');
  } catch {
    /* none */
  }
  logTail = [];
  core.ffprobe('-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath, '-o', '/tmp/probe.json');
  core.reset?.();
  let json: any;
  try {
    json = JSON.parse(FS.readFile('/tmp/probe.json', { encoding: 'utf8' }));
  } catch {
    throw new Error('ffprobe produced no output: ' + logTail.slice(-3).join(' | '));
  }
  const streams: any[] = json.streams ?? [];
  if (!streams.length) throw new Error('FFmpeg found no streams: ' + logTail.slice(-3).join(' | '));
  const start = Number(json.format?.start_time) || 0;
  let duration = Number(json.format?.duration) || 0;
  const vStreams = streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const aStreams = streams.filter((s) => s.codec_type === 'audio');
  const vs = vStreams[0];
  let video: (VideoTrackInfo & { ffIndex: number }) | null = null;
  if (vs) {
    const pix: string = vs.pix_fmt ?? 'yuv420p';
    const depthMatch = /p(\d\d)(le|be)?$/.exec(pix);
    const bitDepth = depthMatch ? parseInt(depthMatch[1], 10) : Number(vs.bits_per_raw_sample) > 8 ? Number(vs.bits_per_raw_sample) : 8;
    let rotation = 0;
    for (const sd of vs.side_data_list ?? []) {
      if (typeof sd.rotation === 'number') rotation = ((-sd.rotation % 360) + 360) % 360;
    }
    const color = mapColor(vs);
    const fps = ratio(vs.avg_frame_rate) || ratio(vs.r_frame_rate) || 30;
    const swap = rotation === 90 || rotation === 270;
    video = {
      id: vs.index,
      ffIndex: 0,
      codec: CODEC_ALIAS[vs.codec_name] ?? vs.codec_name,
      codecString: videoCodecString(vs, bitDepth),
      width: vs.width,
      height: vs.height,
      displayWidth: swap ? vs.height : vs.width,
      displayHeight: swap ? vs.width : vs.height,
      rotation: rotation as 0 | 90 | 180 | 270,
      fps: Math.round(fps * 1000) / 1000,
      bitDepth,
      pixFmt: pix,
      color,
      hdr: color.transfer === 'pq' || color.transfer === 'hlg',
    };
    if (!duration && Number(vs.duration)) duration = Number(vs.duration);
  }
  const audioTracks: AudioTrackInfo[] = aStreams.map((s, i) => ({
    id: s.index,
    index: i,
    codec: CODEC_ALIAS[s.codec_name] ?? s.codec_name,
    codecString: audioCodecString(s.codec_name),
    sampleRate: Number(s.sample_rate) || 48000,
    channels: Number(s.channels) || 2,
    language: s.tags?.language ?? 'und',
    name: s.tags?.title ?? null,
  }));
  const info: MediaInfo = {
    container: (json.format?.format_name ?? 'unknown').split(',')[0],
    demuxer: 'ffmpeg',
    duration: Math.max(0, duration),
    startTime: start,
    video,
    audio: audioTracks[0] ?? null,
    audioTracks,
    title: json.format?.tags?.title ?? null,
    softwareDecodable: { video: canSoftwareDecode(vs?.codec_name), audio: canSoftwareDecode(aStreams[0]?.codec_name) },
  };
  post({ type: 'probed', id: m.id, info });
}

// ---- jobs --------------------------------------------------------------------------------------

function newJob(gen: number, kind: Job['kind']): Job {
  return {
    gen,
    kind,
    aborted: false,
    baseTime: 0,
    width: 0,
    height: 0,
    bytesPerSample: 1,
    bitDepth: 8,
    frameBytes: 0,
    dimsFromLog: false,
    cur: null,
    curFill: 0,
    ptsQueue: [],
    lastRel: 0,
    fps: 30,
    sentFrames: 0,
    maxQueue: 12,
    aChannels: 2,
    aRate: 48000,
    aBuf: null,
    aFill: 0,
    aFramesSent: 0,
    audioBase: 0,
    bytes: 0,
  };
}

function run(args: string[]): number {
  let ret = 1;
  try {
    ret = core.exec(...args);
  } catch (err: any) {
    // Aborting from a device callback surfaces here on some paths; that is expected.
    if (!job?.aborted) onLog(`exec threw: ${err?.message ?? err}`);
  }
  core.reset?.();
  return ret;
}

function decode(m: any): void {
  if (ctrl && Atomics.load(ctrl, CTRL_GEN) !== m.gen) {
    post({ type: 'done', gen: m.gen, aborted: true, frames: 0 });
    return;
  }
  const j = newJob(m.gen, 'decode');
  // FFmpeg starts reading at `m.time`; the first `pre` seconds are decoded and thrown away by
  // trim/atrim. showinfo timestamps are relative to `m.time`, hence the shifted video base.
  const pre: number = m.preroll ?? 0;
  const wanted: number = m.basePts ?? m.time + pre;
  j.baseTime = wanted - pre;
  j.audioBase = wanted;
  j.maxQueue = m.maxQueue ?? 12;
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info'];
  if (multiThread && m.threads) args.push('-threads', String(m.threads));
  args.push('-ss', m.time.toFixed(6));
  if (m.duration) args.push('-t', (m.duration + pre).toFixed(6));
  args.push('-noautorotate', '-i', inputPath);
  if (m.video) {
    j.width = m.video.width;
    j.height = m.video.height;
    j.bitDepth = m.video.bitDepth > 8 ? 10 : 8;
    j.bytesPerSample = j.bitDepth > 8 ? 2 : 1;
    j.frameBytes = frameSize(j.width, j.height, j.bytesPerSample);
    j.fps = m.video.fps || 30;
    args.push(
      '-map',
      `0:v:${m.video.index ?? 0}`,
      '-vf',
      `${pre > 0 ? `trim=start=${pre.toFixed(6)},` : ''}showinfo=checksum=0`,
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      j.bitDepth > 8 ? 'yuv420p10le' : 'yuv420p',
      // libavformat buffers 256 KiB per "file" output; flush per packet so audio and video
      // actually leave interleaved (otherwise 0.7 s of PCM sits in a buffer while video blocks).
      '-flush_packets',
      '1',
      '-f',
      'rawvideo',
      '/dev/lumen_v',
    );
  }
  if (m.audio) {
    j.aChannels = m.audio.channels;
    j.aRate = m.audio.sampleRate;
    args.push(
      '-map',
      `0:a:${m.audio.index ?? 0}`,
      '-af',
      `${pre > 0 ? `atrim=start=${pre.toFixed(6)},` : ''}aresample=async=1:first_pts=${Math.round(pre * (m.audio.sourceRate || j.aRate))}`,
      '-ar',
      String(j.aRate),
      '-ac',
      String(j.aChannels),
      '-flush_packets',
      '1',
      '-f',
      'f32le',
      '/dev/lumen_a',
    );
  }
  job = j;
  logTail = [];
  const t0 = performance.now();
  const ret = run(args);
  if (!j.aborted) {
    emitAudio(j); // flush the partial tail chunk
    if (m.audio && m.eosAtEnd) audioPort?.postMessage({ type: 'eos', gen: j.gen });
  }
  job = null;
  post({
    type: 'done',
    gen: j.gen,
    aborted: j.aborted,
    code: ret,
    frames: j.sentFrames,
    audioFrames: j.aFramesSent,
    lastPts: j.baseTime + j.lastRel,
    ms: performance.now() - t0,
    log: ret !== 0 && !j.aborted ? logTail.slice(-6).join('\n') : undefined,
  });
}

function remux(m: any): void {
  if (ctrl && Atomics.load(ctrl, CTRL_GEN) !== m.gen) {
    post({ type: 'done', gen: m.gen, aborted: true });
    return;
  }
  const j = newJob(m.gen, 'remux');
  const args = ['-hide_banner', '-nostats', '-loglevel', 'warning', '-copyts', '-start_at_zero'];
  args.push('-ss', m.time.toFixed(6));
  if (m.duration) args.push('-t', m.duration.toFixed(6));
  args.push('-i', inputPath);
  if (m.hasVideo) args.push('-map', '0:v:0', '-c:v', 'copy');
  if (m.hasAudio) {
    args.push('-map', `0:a:${m.audioIndex ?? 0}`);
    if (m.transcodeAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    else {
      args.push('-c:a', 'copy');
      // ADTS-framed AAC (TS, raw .aac) must be repacked for MP4; a no-op for already-raw AAC.
      if (m.audioCodec === 'aac') args.push('-bsf:a', 'aac_adtstoasc');
    }
  }
  args.push(
    // Keep the source timeline: fragments must land at their real position in the SourceBuffer,
    // so stop the muxer from shifting the first timestamp to zero.
    '-avoid_negative_ts',
    'disabled',
    '-flush_packets',
    '1',
    '-f',
    'mp4',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof+frag_discont',
    '-frag_duration',
    '500000',
    '/dev/lumen_m',
  );
  job = j;
  logTail = [];
  const t0 = performance.now();
  const ret = run(args);
  job = null;
  post({
    type: 'done',
    gen: j.gen,
    aborted: j.aborted,
    code: ret,
    bytes: j.bytes,
    ms: performance.now() - t0,
    log: ret !== 0 && !j.aborted ? logTail.slice(-6).join('\n') : undefined,
  });
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  const fail = (err: any) => post({ type: 'failed', id: m.id, gen: m.gen, message: err?.message ?? String(err) });
  try {
    switch (m.type) {
      case 'init':
        init(m).catch(fail);
        break;
      case 'open':
        openInput(m).catch(fail);
        break;
      case 'probe':
        probe(m);
        break;
      case 'audio-port':
        audioPort = m.port;
        break;
      case 'decode':
        decode(m);
        break;
      case 'remux':
        remux(m);
        break;
    }
  } catch (err) {
    fail(err);
  }
};
