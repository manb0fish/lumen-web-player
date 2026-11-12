/**
 * Text subtitle formats are normalised to ASS so a single engine (libass) renders everything.
 * Events use the Matroska "chunk" layout — ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text —
 * which is what libass' ass_process_chunk() consumes, so embedded and converted tracks share a path.
 */

export interface ChunkEvent {
  /** milliseconds */
  start: number;
  duration: number;
  text: string;
}

export const DEFAULT_ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,sans-serif,58,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,70,70,56,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

function parseTimestamp(s: string): number {
  // 00:01:02,345 | 00:01:02.345 | 01:02.345
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(s.trim());
  if (!m) return NaN;
  const h = Number(m[1] ?? 0);
  return ((h * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, '0'));
}

function htmlColorToAss(c: string): string | null {
  const named: Record<string, string> = {
    white: 'FFFFFF',
    black: '000000',
    red: 'FF0000',
    green: '008000',
    lime: '00FF00',
    blue: '0000FF',
    yellow: 'FFFF00',
    cyan: '00FFFF',
    magenta: 'FF00FF',
    gray: '808080',
    orange: 'FFA500',
  };
  let hex = c.trim().replace(/^#/, '');
  if (named[hex.toLowerCase()]) hex = named[hex.toLowerCase()];
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/./g, (x) => x + x);
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return `&H${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}&`.toUpperCase();
}

/** HTML-ish inline markup (SRT / WebVTT) -> ASS override tags. */
export function markupToAss(text: string): string {
  let out = text
    .replace(/\r/g, '')
    .replace(/<(\/?)(i|b|u|s)>/gi, (_m, close: string, tag: string) => `{\\${tag.toLowerCase()}${close ? 0 : 1}}`)
    .replace(/<font[^>]*color\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi, (_m, color: string) => {
      const c = htmlColorToAss(color);
      return c ? `{\\c${c}}` : '';
    })
    .replace(/<\/font>/gi, '{\\c}')
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '') // WebVTT karaoke timestamps
    .replace(/<\/?[a-z][^>]*>/gi, ''); // anything else (<c.class>, <v Speaker>, <ruby> …)
  out = out
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
  return out.trim().replace(/\n/g, '\\N');
}

export function chunk(readOrder: number, text: string): string {
  return `${readOrder},0,Default,,0,0,0,,${text}`;
}

export function parseSrt(text: string): ChunkEvent[] {
  const events: ChunkEvent[] = [];
  const blocks = text
    .replace(/^﻿/, '')
    .replace(/\r/g, '')
    .split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i) => l.trim() !== '' || i > 1);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp(b);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const body = lines.slice(ti + 1).join('\n');
    if (!body.trim()) continue;
    events.push({ start, duration: Math.max(0, end - start), text: chunk(events.length, markupToAss(body)) });
  }
  return events;
}

export function parseVtt(text: string): ChunkEvent[] {
  const events: ChunkEvent[] = [];
  const blocks = text
    .replace(/^﻿/, '')
    .replace(/\r/g, '')
    .split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue; // header, NOTE, STYLE, REGION
    const [a, rest] = lines[ti].split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp(rest);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const settings = rest.trim().split(/\s+/).slice(1).join(' ');
    let prefix = '';
    const line = /line:(-?[\d.]+)(%?)/.exec(settings);
    if (line) {
      const v = parseFloat(line[1]);
      const top = line[2] ? v < 50 : v >= 0 && v < 8;
      if (top) prefix = '{\\an8}';
    }
    const align = /align:(start|left|end|right)/.exec(settings);
    if (align) {
      const left = align[1] === 'start' || align[1] === 'left';
      prefix = prefix ? (left ? '{\\an7}' : '{\\an9}') : left ? '{\\an1}' : '{\\an3}';
    }
    const body = lines.slice(ti + 1).join('\n');
    if (!body.trim()) continue;
    events.push({ start, duration: Math.max(0, end - start), text: chunk(events.length, prefix + markupToAss(body)) });
  }
  return events;
}

/** Guess a text subtitle format from its name and contents. */
export function sniffTextFormat(name: string, text: string): 'ass' | 'srt' | 'vtt' | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  if (ext === 'vtt') return 'vtt';
  if (ext === 'srt') return 'srt';
  const head = text.slice(0, 512);
  if (/^﻿?WEBVTT/.test(head)) return 'vtt';
  if (/\[Script Info\]/i.test(head)) return 'ass';
  if (/\d{2}:\d{2}:\d{2},\d{3}\s+-->/.test(head)) return 'srt';
  return null;
}
