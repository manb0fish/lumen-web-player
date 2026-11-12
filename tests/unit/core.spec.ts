import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildSup, PGS_ITEMS } from '../../scripts/gen-pgs.mjs';
import { CommandBus, tokenize } from '../../src/core/commands';
import { DEFAULT_INPUT_CONF, KeyBindings, keyNameFromEvent, parseInputConf } from '../../src/core/keybindings';
import { Store } from '../../src/core/store';
import { formatTime } from '../../src/core/types';
import { buildMime, planForeign, planReadable, type Capabilities } from '../../src/pipeline/router';
import { resolveMatrix, yuvUniforms } from '../../src/render/color';
import { markupToAss, parseSrt, parseVtt, sniffTextFormat } from '../../src/subs/convert';
import { isFontAttachment, scanMatroska, type MkvAttachment, type MkvCue, type MkvSubtitleTrack } from '../../src/subs/mkv';
import { PgsStream } from '../../src/subs/pgs';
import { scopeCss, validateSkin } from '../../src/ui/skin';

/** Pure logic, no browser. */

test.describe('command bus (mpv vocabulary)', () => {
  test('tokenizer: quotes, escapes and ; separators', () => {
    expect(tokenize('seek 5 relative+exact')).toEqual([['seek', '5', 'relative+exact']]);
    expect(tokenize('show-text "hello world" 2000 ; cycle pause')).toEqual([
      ['show-text', 'hello world', '2000'],
      ['cycle', 'pause'],
    ]);
    expect(tokenize(`set title 'a "b" c'`)).toEqual([['set', 'title', 'a "b" c']]);
    expect(tokenize('set x "a\\"b"')).toEqual([['set', 'x', 'a"b']]);
    expect(tokenize('  ;  ; ')).toEqual([]);
    expect(tokenize('set name ""')).toEqual([['set', 'name', '']]);
  });

  test('set / add / multiply / cycle / cycle-values with clamping, fractions and OSD', () => {
    const bus = new CommandBus();
    const osd: string[] = [];
    const errors: string[] = [];
    bus.onOsd = (t) => osd.push(t);
    bus.onError = (m) => errors.push(m);
    const s = { speed: 1, pause: false, scale: 'bicubic', volume: 100 };
    bus.defineProperty('speed', {
      type: 'number',
      min: 0.1,
      max: 8,
      get: () => s.speed,
      set: (v) => (s.speed = v),
      osd: (v) => `Speed: ${v}`,
    });
    bus.defineProperty('pause', { type: 'bool', get: () => s.pause, set: (v) => (s.pause = v), osd: () => null });
    bus.defineProperty('scale', {
      type: 'choice',
      choices: () => ['bilinear', 'bicubic', 'lanczos'],
      get: () => s.scale,
      set: (v) => (s.scale = v),
    });
    bus.defineProperty('volume', { type: 'number', min: 0, max: 130, get: () => s.volume, set: (v) => (s.volume = v) });
    bus.defineProperty('duration', { type: 'number', get: () => 60 });

    bus.run('multiply speed 1.1');
    expect(s.speed).toBeCloseTo(1.1, 6);
    bus.run('multiply speed 1/1.1');
    expect(s.speed).toBeCloseTo(1, 6);
    bus.run('set speed 100');
    expect(s.speed).toBe(8); // clamped
    bus.run('add volume -2 ; add volume +5');
    expect(s.volume).toBe(103);
    bus.run('cycle pause');
    expect(s.pause).toBe(true);
    bus.run('set pause no');
    expect(s.pause).toBe(false);
    bus.run('cycle scale');
    expect(s.scale).toBe('lanczos');
    bus.run('cycle scale');
    expect(s.scale).toBe('bilinear'); // wraps
    bus.run('cycle scale down');
    expect(s.scale).toBe('lanczos');
    bus.run('cycle-values speed 1 1.5 2');
    expect(s.speed).toBe(1); // 8 is not in the list -> first value
    bus.run('cycle-values speed 1 1.5 2');
    expect(s.speed).toBe(1.5);
    bus.run(['set', 'volume', 7]);
    expect(s.volume).toBe(7);
    expect(osd).toContain('Speed: 1.5');
    expect(osd.filter((o) => o.startsWith('pause'))).toEqual([]); // osd: () => null stays quiet

    bus.run('set scale nearest');
    bus.run('set duration 5');
    bus.run('frobnicate');
    bus.run('set speed fast');
    expect(errors).toEqual([
      expect.stringContaining('"nearest" is not valid for scale'),
      expect.stringContaining('read-only'),
      expect.stringContaining('unknown command "frobnicate"'),
      expect.stringContaining('is not a number'),
    ]);
  });

  test('async command failures are reported, not thrown', async () => {
    const bus = new CommandBus();
    const errors: string[] = [];
    bus.onError = (m) => errors.push(m);
    bus.register('boom', async () => {
      throw new Error('nope');
    });
    bus.run('boom');
    await new Promise((r) => setTimeout(r, 5));
    expect(errors).toEqual(['boom: nope']);
  });
});

test.describe('key bindings (input.conf)', () => {
  test('parser: comments, SHARP, trailing comments, last binding wins', () => {
    const map = parseInputConf(`
      # a comment
      SPACE cycle pause
      SHARP cycle aid     # switch audio
      [ multiply speed 1/1.1
      Ctrl+s cycle-values sharpen 0 0.35 0.7 1
      SPACE ignore
    `);
    expect(map.get('SPACE')).toBe('ignore');
    expect(map.get('SHARP')).toBe('cycle aid');
    expect(map.get('[')).toBe('multiply speed 1/1.1');
    expect(map.get('Ctrl+s')).toBe('cycle-values sharpen 0 0.35 0.7 1');
    expect(map.size).toBe(4);
  });

  test('DOM key events map to mpv key names', () => {
    const ev = (key: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) =>
      keyNameFromEvent({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods } as KeyboardEvent);
    expect(ev(' ')).toBe('SPACE');
    expect(ev('ArrowLeft', { shiftKey: true })).toBe('Shift+LEFT');
    expect(ev('I', { shiftKey: true })).toBe('I'); // shift is already in the character
    expect(ev('{', { shiftKey: true })).toBe('{');
    expect(ev('#', { shiftKey: true })).toBe('SHARP');
    expect(ev('S', { ctrlKey: true, shiftKey: true })).toBe('Ctrl+s');
    expect(ev('Backspace')).toBe('BS');
    expect(ev('F5', { altKey: true })).toBe('Alt+F5');
    expect(ev('Shift', { shiftKey: true })).toBeNull();
  });

  test('the default map carries the mpv ergonomics the brief asks for', () => {
    const k = new KeyBindings(DEFAULT_INPUT_CONF);
    expect(k.lookup('.')).toBe('frame-step');
    expect(k.lookup(',')).toBe('frame-back-step');
    expect(k.lookup('z')).toBe('add sub-delay -0.1');
    expect(k.lookup('x')).toBe('add sub-delay +0.1');
    expect(k.lookup('[')).toBe('multiply speed 1/1.1');
    expect(k.lookup(']')).toBe('multiply speed 1.1');
    expect(k.lookup('l')).toBe('ab-loop');
    expect(k.lookup('b')).toBe('cycle deband');
    expect(k.lookup('i')).toBe('cycle stats');
    k.bind('q', 'quit');
    k.unbind('.');
    expect(k.lookup('q')).toBe('quit');
    expect(k.lookup('.')).toBeUndefined();
  });
});

test('store: synchronous reads, batched notifications, keyed watchers', async () => {
  const store = new Store({ a: 1, b: 'x', c: 0 });
  const seen: string[][] = [];
  const watched: number[] = [];
  store.subscribe((_s, changed) => seen.push([...changed].sort() as string[]));
  const off = store.watch(['a'], (s) => watched.push(s.a));
  store.set({ a: 2 });
  store.set({ b: 'y', a: 3 });
  store.set({ c: 0 }); // no change
  expect(store.get('a')).toBe(3);
  await Promise.resolve();
  expect(seen).toEqual([['a', 'b']]); // one flush for the burst
  expect(watched).toEqual([1, 3]); // immediate call + one per flush that touched "a"
  off();
  store.set({ a: 4 });
  await Promise.resolve();
  expect(watched).toEqual([1, 3]);
});

test('formatTime', () => {
  expect(formatTime(0)).toBe('00:00');
  expect(formatTime(65.4)).toBe('01:05');
  expect(formatTime(3725.25, true)).toBe('1:02:05.250');
  expect(formatTime(-3)).toBe('-00:03');
  expect(formatTime(NaN)).toBe('--:--');
});

test.describe('subtitle text formats', () => {
  test('markup -> ASS overrides', () => {
    expect(markupToAss('<i>a</i> <b>b</b>\nline2')).toBe('{\\i1}a{\\i0} {\\b1}b{\\b0}\\Nline2');
    expect(markupToAss('<font color="#ff8000">x</font>')).toBe('{\\c&H0080FF&}x{\\c}');
    expect(markupToAss('<v Narrator>hi</v> &amp; <c.loud>bye</c>')).toBe('hi & bye');
    expect(markupToAss('{\\an8}kept')).toBe('{\\an8}kept');
  });

  test('SRT', () => {
    const ev = parseSrt(
      '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>one</i>\r\n\r\n2\r\n00:01:00,250 --> 00:01:01,000 X1:10\r\na\r\nb\r\n\r\n3\r\nbroken\r\n',
    );
    expect(ev).toHaveLength(2);
    expect(ev[0]).toEqual({ start: 1000, duration: 1500, text: '0,0,Default,,0,0,0,,{\\i1}one{\\i0}' });
    expect(ev[1].start).toBe(60250);
    expect(ev[1].text.endsWith('a\\Nb')).toBe(true);
  });

  test('WebVTT: header/notes skipped, short timestamps, cue settings', () => {
    const ev = parseVtt(
      'WEBVTT\n\nNOTE x\n\nid\n00:01.000 --> 00:02.000\nplain\n\n00:00:03.000 --> 00:00:04.000 line:0\ntop\n\n00:00:05.000 --> 00:00:06.000 align:start\nleft\n',
    );
    expect(ev.map((e) => [e.start, e.duration])).toEqual([
      [1000, 1000],
      [3000, 1000],
      [5000, 1000],
    ]);
    expect(ev[0].text).toBe('0,0,Default,,0,0,0,,plain');
    expect(ev[1].text).toContain('{\\an8}top');
    expect(ev[2].text).toContain('{\\an1}left');
  });

  test('format sniffing', () => {
    expect(sniffTextFormat('a.ASS', '')).toBe('ass');
    expect(sniffTextFormat('a.txt', 'WEBVTT\n')).toBe('vtt');
    expect(sniffTextFormat('a.txt', '1\n00:00:01,000 --> 00:00:02,000\nx')).toBe('srt');
    expect(sniffTextFormat('a.txt', '[Script Info]\n')).toBe('ass');
    expect(sniffTextFormat('a.txt', 'hello')).toBeNull();
  });
});

test.describe('PGS', () => {
  test('encode -> decode round trip: timing, geometry, palette and RLE', () => {
    // ImageData does not exist in Node; the decoder only needs width/height/data.
    (globalThis as any).ImageData = class {
      data: Uint8ClampedArray;
      constructor(
        public width: number,
        public height: number,
      ) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    };
    const stream = new PgsStream();
    stream.feedSup(buildSup(PGS_ITEMS));
    expect(stream.events.map((e) => [e.pts, e.items.length])).toEqual([
      [1, 1],
      [3, 0],
      [4, 1],
      [6, 0],
    ]);
    const first = stream.events[0];
    expect([first.width, first.height]).toEqual([1920, 1080]);
    const item = first.items[0];
    expect([item.x, item.y, item.image.width, item.image.height]).toEqual([192, 216, 384, 162]);
    const px = (x: number, y: number) => Array.from(item.image.data.subarray((y * 384 + x) * 4, (y * 384 + x) * 4 + 4));
    const centre = px(192, 81);
    for (const [i, v] of [255, 220, 0].entries()) expect(Math.abs(centre[i] - v), `centre channel ${i}`).toBeLessThanOrEqual(3);
    expect(centre[3]).toBe(255);
    const border = px(2, 2); // 6 px white border
    expect(border[0]).toBeGreaterThan(250);
    expect(border[2]).toBeGreaterThan(250);
    // lookup by time
    expect(stream.find(0.5)).toBe(-1);
    expect(stream.find(1)).toBe(0);
    expect(stream.find(2.99)).toBe(0);
    expect(stream.find(3)).toBe(1);
    expect(stream.find(100)).toBe(3);
  });

  test('truncated / garbage input never throws', () => {
    const sup: Uint8Array = buildSup(PGS_ITEMS);
    for (const cut of [1, 13, 40, 200, sup.length - 5]) {
      const s = new PgsStream();
      expect(() => s.feedSup(sup.subarray(0, cut))).not.toThrow();
    }
    const junk = new Uint8Array(4096).map((_, i) => (i * 73 + 11) & 0xff);
    expect(() => new PgsStream().feedSup(junk)).not.toThrow();
    expect(() => new PgsStream().feedBlock(junk, 1)).not.toThrow();
  });
});

test.describe('Matroska scanner', () => {
  test('finds subtitle tracks, events and font attachments in the generated file', async () => {
    const blob = new Blob([readFileSync('public/media/subs_embedded.mkv')]);
    let tracks: MkvSubtitleTrack[] = [];
    const cues: MkvCue[] = [];
    const attachments: MkvAttachment[] = [];
    const ok = await scanMatroska(blob, {
      onTracks: (t) => (tracks = t),
      onCue: (c) => cues.push(c),
      onAttachment: (a) => attachments.push(a),
    });
    expect(ok).toBe(true);
    expect(tracks.map((t) => [t.codecId, t.name, t.isDefault])).toEqual([
      ['S_TEXT/ASS', 'Sync boxes', true],
      ['S_TEXT/ASS', 'Embedded font', false],
      ['S_TEXT/ASS', 'Torture', false],
      ['S_TEXT/UTF8', 'SRT', false],
      ['S_HDMV/PGS', 'PGS', false],
    ]);
    const header = new TextDecoder().decode(tracks[0].codecPrivate!);
    expect(header).toContain('[Script Info]');
    expect(header).toContain('Style: Shape');
    const byTrack = (n: number) => cues.filter((c) => c.track === tracks[n].number);
    // first deterministic box: 1.0 - 2.0 s (+21 ms container offset shared with the video)
    const box = byTrack(0)[0];
    expect(box.start).toBe(1021);
    expect(box.duration).toBe(1000);
    expect(new TextDecoder().decode(box.data)).toMatch(/^\d+,0,Shape,,0,0,0,,\{\\an7\\pos\(64,144\)/);
    expect(byTrack(0)).toHaveLength(5);
    expect(byTrack(2).length).toBeGreaterThan(300); // torture script
    expect(new TextDecoder().decode(byTrack(3)[0].data)).toBe('<i>Italic SRT line</i>');
    expect(byTrack(4).map((c) => c.start)).toEqual([1021, 3021, 4021, 6021]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe('DejaVuSansMono-Bold.ttf');
    expect(isFontAttachment(attachments[0])).toBe(true);
    expect(attachments[0].data.length).toBe(readFileSync('public/media/DejaVuSansMono-Bold.ttf').length);
    // the PGS blocks decode with the same decoder used for .sup files
    (globalThis as any).ImageData ??= class {
      data: Uint8ClampedArray;
      constructor(
        public width: number,
        public height: number,
      ) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    };
    const pgs = new PgsStream();
    for (const c of byTrack(4)) pgs.feedBlock(c.data, c.start / 1000);
    expect(pgs.events.map((e) => e.items.length)).toEqual([1, 0, 1, 0]);
  });

  test('non-Matroska input is rejected; scanning can be aborted; a small window still parses', async () => {
    expect(await scanMatroska(new Blob([readFileSync('public/media/h264_aac.mp4')]), {})).toBe(false);
    expect(await scanMatroska(new Blob([new Uint8Array(10)]), {})).toBe(false);
    const ac = new AbortController();
    let n = 0;
    await scanMatroska(new Blob([readFileSync('public/media/subs_embedded.mkv')]), {
      signal: ac.signal,
      onCue: () => {
        if (++n === 3) ac.abort();
      },
    });
    expect(n).toBeLessThan(40);
  });

  test('a WebM without subtitles yields no tracks and does not read block payloads as cues', async () => {
    let tracks: MkvSubtitleTrack[] | null = null;
    let cues = 0;
    expect(
      await scanMatroska(new Blob([readFileSync('public/media/vp9_opus.webm')]), { onTracks: (t) => (tracks = t), onCue: () => cues++ }),
    ).toBe(true);
    expect(tracks).toEqual([]);
    expect(cues).toBe(0);
  });
});

test.describe('colour math', () => {
  const apply = (u: ReturnType<typeof yuvUniforms>, code: [number, number, number], depth: number) => {
    // emulate the shader: n = dot(texel.rg, pack) where the texel holds the LE bytes of the code value
    const n = code.map((c) => (depth > 8 ? ((c & 0xff) / 255) * u.pack[0] + ((c >> 8) / 255) * u.pack[1] : (c / 255) * u.pack[0]));
    const yuv = n.map((v, i) => (v - u.offset[i]) * u.scale[i]);
    const m = u.matrix;
    return [0, 1, 2].map((r) => m[r * 3] * yuv[0] + m[r * 3 + 1] * yuv[1] + m[r * 3 + 2] * yuv[2]);
  };
  const c709 = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } as const;

  test('limited-range BT.709: reference white, black and primaries, 8 and 10 bit', () => {
    for (const depth of [8, 10]) {
      const s = 1 << (depth - 8);
      const u = yuvUniforms(c709, depth, 1080);
      const near = (rgb: number[], want: number[]) => rgb.forEach((v, i) => expect(v).toBeCloseTo(want[i], 2));
      near(apply(u, [235 * s, 128 * s, 128 * s], depth), [1, 1, 1]);
      near(apply(u, [16 * s, 128 * s, 128 * s], depth), [0, 0, 0]);
      near(apply(u, [63 * s, 102 * s, 240 * s], depth), [1, 0, 0]); // BT.709 red
      near(apply(u, [32 * s, 240 * s, 118 * s], depth), [0, 0, 1]); // BT.709 blue
    }
  });

  test('full range and BT.601 / BT.2020', () => {
    const full = yuvUniforms({ ...c709, fullRange: true }, 8, 720);
    apply(full, [255, 128, 128], 8).forEach((v) => expect(v).toBeCloseTo(1, 2));
    const u601 = yuvUniforms({ ...c709, matrix: 'bt601' }, 8, 480);
    const red601 = apply(u601, [81, 90, 240], 8);
    expect(red601[0]).toBeCloseTo(1, 1);
    expect(red601[1]).toBeCloseTo(0, 1);
    const u2020 = yuvUniforms({ primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020nc', fullRange: false }, 10, 2160);
    expect(u2020.matrix[2]).toBeCloseTo(2 * (1 - 0.2627), 4);
  });

  test('untagged streams: SD defaults to BT.601, HD to BT.709, BT.2020 primaries imply the 2020 matrix', () => {
    const unknown = { primaries: 'unknown', transfer: 'unknown', matrix: 'unknown', fullRange: false } as const;
    expect(resolveMatrix(unknown, 480)).toBe('bt601');
    expect(resolveMatrix(unknown, 1080)).toBe('bt709');
    expect(resolveMatrix({ ...unknown, primaries: 'bt2020' }, 2160)).toBe('bt2020nc');
  });
});

test.describe('router', () => {
  const caps: Capabilities = { webcodecs: true, mse: true, sab: true, webgpu: true, audioWorklet: true };
  const info = (video: string | null, audio: string | null, container = 'Matroska') => ({
    container,
    demuxer: 'mediabunny' as const,
    duration: 10,
    startTime: 0,
    title: null,
    video: video
      ? {
          id: 1,
          codec: video,
          codecString: video === 'avc' ? 'avc1.64001e' : video,
          width: 640,
          height: 360,
          displayWidth: 640,
          displayHeight: 360,
          rotation: 0 as const,
          fps: 30,
          bitDepth: 8,
          pixFmt: null,
          color: { primaries: 'bt709' as const, transfer: 'bt709' as const, matrix: 'bt709' as const, fullRange: false },
          hdr: false,
        }
      : null,
    audio: audio
      ? {
          id: 2,
          index: 0,
          codec: audio,
          codecString: audio === 'aac' ? 'mp4a.40.2' : audio,
          sampleRate: 48000,
          channels: 2,
          language: 'und',
          name: null,
        }
      : null,
    audioTracks: [],
  });
  const withMse = (supported: (mime: string) => boolean, fn: () => void) => {
    (globalThis as any).MediaSource = { isTypeSupported: supported };
    try {
      fn();
    } finally {
      delete (globalThis as any).MediaSource;
    }
  };
  const modes = (plans: Array<{ mode: string }>) => plans.map((p) => p.mode);

  test('everything supported: WebCodecs first, then MSE, FFmpeg, native as fallbacks', () => {
    withMse(
      () => true,
      () => {
        const probe = { readable: true, info: info('avc', 'aac'), videoSupported: true, audioSupport: { 2: true }, muxable: true };
        expect(modes(planReadable(probe, 'auto', caps, 'auto'))).toEqual(['webcodecs', 'mse-remux', 'wasm-sw', 'native']);
        expect(modes(planReadable(probe, 'mse', caps, 'auto'))).toEqual(['mse-remux']);
        expect(modes(planReadable(probe, 'wasm', caps, 'auto'))).toEqual(['wasm-sw']);
        expect(modes(planReadable(probe, 'wasm', caps, 'remux'))).toEqual(['wasm-remux-mse']);
        expect(buildMime(probe.info)).toBe('video/mp4; codecs="avc1.64001e, mp4a.40.2"');
      },
    );
  });

  test('foreign audio codec: hybrid route; foreign video codec: software decode', () => {
    withMse(
      (m) => !/ac-3|ac3|mpeg4/.test(m),
      () => {
        const ac3 = { readable: true, info: info('avc', 'ac3'), videoSupported: true, audioSupport: { 2: false }, muxable: true };
        expect(modes(planReadable(ac3, 'auto', caps, 'auto'))).toEqual(['webcodecs+wasm-audio', 'wasm-sw', 'native']);
        expect(modes(planReadable(ac3, 'webcodecs', caps, 'auto'))).toEqual(['webcodecs+wasm-audio']);
        expect(planReadable(ac3, 'mse', caps, 'auto')).toEqual([]); // forced tier that cannot work -> caller reports it
        const hevc = { readable: true, info: info('hevc', 'aac'), videoSupported: false, audioSupport: { 2: true }, muxable: true };
        withMse(
          () => false,
          () => expect(modes(planReadable(hevc, 'auto', caps, 'auto'))).toEqual(['wasm-sw', 'native']),
        );
      },
    );
  });

  test('missing browser features change the plan, never crash it', () => {
    withMse(
      () => true,
      () => {
        const probe = { readable: true, info: info('avc', 'aac'), videoSupported: true, audioSupport: { 2: true }, muxable: true };
        expect(modes(planReadable(probe, 'auto', { ...caps, webcodecs: false }, 'auto'))[0]).toBe('mse-remux');
        expect(modes(planReadable(probe, 'auto', { ...caps, webcodecs: false, mse: false }, 'auto'))[0]).toBe('wasm-sw');
        expect(modes(planReadable(probe, 'auto', { ...caps, audioWorklet: false }, 'auto'))[0]).toBe('mse-remux');
      },
    );
  });

  test('containers only FFmpeg can open: remux when codecs are fine, transcode audio, or decode in software', () => {
    withMse(
      (m) => /avc1|mp4a/.test(m) && !/mp3|mpeg4/.test(m),
      () => {
        const ff = (v: string, a: string) => ({ ...info(v, a, 'avi'), demuxer: 'ffmpeg' as const });
        expect(modes(planForeign(ff('avc', 'aac'), 'auto', caps, 'auto'))).toEqual(['wasm-remux-mse', 'wasm-sw']);
        expect(modes(planForeign(ff('avc', 'mp3'), 'auto', caps, 'auto'))).toEqual(['wasm-transcode-mse', 'wasm-sw']);
        expect(modes(planForeign(ff('mpeg4', 'mp3'), 'auto', caps, 'auto'))).toEqual(['wasm-sw']);
        expect(modes(planForeign(ff('avc', 'aac'), 'auto', { ...caps, mse: false }, 'auto'))).toEqual(['wasm-sw']);
        expect(planForeign(ff('avc', 'aac'), 'webcodecs', caps, 'auto')).toEqual([]);
        expect(modes(planForeign(ff('avc', 'aac'), 'wasm', caps, 'sw'))).toEqual(['wasm-sw']);
      },
    );
  });
});

test.describe('skin packages', () => {
  const base = { id: 'x', name: 'X', layout: { bottom: [['play', { control: 'button', command: 'seek 1' }]] } };

  test('validation keeps what is sane and drops what is not', () => {
    const s = validateSkin({
      ...base,
      tokens: { '--lp-accent': '#fff', '--bad': 'red; } body { display:none', color: 'red', '--u': 'url(x)' },
      autohide: -5,
      dock: 1,
    });
    expect(s.tokens).toEqual({ '--lp-accent': '#fff' });
    expect(s.autohide).toBe(0);
    expect(s.dock).toBe(true);
    expect(s.layout.bottom).toEqual(base.layout.bottom);
    expect(() => validateSkin(null)).toThrow(/JSON object/);
    expect(() => validateSkin({ ...base, id: '../etc' })).toThrow(/id/);
    expect(() => validateSkin({ ...base, name: '' })).toThrow(/name/);
    expect(() => validateSkin({ id: 'x', name: 'X' })).toThrow(/layout/);
    expect(() => validateSkin({ ...base, layout: { bottom: [[42]] } })).toThrow(/control name/);
  });

  test('CSS is scoped with nesting, at-rules are hoisted, imports and remote URLs are removed', () => {
    const css = scopeCss(
      'neon',
      '/* mentions @keyframes in a comment */ @import "x.css"; .lp-btn { color: red; background: url(http://a/b.png) } @keyframes k { to { opacity: 0 } } .lp-time { mask: url("data:image/svg+xml,<svg/>") }',
    );
    expect(css).not.toContain('@import');
    expect(css).not.toContain('http://a/b.png');
    expect(css).toContain('url("data:image/svg+xml,<svg/>")');
    expect(css.indexOf('@keyframes k')).toBeLessThan(css.indexOf('.lp-root[data-skin="neon"] {'));
    expect(css).toMatch(/\.lp-root\[data-skin="neon"\] \{\s*\.lp-btn \{ color: red;/);
    // already-scoped CSS (the built-in skins) is passed through
    const own = '.lp-root[data-skin="neon"] .lp-btn { color: red }';
    expect(scopeCss('neon', own)).toBe(own);
    // ... including after a production minifier has stripped the attribute quotes
    const minified = '.lp-root[data-skin=neon] .lp-btn{color:red}';
    expect(scopeCss('neon', minified)).toBe(minified);
    const single = ".lp-root[data-skin='neon']{color:red}";
    expect(scopeCss('neon', single)).toBe(single);
    // a different skin's selector does not count as scoping for this one
    expect(scopeCss('neon', '.lp-root[data-skin=neon2] .lp-btn{color:red}')).toContain('.lp-root[data-skin="neon"] {');
  });
});
