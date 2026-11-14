/**
 * Tier 1 / Tier 2 media worker.
 *
 * One instance owns one mediabunny `Input` and can, on request:
 *   - probe the container and report which tracks WebCodecs can decode,
 *   - run the WebCodecs decode loops (VideoDecoder + AudioDecoder) with back-pressure,
 *   - remux packets on the fly into fragmented MP4 for the MSE tier,
 *   - decode single key frames for seek-bar thumbnails.
 *
 * Video frames are transferred to the main thread; PCM goes straight to the AudioWorklet over a
 * MessagePort so the main thread is never in the audio path.
 */
import {
  ALL_FORMATS,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  type EncodedPacket,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';
import type { AudioTrackInfo, ColorInfo, MediaInfo, VideoTrackInfo } from '../core/types';

const post = (msg: any, transfer: Transferable[] = []) => (self as any).postMessage(msg, transfer);

let input: Input | null = null;
let vTrack: InputVideoTrack | null = null;
let aTracks: InputAudioTrack[] = [];
let aTrack: InputAudioTrack | null = null;
let startTime = 0;
let videoFps = 30;

// ---- decode state ----------------------------------------------------------------------------
let curGen = -1;
let wantVideo = true;
let wantAudio = true;
let audioPort: MessagePort | null = null;
let outSampleRate = 48000;
let planarHdr = false;
let maxQueue = 12;
let videoDecoder: VideoDecoder | null = null;
let audioDecoder: AudioDecoder | null = null;
let softwareOnly = false;
let sent = 0;
let released = 0;
let clock = 0;
let clockPerf = 0;
let clockRate = 0;
let audioSentEnd = 0;
let wakers: Array<() => void> = [];
let goWaiters = new Map<number, () => void>();
const decodeStart = new Map<number, number>();
let latencySum = 0;
let latencyCount = 0;
let lastStatPost = 0;
let planarChain: Promise<void> = Promise.resolve();
let faultAfterFrames = 0;
let framesSinceConfigure = 0;

// ---- remux state -----------------------------------------------------------------------------
let remuxGen = -1;
let remuxAcks: Array<() => void> = [];

function wake(): void {
  const w = wakers;
  wakers = [];
  for (const fn of w) fn();
}

function waitTick(ms = 25): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    wakers.push(fin);
    setTimeout(fin, ms);
  });
}

function clockNow(): number {
  return clock + ((performance.now() - clockPerf) / 1000) * clockRate;
}

function mapColor(cs: VideoColorSpaceInit | null | undefined): ColorInfo {
  // lib.dom's enums lag behind the spec (no bt2020 / pq / hlg), so compare as plain strings.
  const p = cs?.primaries as string | undefined;
  const t = cs?.transfer as string | undefined;
  const m = cs?.matrix as string | undefined;
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
    transfer: t === 'pq' ? 'pq' : t === 'hlg' ? 'hlg' : t === 'iec61966-2-1' ? 'srgb' : t === 'linear' ? 'linear' : t ? 'bt709' : 'unknown',
    matrix:
      m === 'bt709'
        ? 'bt709'
        : m === 'bt2020-ncl'
          ? 'bt2020nc'
          : m === 'bt470bg' || m === 'smpte170m'
            ? 'bt601'
            : m === 'rgb'
              ? 'rgb'
              : 'unknown',
    fullRange: !!cs?.fullRange,
  };
}

/** Bit depth from an RFC 6381 codec string. */
function bitDepthFromCodecString(s: string | null): number {
  if (!s) return 8;
  const parts = s.split('.');
  if (s.startsWith('vp09') && parts.length >= 4) return parseInt(parts[3], 10) || 8;
  if (s.startsWith('av01') && parts.length >= 4) return parseInt(parts[3], 10) || 8;
  if (s.startsWith('avc') && parts[1]) {
    const profile = parseInt(parts[1].slice(0, 2), 16);
    return profile === 110 || profile === 122 || profile === 244 ? 10 : 8;
  }
  if (s.startsWith('hvc1') || s.startsWith('hev1')) {
    const profile = parseInt((parts[1] || '1').replace(/^[ABC]/, ''), 10);
    return profile === 2 ? 10 : 8;
  }
  return 8;
}

/**
 * Mediabunny retries a failed request for ever by default. Ride out a short network blip
 * (about twelve seconds in all), then let the load fail with an error the player can show.
 */
const retryDelay = (previousAttempts: number): number | null => (previousAttempts >= 6 ? null : Math.min(4, 0.25 * 2 ** previousAttempts));

async function open(source: Blob | string): Promise<any> {
  closeInput();
  input = new Input({
    formats: ALL_FORMATS,
    source:
      typeof source === 'string'
        ? new UrlSource(source, { getRetryDelay: retryDelay })
        : // A larger cache than the 8 MiB default: files opened from a network share read slowly.
          new BlobSource(source, { maxCacheSize: 32 * 1024 * 1024 }),
  });
  if (!(await input.canRead())) {
    closeInput();
    return { readable: false };
  }
  const format = await input.getFormat();
  vTrack = await input.getPrimaryVideoTrack();
  aTracks = await input.getAudioTracks();
  aTrack = (await input.getPrimaryAudioTrack()) ?? aTracks[0] ?? null;
  const tracks = [vTrack, ...aTracks].filter(Boolean) as Array<InputVideoTrack | InputAudioTrack>;
  if (!tracks.length) {
    closeInput();
    return { readable: false };
  }
  startTime = await input.getFirstTimestamp(tracks);
  // Rebase only genuinely late starts (e.g. MPEG-TS at 1.4 s). A negative first timestamp is codec
  // priming that must not be presented, so the origin stays at 0 and the priming is trimmed away.
  if (!Number.isFinite(startTime) || startTime < 0) startTime = 0;
  let duration = 0;
  try {
    duration = (await input.computeDuration(tracks)) - startTime;
  } catch {
    duration = ((await input.getDurationFromMetadata(tracks)) ?? 0) - startTime;
  }

  let video: VideoTrackInfo | null = null;
  let videoSupported: boolean | null = null;
  if (vTrack) {
    const codecString = await vTrack.getCodecParameterString();
    let cs: VideoColorSpaceInit | null = null;
    try {
      cs = await vTrack.getColorSpace();
    } catch {
      /* optional */
    }
    try {
      const st = await vTrack.computePacketStats(90);
      if (st.averagePacketRate > 0) videoFps = st.averagePacketRate;
    } catch {
      /* keep default */
    }
    const color = mapColor(cs);
    video = {
      id: vTrack.id,
      codec: vTrack.codec ?? 'unknown',
      codecString,
      width: vTrack.codedWidth,
      height: vTrack.codedHeight,
      displayWidth: vTrack.displayWidth,
      displayHeight: vTrack.displayHeight,
      rotation: vTrack.rotation,
      fps: Math.round(videoFps * 1000) / 1000,
      bitDepth: bitDepthFromCodecString(codecString),
      pixFmt: null,
      color,
      hdr: color.transfer === 'pq' || color.transfer === 'hlg',
    };
    videoSupported = false;
    if (typeof VideoDecoder !== 'undefined') {
      try {
        const cfg = await vTrack.getDecoderConfig();
        if (cfg) videoSupported = !!(await VideoDecoder.isConfigSupported(cfg)).supported;
      } catch {
        videoSupported = false;
      }
    }
  }

  const audioTracks: AudioTrackInfo[] = [];
  const audioSupport: Record<number, boolean> = {};
  for (let i = 0; i < aTracks.length; i++) {
    const t = aTracks[i];
    const codecString = await t.getCodecParameterString();
    audioTracks.push({
      id: t.id,
      index: i,
      codec: t.codec ?? 'unknown',
      codecString,
      sampleRate: t.sampleRate,
      channels: t.numberOfChannels,
      language: t.languageCode,
      name: t.name,
    });
    let ok = false;
    if (typeof AudioDecoder !== 'undefined') {
      try {
        const cfg = await t.getDecoderConfig();
        if (cfg) ok = !!(await AudioDecoder.isConfigSupported(cfg)).supported;
      } catch {
        ok = false;
      }
    }
    audioSupport[t.id] = ok;
  }
  const audio = aTrack ? (audioTracks.find((t) => t.id === aTrack!.id) ?? null) : null;

  let title: string | null = null;
  try {
    title = (await input.getMetadataTags()).title ?? null;
  } catch {
    /* optional */
  }

  // Which codecs can the fMP4 muxer carry? (decides whether the MSE tier is even possible)
  const mp4 = new Mp4OutputFormat();
  const mp4Video = new Set<string>(mp4.getSupportedVideoCodecs());
  const mp4Audio = new Set<string>(mp4.getSupportedAudioCodecs());
  const muxable = (!video || mp4Video.has(video.codec)) && (!audio || mp4Audio.has(audio.codec));

  const info: MediaInfo = {
    container: format.name,
    demuxer: 'mediabunny',
    duration: Math.max(0, duration),
    startTime,
    video,
    audio,
    audioTracks,
    title,
  };
  return { readable: true, info, videoSupported, audioSupport, muxable, hasWebCodecs: typeof VideoDecoder !== 'undefined' };
}

function closeInput(): void {
  stopDecode();
  remuxGen = -1;
  try {
    input?.dispose();
  } catch {
    /* ignore */
  }
  input = null;
  vTrack = null;
  aTracks = [];
  aTrack = null;
}

function stopDecode(): void {
  curGen = -1;
  wake();
  for (const fn of goWaiters.values()) fn();
  goWaiters.clear();
  try {
    if (videoDecoder && videoDecoder.state !== 'closed') videoDecoder.close();
  } catch {
    /* ignore */
  }
  try {
    if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close();
  } catch {
    /* ignore */
  }
  videoDecoder = null;
  audioDecoder = null;
  decodeStart.clear();
}

// ---- WebCodecs decode --------------------------------------------------------------------------

async function start(gen: number, time: number, exact: boolean): Promise<void> {
  stopDecode();
  curGen = gen;
  sent = 0;
  released = 0;
  clock = time;
  clockPerf = performance.now();
  clockRate = 0;
  audioSentEnd = time;
  planarChain = Promise.resolve();
  const abs = time + startTime;
  let videoKey: EncodedPacket | null = null;
  let actual = time;
  const vSink = wantVideo && vTrack ? new EncodedPacketSink(vTrack) : null;
  try {
    if (vSink) {
      videoKey = (await vSink.getKeyPacket(abs, { verifyKeyPackets: true })) ?? (await vSink.getFirstPacket());
      if (gen !== curGen) return;
      if (videoKey && !exact) actual = Math.max(0, videoKey.timestamp - startTime);
    }
    post({ type: 'started', gen, time: actual });
    if (!exact) {
      // Let the main thread re-pin the audio clock to the key frame before any PCM is produced.
      await new Promise<void>((resolve) => goWaiters.set(gen, resolve));
      goWaiters.delete(gen);
      if (gen !== curGen) return;
    }
    clock = actual;
    audioSentEnd = actual;
    const jobs: Array<Promise<void>> = [];
    if (vSink && videoKey) jobs.push(runVideo(gen, vSink, videoKey, exact ? abs : videoKey.timestamp));
    else if (wantVideo && vTrack) post({ type: 'eos', kind: 'video', gen });
    if (wantAudio && aTrack) jobs.push(runAudio(gen, actual));
    await Promise.all(jobs);
  } catch (err: any) {
    if (gen === curGen) post({ type: 'error', kind: 'pipeline', fatal: true, message: err?.message ?? String(err) });
  }
}

async function runVideo(gen: number, sink: EncodedPacketSink, key: EncodedPacket, dropBefore: number): Promise<void> {
  const track = vTrack!;
  const cfg = await track.getDecoderConfig();
  if (!cfg) throw new Error('No video decoder configuration');
  const defaultDurUs = Math.round(1e6 / (videoFps || 30));
  const dropBeforeUs = Math.round(dropBefore * 1e6);
  let failed: string | null = null;
  const decoder = new VideoDecoder({
    output: (frame) => onVideoFrame(frame, gen, dropBeforeUs, defaultDurUs),
    error: (e) => {
      failed = e.message || String(e);
      wake();
    },
  });
  videoDecoder = decoder;
  decoder.addEventListener('dequeue', wake);
  decoder.configure({
    ...cfg,
    hardwareAcceleration: softwareOnly ? 'prefer-software' : 'no-preference',
    optimizeForLatency: false,
  });
  for await (const packet of sink.packets(key)) {
    if (gen !== curGen || failed) break;
    while (gen === curGen && !failed && (decoder.decodeQueueSize > 4 || sent - released >= maxQueue)) await waitTick();
    if (gen !== curGen || failed) break;
    decodeStart.set(packet.microsecondTimestamp, performance.now());
    if (decodeStart.size > 256) decodeStart.delete(decodeStart.keys().next().value!);
    decoder.decode(packet.toEncodedVideoChunk());
  }
  if (failed) {
    if (gen !== curGen) return;
    if (!softwareOnly) {
      // Hardware path rejected the stream at runtime: retry once in software from the same spot.
      softwareOnly = true;
      post({ type: 'note', message: `hardware video decode failed (${failed}); retrying in software` });
      try {
        decoder.close();
      } catch {
        /* ignore */
      }
      return runVideo(gen, sink, key, dropBefore);
    }
    post({ type: 'error', kind: 'video', fatal: true, message: failed });
    return;
  }
  if (gen !== curGen) return;
  try {
    await decoder.flush();
    await planarChain;
  } catch {
    /* reset during flush */
  }
  if (gen === curGen) post({ type: 'eos', kind: 'video', gen });
}

function onVideoFrame(frame: VideoFrame, gen: number, dropBeforeUs: number, defaultDurUs: number): void {
  if (gen !== curGen) {
    frame.close();
    return;
  }
  const ts = frame.timestamp;
  const dur = frame.duration || defaultDurUs;
  const t0 = decodeStart.get(ts);
  if (t0 !== undefined) {
    decodeStart.delete(ts);
    latencySum += performance.now() - t0;
    latencyCount++;
  }
  if (ts + dur <= dropBeforeUs + 500) {
    frame.close(); // lies entirely before an exact seek target
    return;
  }
  if (faultAfterFrames && ++framesSinceConfigure > faultAfterFrames) {
    // Test hook: behave exactly like a decoder that died mid-stream.
    frame.close();
    faultAfterFrames = 0;
    post({ type: 'error', kind: 'video', fatal: true, message: 'injected WebCodecs decoder fault' });
    stopDecode();
    return;
  }
  sent++;
  const pts = ts / 1e6 - startTime;
  const duration = dur / 1e6;
  const fmt = frame.format as string | null;
  if (planarHdr && (fmt === 'I420' || fmt === 'I420P10' || fmt === 'I420P12')) {
    planarChain = planarChain.then(() => postPlanar(frame, gen, pts, duration)).catch(() => frame.close());
  } else {
    post({ type: 'frame', gen, pts, duration, frame, width: frame.displayWidth, height: frame.displayHeight }, [frame]);
  }
  const now = performance.now();
  if (now - lastStatPost > 500 && latencyCount) {
    post({ type: 'stats', decodeLatencyMs: latencySum / latencyCount, decodeQueue: videoDecoder?.decodeQueueSize ?? 0, softwareOnly });
    latencySum = latencyCount = 0;
    lastStatPost = now;
  }
}

/** Copy a software-decoded HDR frame out as tight planes so our own shader can tone-map it. */
async function postPlanar(frame: VideoFrame, gen: number, pts: number, duration: number): Promise<void> {
  try {
    const format = frame.format as string | null;
    const wide = format !== 'I420';
    const bps = wide ? 2 : 1;
    const w = frame.codedWidth;
    const h = frame.codedHeight;
    const cw = (w + 1) >> 1;
    const chh = (h + 1) >> 1;
    const buf = new Uint8Array(frame.allocationSize());
    const layout = await frame.copyTo(buf);
    const dims = [
      [w, h],
      [cw, chh],
      [cw, chh],
    ];
    const planes: Uint8Array[] = [];
    for (let i = 0; i < 3; i++) {
      const [pw, ph] = dims[i];
      const row = pw * bps;
      const { offset, stride } = layout[i];
      if (stride === row) {
        planes.push(buf.subarray(offset, offset + row * ph));
      } else {
        const tight = new Uint8Array(row * ph);
        for (let y = 0; y < ph; y++) tight.set(buf.subarray(offset + y * stride, offset + y * stride + row), y * row);
        planes.push(tight);
      }
    }
    const bitDepth = format === 'I420P12' ? 12 : wide ? 10 : 8;
    const color = mapColor(frame.colorSpace?.toJSON?.() as VideoColorSpaceInit);
    if (gen === curGen) {
      // One shared backing buffer in the common case; structured clone handles the views.
      post({ type: 'planar', gen, pts, duration, width: w, height: h, chromaWidth: cw, chromaHeight: chh, bitDepth, color, planes });
    }
  } finally {
    frame.close();
  }
}

async function runAudio(gen: number, time: number): Promise<void> {
  const track = aTrack!;
  const cfg = await track.getDecoderConfig();
  if (!cfg) throw new Error('No audio decoder configuration');
  const sink = new EncodedPacketSink(track);
  const abs = time + startTime;
  const pre = (await track.getPreRollDuration().catch(() => null)) ?? 0.08;
  const first = (await sink.getPacket(abs - pre)) ?? (await sink.getFirstPacket());
  if (!first) {
    audioPort?.postMessage({ type: 'eos', gen });
    post({ type: 'eos', kind: 'audio', gen });
    return;
  }
  let failed: string | null = null;
  const resampler = track.sampleRate !== outSampleRate ? new LinearResampler(track.sampleRate, outSampleRate) : null;
  const decoder = new AudioDecoder({
    output: (data) => {
      if (gen !== curGen) {
        data.close();
        return;
      }
      const n = data.numberOfFrames;
      const pts = data.timestamp / 1e6 - startTime;
      let channels: Float32Array[] = [];
      for (let c = 0; c < data.numberOfChannels; c++) {
        const arr = new Float32Array(n);
        data.copyTo(arr, { planeIndex: c, format: 'f32-planar' });
        channels.push(arr);
      }
      const srcRate = data.sampleRate;
      data.close();
      if (resampler) channels = resampler.process(channels);
      const frames = channels[0]?.length ?? 0;
      if (!frames) return;
      audioSentEnd = pts + n / srcRate;
      audioPort?.postMessage(
        { type: 'pcm', gen, pts, channels },
        channels.map((c) => c.buffer),
      );
    },
    error: (e) => {
      failed = e.message || String(e);
      wake();
    },
  });
  audioDecoder = decoder;
  decoder.addEventListener('dequeue', wake);
  decoder.configure(cfg);
  for await (const packet of sink.packets(first)) {
    if (gen !== curGen || failed) break;
    while (gen === curGen && !failed && (decoder.decodeQueueSize > 12 || audioSentEnd - clockNow() > 1.0)) await waitTick();
    if (gen !== curGen || failed) break;
    decoder.decode(packet.toEncodedAudioChunk());
  }
  if (failed) {
    if (gen === curGen) post({ type: 'error', kind: 'audio', fatal: true, message: failed });
    return;
  }
  if (gen !== curGen) return;
  try {
    await decoder.flush();
  } catch {
    /* reset during flush */
  }
  if (gen === curGen) {
    audioPort?.postMessage({ type: 'eos', gen });
    post({ type: 'eos', kind: 'audio', gen });
  }
}

/** Streaming linear resampler; only used when the AudioContext could not be opened at the track rate. */
class LinearResampler {
  private pos = 0;
  private prev: number[] = [];
  private step: number;
  constructor(from: number, to: number) {
    this.step = from / to;
  }
  process(input: Float32Array[]): Float32Array[] {
    const n = input[0].length;
    const outLen = Math.max(0, Math.floor((n - this.pos) / this.step));
    const out = input.map(() => new Float32Array(outLen));
    for (let c = 0; c < input.length; c++) {
      const src = input[c];
      const dst = out[c];
      const prev = this.prev[c] ?? src[0];
      let p = this.pos;
      for (let i = 0; i < outLen; i++) {
        const i0 = Math.floor(p);
        const f = p - i0;
        const a = i0 <= 0 ? (i0 < 0 ? prev : src[0]) : src[i0];
        const b = i0 + 1 < n ? src[i0 + 1] : src[n - 1];
        dst[i] = a + (b - a) * f;
        p += this.step;
      }
      this.prev[c] = src[n - 1];
    }
    this.pos = this.pos + outLen * this.step - n;
    return out;
  }
}

// ---- MSE remux ---------------------------------------------------------------------------------

async function remux(gen: number, time: number): Promise<void> {
  remuxGen = gen;
  remuxAcks = [];
  const v = vTrack;
  const a = aTrack;
  try {
    const abs = time + startTime;
    const vSink = v ? new EncodedPacketSink(v) : null;
    const aSink = a ? new EncodedPacketSink(a) : null;
    const vKey = vSink ? ((await vSink.getKeyPacket(abs, { verifyKeyPackets: true })) ?? (await vSink.getFirstPacket())) : null;
    const from = vKey ? vKey.timestamp : abs;
    const aFirst = aSink ? ((await aSink.getPacket(from)) ?? (await aSink.getFirstPacket())) : null;
    if (gen !== remuxGen) return;

    const writable = new WritableStream<{ data: Uint8Array; position: number }>({
      write: async (chunk) => {
        if (gen !== remuxGen) throw new Error('remux cancelled');
        const copy = chunk.data.slice();
        post({ type: 'segment', gen, data: copy.buffer }, [copy.buffer]);
        // Back-pressure: wait until the main thread has appended this chunk and wants more.
        await new Promise<void>((resolve) => remuxAcks.push(resolve));
        if (gen !== remuxGen) throw new Error('remux cancelled');
      },
    });
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 0.5 }),
      target: new StreamTarget(writable as any),
    });
    const vSrc = v && vKey ? new EncodedVideoPacketSource(v.codec!) : null;
    const aSrc = a && aFirst ? new EncodedAudioPacketSource(a.codec!) : null;
    if (vSrc) output.addVideoTrack(vSrc);
    if (aSrc) output.addAudioTrack(aSrc);
    const vCfg = v && vSrc ? await v.getDecoderConfig() : null;
    const aCfg = a && aSrc ? await a.getDecoderConfig() : null;
    await output.start();

    const rebase = (p: EncodedPacket) => (startTime ? p.clone({ timestamp: p.timestamp - startTime }) : p);
    const vIt = vSrc ? vSink!.packets(vKey!)[Symbol.asyncIterator]() : null;
    const aIt = aSrc ? aSink!.packets(aFirst!)[Symbol.asyncIterator]() : null;
    let vNext = vIt ? await vIt.next() : { done: true as const, value: undefined };
    let aNext = aIt ? await aIt.next() : { done: true as const, value: undefined };
    let vFirst = true;
    let aFirstPacket = true;
    let cancelled = false;
    try {
      while (!vNext.done || !aNext.done) {
        if (gen !== remuxGen) {
          cancelled = true;
          break;
        }
        const takeVideo = !vNext.done && (aNext.done || vNext.value!.timestamp <= aNext.value!.timestamp);
        if (takeVideo) {
          await vSrc!.add(rebase(vNext.value!), vFirst ? { decoderConfig: vCfg! } : undefined);
          vFirst = false;
          vNext = await vIt!.next();
        } else {
          const p = rebase(aNext.value!);
          if (p.timestamp >= 0) {
            await aSrc!.add(p, aFirstPacket ? { decoderConfig: aCfg! } : undefined);
            aFirstPacket = false;
          }
          aNext = await aIt!.next();
        }
      }
    } finally {
      await vIt?.return?.(undefined);
      await aIt?.return?.(undefined);
    }
    if (cancelled || gen !== remuxGen) {
      await output.cancel().catch(() => {});
      return;
    }
    await output.finalize();
    if (gen === remuxGen) post({ type: 'remux-eos', gen });
  } catch (err: any) {
    if (gen === remuxGen && !/cancel/i.test(err?.message ?? '')) {
      post({ type: 'error', kind: 'remux', fatal: true, message: err?.message ?? String(err) });
    }
  }
}

function stopRemux(): void {
  remuxGen = -1;
  const acks = remuxAcks;
  remuxAcks = [];
  for (const fn of acks) fn();
}

// ---- thumbnails --------------------------------------------------------------------------------

let thumbBusy = false;
let thumbPending: { id: number; time: number; maxWidth: number } | null = null;
let thumbSink: EncodedPacketSink | null = null;

async function thumbnail(req: { id: number; time: number; maxWidth: number }): Promise<void> {
  if (thumbBusy) {
    if (thumbPending) post({ type: 'thumb', id: thumbPending.id, bitmap: null });
    thumbPending = req;
    return;
  }
  thumbBusy = true;
  let bitmap: ImageBitmap | null = null;
  let time = req.time;
  try {
    if (vTrack && typeof VideoDecoder !== 'undefined') {
      thumbSink ??= new EncodedPacketSink(vTrack);
      const key = (await thumbSink.getKeyPacket(req.time + startTime, { verifyKeyPackets: true })) ?? (await thumbSink.getFirstPacket());
      const cfg = await vTrack.getDecoderConfig();
      if (key && cfg) {
        time = key.timestamp - startTime;
        bitmap = await new Promise<ImageBitmap | null>((resolve) => {
          let settled = false;
          const dec = new VideoDecoder({
            output: (frame) => {
              if (settled) {
                frame.close();
                return;
              }
              settled = true;
              const scale = Math.min(1, req.maxWidth / frame.displayWidth);
              createImageBitmap(frame, {
                resizeWidth: Math.max(2, Math.round(frame.displayWidth * scale)),
                resizeHeight: Math.max(2, Math.round(frame.displayHeight * scale)),
                resizeQuality: 'medium',
              })
                .then(resolve, () => resolve(null))
                .finally(() => frame.close());
            },
            error: () => {
              if (!settled) {
                settled = true;
                resolve(null);
              }
            },
          });
          dec.configure({ ...cfg, hardwareAcceleration: 'prefer-software' });
          dec.decode(key.toEncodedVideoChunk());
          dec
            .flush()
            .catch(() => {})
            .finally(() => {
              try {
                dec.close();
              } catch {
                /* ignore */
              }
              if (!settled) {
                settled = true;
                resolve(null);
              }
            });
        });
      }
    }
  } catch {
    bitmap = null;
  }
  post({ type: 'thumb', id: req.id, bitmap, time }, bitmap ? [bitmap] : []);
  thumbBusy = false;
  if (thumbPending) {
    const next = thumbPending;
    thumbPending = null;
    void thumbnail(next);
  }
}

// ---- message loop ------------------------------------------------------------------------------

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  switch (m.type) {
    case 'open':
      open(m.source).then(
        (result) => post({ type: 'opened', id: m.id, ...result }),
        (err) => post({ type: 'opened', id: m.id, readable: false, error: err?.message ?? String(err) }),
      );
      break;
    case 'configure':
      wantVideo = m.video;
      wantAudio = m.audio;
      if (m.audioPort) audioPort = m.audioPort;
      outSampleRate = m.outSampleRate ?? outSampleRate;
      planarHdr = !!m.planarHdr;
      maxQueue = m.maxQueue ?? maxQueue;
      softwareOnly = !!m.softwareOnly;
      faultAfterFrames = m.faultAfterFrames ?? 0;
      framesSinceConfigure = 0;
      if (m.audioTrackId !== undefined) aTrack = aTracks.find((t) => t.id === m.audioTrackId) ?? aTrack;
      break;
    case 'start':
      void start(m.gen, m.time, m.exact);
      break;
    case 'go':
      goWaiters.get(m.gen)?.();
      break;
    case 'tick':
      if (m.gen === curGen) {
        clock = m.clock;
        clockPerf = performance.now();
        clockRate = m.playing ? m.rate : 0;
        released = m.released;
        wake();
      }
      break;
    case 'stop':
      stopDecode();
      break;
    case 'remux-start':
      if (m.audioTrackId !== undefined) aTrack = aTracks.find((t) => t.id === m.audioTrackId) ?? aTrack;
      stopRemux();
      void remux(m.gen, m.time);
      break;
    case 'remux-ack': {
      if (m.gen === remuxGen) remuxAcks.shift()?.();
      break;
    }
    case 'remux-stop':
      stopRemux();
      break;
    case 'thumb':
      void thumbnail(m);
      break;
    case 'close':
      stopRemux();
      closeInput();
      post({ type: 'closed', id: m.id });
      break;
  }
};
