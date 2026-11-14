#!/usr/bin/env node
// Synthesises the whole test-media matrix with the ffmpeg CLI (lavfi sources) — nothing is
// downloaded. Output goes to public/media/ together with manifest.json, which the test-suite and
// the demo page read.
//
//   node scripts/gen-media.mjs            generate what is missing
//   node scripts/gen-media.mjs --force    regenerate everything
//
// Every video clip carries the same instrumented picture:
//   - top strip: a 12-bit binary frame counter (40 px cells, LSB first) + white/black sentinels,
//     so a test can read the exact frame number back from rendered pixels;
//   - a white box flashing for the first 100 ms of every second, in step with an 880 Hz beep,
//     for end-to-end A/V sync measurement;
//   - testsrc2 underneath (motion, colour, fine detail).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fontAss, srt, syncAss, tortureAss, vtt } from './gen-ass.mjs';
import { buildSup, PGS_ITEMS } from './gen-pgs.mjs';

const require = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'media');
const FORCE = process.argv.includes('--force');
const FONT_SRC = join(ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf', 'DejaVuSansMono-Bold.ttf');
const FONT_FAMILY = 'DejaVu Sans Mono';

mkdirSync(OUT, { recursive: true });

const W = 640;
const H = 360;
export const COUNTER = { bits: 12, cell: 40, height: 40, width: W, videoHeight: H };

function pattern(fps, duration, { w = W, h = H } = {}) {
  const f = [`testsrc2=size=${w}x${h}:rate=${fps}:duration=${duration}`, 'format=yuv420p'];
  f.push(`drawbox=x=0:y=0:w=${w}:h=${COUNTER.height}:color=black:t=fill`);
  for (let k = 0; k < COUNTER.bits; k++) {
    f.push(
      `drawbox=x=${k * COUNTER.cell}:y=0:w=${COUNTER.cell}:h=${COUNTER.height}:color=white:t=fill:enable='gte(mod(n\\,${2 ** (k + 1)})\\,${2 ** k})'`,
    );
  }
  f.push(`drawbox=x=${COUNTER.bits * COUNTER.cell}:y=0:w=80:h=${COUNTER.height}:color=white:t=fill`);
  // sync flash: bottom-right 96x96, on for the first 100 ms of each second
  f.push(`drawbox=x=${w - 112}:y=${h - 112}:w=96:h=96:color=white:t=fill:enable='lt(mod(t\\,1)\\,0.1)'`);
  f.push(`drawbox=x=${w - 112}:y=${h - 112}:w=96:h=96:color=black:t=fill:enable='gte(mod(t\\,1)\\,0.1)'`);
  return f.join(',');
}

const beep = (duration) => `aevalsrc='0.12*sin(2*PI*220*t)+0.6*sin(2*PI*880*t)*lt(mod(t\\,1)\\,0.1)':s=48000:c=stereo:d=${duration}`;
const beep51 = (duration) =>
  `aevalsrc='0.25*sin(2*PI*220*t)|0.25*sin(2*PI*330*t)|0.5*sin(2*PI*880*t)*lt(mod(t\\,1)\\,0.1)|0.2*sin(2*PI*60*t)|0.2*sin(2*PI*550*t)|0.2*sin(2*PI*660*t)':s=48000:c=5.1:d=${duration}`;

// Four flat quadrants with known RGB values, for colour-accuracy assertions.
export const COLOR_PATCHES = {
  topLeft: [200, 40, 40],
  topRight: [40, 180, 60],
  bottomLeft: [40, 60, 200],
  bottomRight: [128, 128, 128],
};
const hex = ([r, g, b]) => '0x' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
function colorQuad(duration, fps = 30) {
  const c = COLOR_PATCHES;
  const src = (rgb) => `color=c=${hex(rgb)}:s=320x180:r=${fps}:d=${duration},format=gbrp`;
  return `${src(c.topLeft)}[a];${src(c.topRight)}[b];${src(c.bottomLeft)}[c];${src(c.bottomRight)}[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack`;
}

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'];
const X265 = ['-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '24', '-x265-params', 'log-level=error'];
const VP9 = ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1'];
const AV1 = ['-c:v', 'libaom-av1', '-b:v', '0', '-crf', '36', '-cpu-used', '8', '-row-mt', '1', '-usage', 'realtime'];
const TAG709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

const D = 8; // seconds, standard clip length
const av = (fps = 30, d = D) => ['-f', 'lavfi', '-i', pattern(fps, d), '-f', 'lavfi', '-i', beep(d)];

/** @type {Array<{file:string, args:string[], meta:object, deps?:string[]}>} */
const jobs = [];
const add = (file, args, meta, deps) => jobs.push({ file, args, meta, deps });

// ---- containers x codecs ------------------------------------------------------------------------
add(
  'h264_aac.mp4',
  [...av(), ...X264, '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '2', ...TAG709, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
  { container: 'mp4', video: 'avc', audio: 'aac', bitDepth: 8, fps: 30, duration: D },
);
add(
  'h264_aac_60fps.mp4',
  [...av(60), ...X264, '-pix_fmt', 'yuv420p', '-g', '60', ...TAG709, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'],
  { container: 'mp4', video: 'avc', audio: 'aac', bitDepth: 8, fps: 60, duration: D },
);
add(
  'h264_aac_long.mp4',
  [
    ...av(30, 60),
    ...X264,
    '-pix_fmt',
    'yuv420p',
    '-g',
    '60',
    '-bf',
    '2',
    ...TAG709,
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-movflags',
    '+faststart',
  ],
  { container: 'mp4', video: 'avc', audio: 'aac', bitDepth: 8, fps: 30, duration: 60, long: true },
);
add('h264_mp3.mp4', [...av(), ...X264, '-pix_fmt', 'yuv420p', '-g', '30', ...TAG709, '-c:a', 'libmp3lame', '-b:a', '160k'], {
  container: 'mp4',
  video: 'avc',
  audio: 'mp3',
  bitDepth: 8,
  fps: 30,
  duration: D,
});
add(
  'hevc_aac.mp4',
  [
    ...av(),
    ...X265,
    '-pix_fmt',
    'yuv420p',
    '-g',
    '30',
    '-tag:v',
    'hvc1',
    ...TAG709,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
  ],
  { container: 'mp4', video: 'hevc', audio: 'aac', bitDepth: 8, fps: 30, duration: D },
);
add('hevc10_aac.mkv', [...av(), ...X265, '-pix_fmt', 'yuv420p10le', '-g', '30', ...TAG709, '-c:a', 'aac', '-b:a', '128k'], {
  container: 'mkv',
  video: 'hevc',
  audio: 'aac',
  bitDepth: 10,
  fps: 30,
  duration: D,
});
add('vp9_opus.webm', [...av(), ...VP9, '-pix_fmt', 'yuv420p', '-g', '30', ...TAG709, '-c:a', 'libopus', '-b:a', '96k'], {
  container: 'webm',
  video: 'vp9',
  audio: 'opus',
  bitDepth: 8,
  fps: 30,
  duration: D,
});
add(
  'vp9_10bit_opus.webm',
  [...av(), ...VP9, '-pix_fmt', 'yuv420p10le', '-profile:v', '2', '-g', '30', ...TAG709, '-c:a', 'libopus', '-b:a', '96k'],
  { container: 'webm', video: 'vp9', audio: 'opus', bitDepth: 10, fps: 30, duration: D },
);
add('av1_opus.mkv', [...av(), ...AV1, '-pix_fmt', 'yuv420p', '-g', '30', ...TAG709, '-c:a', 'libopus', '-b:a', '96k'], {
  container: 'mkv',
  video: 'av1',
  audio: 'opus',
  bitDepth: 8,
  fps: 30,
  duration: D,
});
add('av1_10bit_opus.webm', [...av(), ...AV1, '-pix_fmt', 'yuv420p10le', '-g', '30', ...TAG709, '-c:a', 'libopus', '-b:a', '96k'], {
  container: 'webm',
  video: 'av1',
  audio: 'opus',
  bitDepth: 10,
  fps: 30,
  duration: D,
});
add('h264_opus.mkv', [...av(), ...X264, '-pix_fmt', 'yuv420p', '-g', '30', ...TAG709, '-c:a', 'libopus', '-b:a', '96k'], {
  container: 'mkv',
  video: 'avc',
  audio: 'opus',
  bitDepth: 8,
  fps: 30,
  duration: D,
});
add('h264_flac.mkv', [...av(), ...X264, '-pix_fmt', 'yuv420p', '-g', '30', ...TAG709, '-c:a', 'flac'], {
  container: 'mkv',
  video: 'avc',
  audio: 'flac',
  bitDepth: 8,
  fps: 30,
  duration: D,
});
add('h264_ac3.mkv', [...av(), ...X264, '-pix_fmt', 'yuv420p', '-g', '30', ...TAG709, '-c:a', 'ac3', '-b:a', '192k'], {
  container: 'mkv',
  video: 'avc',
  audio: 'ac3',
  bitDepth: 8,
  fps: 30,
  duration: D,
});
add(
  'h264_ac3_51.mkv',
  [
    '-f',
    'lavfi',
    '-i',
    pattern(30, D),
    '-f',
    'lavfi',
    '-i',
    beep51(D),
    ...X264,
    '-pix_fmt',
    'yuv420p',
    '-g',
    '30',
    ...TAG709,
    '-c:a',
    'ac3',
    '-b:a',
    '448k',
  ],
  { container: 'mkv', video: 'avc', audio: 'ac3', channels: 6, bitDepth: 8, fps: 30, duration: D },
);
add('h264_aac.ts', [...av(), ...X264, '-pix_fmt', 'yuv420p', '-g', '30', ...TAG709, '-c:a', 'aac', '-b:a', '128k', '-f', 'mpegts'], {
  container: 'ts',
  video: 'avc',
  audio: 'aac',
  bitDepth: 8,
  fps: 30,
  duration: D,
});
add('hevc_ac3.ts', [...av(), ...X265, '-pix_fmt', 'yuv420p', '-g', '30', ...TAG709, '-c:a', 'ac3', '-b:a', '192k', '-f', 'mpegts'], {
  container: 'ts',
  video: 'hevc',
  audio: 'ac3',
  bitDepth: 8,
  fps: 30,
  duration: D,
});
// AVI: no B-frames (AVI has no PTS, so B-frames cannot be stream-copied cleanly).
add('h264_mp3.avi', [...av(), ...X264, '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0', ...TAG709, '-c:a', 'libmp3lame', '-b:a', '160k'], {
  container: 'avi',
  video: 'avc',
  audio: 'mp3',
  bitDepth: 8,
  fps: 30,
  duration: D,
});
add(
  'mpeg4_mp3.avi',
  [
    ...av(),
    '-c:v',
    'mpeg4',
    '-vtag',
    'XVID',
    '-q:v',
    '4',
    '-g',
    '30',
    '-bf',
    '0',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '160k',
  ],
  { container: 'avi', video: 'mpeg4', audio: 'mp3', bitDepth: 8, fps: 30, duration: D },
);
add('h264_aac.flv', [...av(), ...X264, '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100'], {
  container: 'flv',
  video: 'avc',
  audio: 'aac',
  bitDepth: 8,
  fps: 30,
  duration: D,
});

// ---- 1080p clips for decode and network benchmarks ----------------------------------------------
// Heavier than the rest of the matrix on purpose: full HD with film-grain-like noise at a bitrate
// a real file would have, so software decoding and streaming have real work to do. Not part of
// the playback matrix (meta.perf), and the frame counter is not burned in.
const PERF_SECONDS = 20;
const perfAv = [
  '-f',
  'lavfi',
  '-i',
  `testsrc2=size=1920x1080:rate=30:duration=${PERF_SECONDS},format=yuv420p,noise=alls=10:allf=t`,
  '-f',
  'lavfi',
  '-i',
  `aevalsrc='0.12*sin(2*PI*220*t)':s=48000:c=stereo:d=${PERF_SECONDS}`,
];
add(
  'perf_1080p_h264.mp4',
  [
    ...perfAv,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'high',
    '-b:v',
    '8M',
    '-maxrate',
    '10M',
    '-bufsize',
    '16M',
    '-g',
    '60',
    '-bf',
    '2',
    '-pix_fmt',
    'yuv420p',
    ...TAG709,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
  ],
  { container: 'mp4', video: 'avc', audio: 'aac', bitDepth: 8, fps: 30, duration: PERF_SECONDS, width: 1920, height: 1080, perf: true },
);
add(
  'perf_1080p_hevc10.mkv',
  [
    ...perfAv,
    '-c:v',
    'libx265',
    '-preset',
    'ultrafast',
    '-x265-params',
    'log-level=error',
    '-b:v',
    '6M',
    '-g',
    '60',
    '-pix_fmt',
    'yuv420p10le',
    ...TAG709,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
  ],
  { container: 'mkv', video: 'hevc', audio: 'aac', bitDepth: 10, fps: 30, duration: PERF_SECONDS, width: 1920, height: 1080, perf: true },
);

// ---- audio only ---------------------------------------------------------------------------------
const a = (d = D) => ['-f', 'lavfi', '-i', beep(d)];
add('tone.mp3', [...a(), '-c:a', 'libmp3lame', '-b:a', '160k'], { container: 'mp3', video: null, audio: 'mp3', duration: D });
add('tone.flac', [...a(), '-c:a', 'flac'], { container: 'flac', video: null, audio: 'flac', duration: D });
add('tone.opus', [...a(), '-c:a', 'libopus', '-b:a', '96k', '-f', 'ogg'], { container: 'ogg', video: null, audio: 'opus', duration: D });
add('tone_aac.m4a', [...a(), '-c:a', 'aac', '-b:a', '128k'], { container: 'mp4', video: null, audio: 'aac', duration: D });

// ---- colour accuracy ----------------------------------------------------------------------------
const quad = (pix, matrix = 'bt709') => [
  '-f',
  'lavfi',
  '-i',
  `${colorQuad(4)},scale=out_color_matrix=${matrix}:out_range=tv,format=${pix}`,
  '-f',
  'lavfi',
  '-i',
  beep(4),
];
add('colors_h264.mp4', [...quad('yuv420p'), ...X264, '-g', '30', ...TAG709, '-c:a', 'aac', '-movflags', '+faststart'], {
  container: 'mp4',
  video: 'avc',
  audio: 'aac',
  bitDepth: 8,
  fps: 30,
  duration: 4,
  colors: true,
});
add(
  'colors_h264_bt601.mp4',
  [
    ...quad('yuv420p', 'bt601'),
    ...X264,
    '-g',
    '30',
    '-colorspace',
    'smpte170m',
    '-color_primaries',
    'smpte170m',
    '-color_trc',
    'smpte170m',
    '-color_range',
    'tv',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
  ],
  { container: 'mp4', video: 'avc', audio: 'aac', bitDepth: 8, fps: 30, duration: 4, colors: true, matrix: 'bt601' },
);
add('colors_hevc10.mkv', [...quad('yuv420p10le'), ...X265, '-g', '30', ...TAG709, '-c:a', 'aac'], {
  container: 'mkv',
  video: 'hevc',
  audio: 'aac',
  bitDepth: 10,
  fps: 30,
  duration: 4,
  colors: true,
});
add('colors_vp9.webm', [...quad('yuv420p'), ...VP9, '-g', '30', ...TAG709, '-c:a', 'libopus'], {
  container: 'webm',
  video: 'vp9',
  audio: 'opus',
  bitDepth: 8,
  fps: 30,
  duration: 4,
  colors: true,
});
// HDR10-style: BT.2020 primaries + PQ transfer, converted properly from the SDR quad with zscale.
add(
  'hdr_pq_hevc10.mkv',
  [
    '-f',
    'lavfi',
    '-i',
    `${colorQuad(4)},zscale=primariesin=bt709:transferin=iec61966-2-1:matrixin=gbr:rangein=full:primaries=bt2020:transfer=smpte2084:matrix=bt2020nc:range=limited:npl=203,format=yuv420p10le`,
    '-f',
    'lavfi',
    '-i',
    beep(4),
    ...X265.slice(0, 6),
    '-x265-params',
    'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
    '-g',
    '30',
    '-colorspace',
    'bt2020nc',
    '-color_primaries',
    'bt2020',
    '-color_trc',
    'smpte2084',
    '-color_range',
    'tv',
    '-c:a',
    'aac',
  ],
  { container: 'mkv', video: 'hevc', audio: 'aac', bitDepth: 10, fps: 30, duration: 4, hdr: 'pq', colors: true },
);

// HDR highlight steps: four neutral patches authored directly as PQ code values, i.e. at known
// absolute luminances that straddle SDR reference white (203 nits). This is what tone-mapping
// operators actually differ on.
export const HDR_STEPS = { topLeft: 100, topRight: 203, bottomLeft: 400, bottomRight: 1000 }; // nits
function pqCode(nits) {
  const m1 = 0.1593017578125,
    m2 = 78.84375,
    c1 = 0.8359375,
    c2 = 18.8515625,
    c3 = 18.6875;
  const y = Math.pow(nits / 10000, m1);
  return Math.round(255 * Math.pow((c1 + c2 * y) / (1 + c3 * y), m2));
}
function pqSteps(duration, fps = 30) {
  const src = (nits) => {
    const v = pqCode(nits);
    return `color=c=${hex([v, v, v])}:s=320x180:r=${fps}:d=${duration},format=gbrp`;
  };
  const s = HDR_STEPS;
  return `${src(s.topLeft)}[a];${src(s.topRight)}[b];${src(s.bottomLeft)}[c];${src(s.bottomRight)}[d];[a][b]hstack[t];[c][d]hstack[u];[t][u]vstack,scale=out_color_matrix=bt2020:out_range=tv,format=yuv420p10le`;
}
add(
  'hdr_pq_steps.mkv',
  [
    '-f',
    'lavfi',
    '-i',
    pqSteps(4),
    '-f',
    'lavfi',
    '-i',
    beep(4),
    ...X265.slice(0, 6),
    '-x265-params',
    'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
    '-g',
    '30',
    '-colorspace',
    'bt2020nc',
    '-color_primaries',
    'bt2020',
    '-color_trc',
    'smpte2084',
    '-color_range',
    'tv',
    '-c:a',
    'aac',
  ],
  { container: 'mkv', video: 'hevc', audio: 'aac', bitDepth: 10, fps: 30, duration: 4, hdr: 'pq', colors: true, steps: true },
);

// ---- subtitles ----------------------------------------------------------------------------------
const sync = syncAss();
const font = fontAss(FONT_FAMILY);
writeFileSync(join(OUT, 'sync.ass'), sync.text);
writeFileSync(join(OUT, 'font.ass'), font.text);
writeFileSync(join(OUT, 'torture.ass'), tortureAss(D, FONT_FAMILY));
writeFileSync(join(OUT, 'subs.srt'), srt());
writeFileSync(join(OUT, 'subs.vtt'), vtt());
writeFileSync(join(OUT, 'subs.sup'), buildSup(PGS_ITEMS));
copyFileSync(FONT_SRC, join(OUT, 'DejaVuSansMono-Bold.ttf'));

const base = join(OUT, 'h264_aac.mp4');
const attach = ['-attach', FONT_SRC, '-metadata:s:t', 'mimetype=font/ttf', '-metadata:s:t', 'filename=DejaVuSansMono-Bold.ttf'];
// MKV with: ASS track (deterministic boxes), a second ASS track that needs the attached font,
// the torture script, an SRT track and a PGS track — plus the TTF as an attachment.
add(
  'subs_embedded.mkv',
  [
    '-copyts',
    '-i',
    base,
    '-i',
    join(OUT, 'sync.ass'),
    '-i',
    join(OUT, 'font.ass'),
    '-i',
    join(OUT, 'torture.ass'),
    '-i',
    join(OUT, 'subs.srt'),
    '-i',
    join(OUT, 'subs.sup'),
    '-map',
    '0:v',
    '-map',
    '0:a',
    '-map',
    '1',
    '-map',
    '2',
    '-map',
    '3',
    '-map',
    '4',
    '-map',
    '5',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-c:s:0',
    'ass',
    '-c:s:1',
    'ass',
    '-c:s:2',
    'ass',
    '-c:s:3',
    'srt',
    '-c:s:4',
    'copy',
    '-metadata:s:s:0',
    'title=Sync boxes',
    '-metadata:s:s:0',
    'language=eng',
    '-disposition:s:0',
    'default',
    '-metadata:s:s:1',
    'title=Embedded font',
    '-disposition:s:1',
    '0',
    '-metadata:s:s:2',
    'title=Torture',
    '-disposition:s:2',
    '0',
    '-metadata:s:s:3',
    'title=SRT',
    '-disposition:s:3',
    '0',
    '-metadata:s:s:4',
    'title=PGS',
    '-disposition:s:4',
    '0',
    ...attach,
  ],
  {
    container: 'mkv',
    video: 'avc',
    audio: 'aac',
    bitDepth: 8,
    fps: 30,
    duration: D,
    subtitles: ['ass', 'ass', 'ass', 'srt', 'pgs'],
    fonts: ['DejaVuSansMono-Bold.ttf'],
  },
  ['h264_aac.mp4'],
);
// Same font-dependent track, but WITHOUT the attachment (control for the embedded-font assertion).
add(
  'subs_nofont.mkv',
  [
    '-copyts',
    '-i',
    base,
    '-i',
    join(OUT, 'font.ass'),
    '-map',
    '0:v',
    '-map',
    '0:a',
    '-map',
    '1',
    '-c:v',
    'copy',
    '-c:a',
    'copy',
    '-c:s',
    'ass',
    '-disposition:s:0',
    'default',
  ],
  { container: 'mkv', video: 'avc', audio: 'aac', bitDepth: 8, fps: 30, duration: D, subtitles: ['ass'] },
  ['h264_aac.mp4'],
);

// ---- runner -------------------------------------------------------------------------------------
function run(job) {
  const out = join(OUT, job.file);
  if (!FORCE && existsSync(out) && statSync(out).size > 0) return Promise.resolve('cached');
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...job.args, out], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res('built') : rej(new Error(`${job.file}: ffmpeg exited ${code}\n${err.slice(-1500)}`))));
  });
}

async function pool(list, n) {
  let i = 0;
  const failures = [];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < list.length) {
        const job = list[i++];
        const t0 = Date.now();
        try {
          const r = await run(job);
          console.log(`${r === 'cached' ? '·' : '✓'} ${job.file}${r === 'cached' ? '' : `  (${((Date.now() - t0) / 1000).toFixed(1)}s)`}`);
        } catch (e) {
          failures.push(e);
          console.error(`✗ ${e.message}`);
        }
      }
    }),
  );
  return failures;
}

const independent = jobs.filter((j) => !j.deps);
const dependent = jobs.filter((j) => j.deps);
const failures = [...(await pool(independent, 4)), ...(await pool(dependent, 2))];

const manifest = {
  generated: new Date().toISOString(),
  counter: COUNTER,
  flash: { x: (W - 112) / W, y: (H - 112) / H, w: 96 / W, h: 96 / H, period: 1, on: 0.1 },
  colorPatches: COLOR_PATCHES,
  hdrSteps: HDR_STEPS,
  sync: { boxes: sync.boxes },
  font: { family: FONT_FAMILY, file: 'DejaVuSansMono-Bold.ttf', line: font.line },
  pgs: PGS_ITEMS.map((i) => ({
    name: i.name,
    start: i.start,
    end: i.end,
    x: i.x / 1920,
    y: i.y / 1080,
    w: i.w / 1920,
    h: i.h / 1080,
    rgb: i.rgb,
  })),
  files: jobs
    .filter((j) => existsSync(join(OUT, j.file)))
    .map((j) => ({ file: j.file, size: statSync(join(OUT, j.file)).size, ...j.meta })),
  extras: ['sync.ass', 'font.ass', 'torture.ass', 'subs.srt', 'subs.vtt', 'subs.sup'],
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.files.length}/${jobs.length} media files in ${OUT}`);
if (failures.length) process.exit(1);
