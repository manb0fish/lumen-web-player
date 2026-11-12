// Programmatic ASS generators for the test suite.
//
//   syncAss()     small, fully deterministic script: solid boxes at known places / times, used by
//                 the tests to assert that subtitles appear on exactly the right video frames.
//   tortureAss()  a deliberately heavy typesetting script: \move, \org + \frz/\frx/\fry rotation,
//                 \t animation with acceleration, vector drawings (\p1, béziers), clip-strip
//                 gradients, \k / \kf / \ko karaoke, blur, fades, vector \clip and \iclip.

const W = 1280;
const H = 720;

const ts = (t) => {
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
};

const header = (title, extraStyles = '') => `[Script Info]
Title: ${title}
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,sans-serif,44,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2.5,1,2,40,40,36,1
Style: Shape,sans-serif,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1
${extraStyles}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const dlg = (layer, start, end, style, text) => `Dialogue: ${layer},${ts(start)},${ts(end)},${style},,0,0,0,,${text}`;
const rect = (w, h) => `m 0 0 l ${w} 0 ${w} ${h} 0 ${h}`;
/** ASS colour is &HBBGGRR& */
const col = (r, g, b) =>
  `&H${[b, g, r]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}&`;

/**
 * Boxes whose positions are described in normalised video coordinates so tests can sample them
 * without knowing the script resolution. Returned alongside the script text.
 */
export function syncAss() {
  const boxes = [
    // name, start, end, x, y, w, h (normalised), rgb
    { name: 'red', start: 1.0, end: 2.0, x: 0.05, y: 0.2, w: 0.2, h: 0.2, rgb: [255, 0, 0] },
    { name: 'green', start: 2.0, end: 3.0, x: 0.75, y: 0.2, w: 0.2, h: 0.2, rgb: [0, 255, 0] },
    { name: 'blue', start: 3.5, end: 5.0, x: 0.4, y: 0.6, w: 0.2, h: 0.2, rgb: [0, 0, 255] },
    { name: 'white', start: 5.5, end: 6.0, x: 0.05, y: 0.6, w: 0.2, h: 0.2, rgb: [255, 255, 255] },
  ];
  const lines = boxes.map((b) => {
    const px = Math.round(b.x * W);
    const py = Math.round(b.y * H);
    const pw = Math.round(b.w * W);
    const ph = Math.round(b.h * H);
    return dlg(0, b.start, b.end, 'Shape', `{\\an7\\pos(${px},${py})\\bord0\\shad0\\1c${col(...b.rgb)}\\p1}${rect(pw, ph)}{\\p0}`);
  });
  // A text line too, so there is glyph rendering in the deterministic script as well.
  lines.push(dlg(1, 6.2, 7.5, 'Default', '{\\an2}Lumen subtitle sync check'));
  return { text: header('Lumen sync test') + lines.join('\n') + '\n', boxes };
}

/** Same line rendered with an embedded-only font vs. the default, used to prove attachments are used. */
export function fontAss(fontFamily) {
  const text =
    header(
      'Lumen font test',
      `Style: Embedded,${fontFamily},60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n`,
    ) +
    // Long run of a single narrow glyph: its advance width differs hugely between a monospace and a proportional face.
    dlg(0, 0, 3600, 'Embedded', `{\\an7\\pos(64,200)\\bord0\\shad0\\1c${col(255, 255, 0)}}iiiiiiiiiiiiiiiiiiii`) +
    '\n';
  return { text, line: { x: 64 / W, y: 200 / H, height: 80 / H } };
}

export function tortureAss(duration = 8, fontFamily = 'sans-serif') {
  const L = [];
  // 1. Vector drawing with béziers: a star and a rounded blob, rotating around a custom origin.
  const star = 'm 0 -60 l 14 -19 57 -19 23 7 35 49 0 24 -35 49 -23 7 -57 -19 -14 -19';
  const blob = 'm 0 -50 b 40 -50 60 -20 50 10 b 45 45 10 60 -20 50 b -55 40 -60 0 -45 -25 b -35 -45 -20 -50 0 -50';
  L.push(
    dlg(
      1,
      0,
      duration,
      'Shape',
      `{\\an7\\pos(160,260)\\org(160,260)\\1c${col(255, 200, 0)}\\bord3\\3c${col(120, 60, 0)}\\blur1.5\\t(0,${duration * 1000},\\frz720)\\p1}${star}{\\p0}`,
    ),
  );
  L.push(
    dlg(
      1,
      0,
      duration,
      'Shape',
      `{\\an7\\pos(1120,260)\\org(1120,260)\\1c${col(80, 220, 255)}\\bord2\\3c${col(0, 40, 80)}\\t(0,${duration * 1000},0.5,\\frz-540\\fscx160\\fscy160)\\p1}${blob}{\\p0}`,
    ),
  );

  // 2. 3D perspective: text swinging on X and Y.
  L.push(
    dlg(
      2,
      0.2,
      duration - 0.2,
      'Default',
      `{\\an5\\pos(640,150)\\fn${fontFamily}\\fs64\\bord3\\blur0.6\\org(640,150)\\frx0\\fry0\\t(0,${(duration - 0.4) * 500},\\frx50\\fry-55)\\t(${(duration - 0.4) * 500},${(duration - 0.4) * 1000},\\frx0\\fry55)}PERSPECTIVE`,
    ),
  );

  // 3. Clip-strip gradient (the classic typesetting trick): 40 layers, each a 1-strip clip of the same text.
  const strips = 40;
  const gx = 240;
  const gw = 800;
  for (let i = 0; i < strips; i++) {
    const f = i / (strips - 1);
    const r = Math.round(255 * (1 - f) + 40 * f);
    const g = Math.round(60 * (1 - f) + 220 * f);
    const b = Math.round(160 * (1 - f) + 255 * f);
    const x0 = Math.round(gx + (gw * i) / strips);
    const x1 = Math.round(gx + (gw * (i + 1)) / strips);
    L.push(
      dlg(
        3,
        0,
        duration,
        'Default',
        `{\\an5\\pos(640,330)\\fs84\\b1\\bord0\\shad0\\1c${col(r, g, b)}\\clip(${x0},260,${x1},400)}GRADIENT TEXT`,
      ),
    );
  }

  // 4. Movers: \move with fades, scaling and colour transforms, staggered every 0.25 s.
  for (let i = 0; i < Math.floor(duration * 4) - 4; i++) {
    const t0 = i * 0.25;
    const y = 430 + (i % 4) * 26;
    const hue = (i * 47) % 360;
    const [r, g, b] = hsl(hue, 0.9, 0.6);
    L.push(
      dlg(
        4,
        t0,
        t0 + 1.5,
        'Default',
        `{\\an5\\fs30\\bord2\\move(${-80},${y},${W + 80},${y})\\fad(150,150)\\1c${col(r, g, b)}\\t(\\fscx150\\fscy150\\frz25\\blur2)}mover ${i}`,
      ),
    );
  }

  // 5. Karaoke: \k (instant), \kf (sweep), \ko (outline) across three lines.
  const syl = ['Ka', 'ra', 'o', 'ke ', 'ti', 'ming ', 'ef', 'fects ', 'in ', 'A', 'S', 'S'];
  const kTag = (tag) => syl.map((s, i) => `{\\${tag}${30 + (i % 3) * 15}}${s}`).join('');
  L.push(dlg(5, 0.5, duration, 'Default', `{\\an2\\pos(640,600)\\1c${col(255, 255, 80)}\\2c${col(90, 90, 90)}\\bord3}${kTag('k')}`));
  L.push(dlg(5, 0.5, duration, 'Default', `{\\an2\\pos(640,650)\\1c${col(80, 255, 160)}\\2c${col(70, 70, 70)}\\bord3}${kTag('kf')}`));
  L.push(
    dlg(
      5,
      0.5,
      duration,
      'Default',
      `{\\an2\\pos(640,700)\\1c${col(255, 140, 220)}\\2c${col(60, 60, 60)}\\3c${col(255, 255, 255)}\\bord3}${kTag('ko')}`,
    ),
  );

  // 6. Vector clip / inverse clip animated by \t.
  L.push(
    dlg(
      6,
      1,
      duration,
      'Default',
      `{\\an5\\pos(320,520)\\fs54\\bord2\\clip(m 200 470 b 320 430 440 470 440 520 b 440 570 320 610 200 570)\\t(\\frz10)}VECTOR CLIP`,
    ),
  );
  L.push(
    dlg(
      6,
      1,
      duration,
      'Default',
      `{\\an5\\pos(960,520)\\fs54\\bord2\\iclip(900,490,1020,550)\\t(0,${(duration - 1) * 1000},\\iclip(820,490,1100,550))}INVERSE CLIP`,
    ),
  );

  // 7. A burst of short-lived particles (stress: hundreds of events, each animated).
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 240; i++) {
    const t0 = rnd() * (duration - 1);
    const x0 = 640 + (rnd() - 0.5) * 200;
    const y0 = 380 + (rnd() - 0.5) * 80;
    const x1 = x0 + (rnd() - 0.5) * 900;
    const y1 = y0 + (rnd() - 0.5) * 500;
    const [r, g, b] = hsl(rnd() * 360, 1, 0.65);
    const s = 4 + Math.round(rnd() * 8);
    L.push(
      dlg(
        7,
        t0,
        t0 + 0.9,
        'Shape',
        `{\\an5\\move(${x0.toFixed(0)},${y0.toFixed(0)},${x1.toFixed(0)},${y1.toFixed(0)})\\fad(0,300)\\1c${col(r, g, b)}\\blur1\\t(\\frz${Math.round(rnd() * 720)})\\p1}${rect(s, s)}{\\p0}`,
      ),
    );
  }
  return header('Lumen torture test') + L.join('\n') + '\n';
}

function hsl(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

export function srt() {
  return (
    [
      '1\n00:00:01,000 --> 00:00:02,500\n<i>Italic SRT line</i>',
      '2\n00:00:03,000 --> 00:00:04,500\n<b>Bold</b> and <font color="#ff0000">red</font>\nsecond line',
      '3\n00:00:05,000 --> 00:00:06,500\n{\\an8}Top-aligned via ASS tag',
    ].join('\n\n') + '\n'
  );
}

export function vtt() {
  return [
    'WEBVTT',
    '',
    'NOTE generated for the Lumen test-suite',
    '',
    'cue-1',
    '00:00:01.000 --> 00:00:02.500',
    '<v Narrator>WebVTT voice span</v>',
    '',
    '00:00:03.000 --> 00:00:04.500 line:0',
    'Top line via cue settings',
    '',
    '00:05.000 --> 00:06.500 align:start',
    '<i>Short timestamp form</i>',
    '',
  ].join('\n');
}
