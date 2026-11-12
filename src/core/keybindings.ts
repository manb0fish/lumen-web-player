/**
 * mpv `input.conf` compatible key binding layer.
 *
 *   SPACE cycle pause
 *   Shift+RIGHT seek 1 exact
 *   [ multiply speed 1/1.1
 *
 * Key names follow mpv: printable keys are written literally (case matters, so `I` is Shift+i),
 * named keys are upper-case (LEFT, ENTER, BS, PGUP ...), modifiers are `Ctrl+`, `Alt+`, `Meta+`,
 * and `Shift+` only applies to named keys.
 */

export const DEFAULT_INPUT_CONF = `# Lumen default bindings (mpv-compatible syntax). Edit freely.
SPACE cycle pause
p cycle pause
k cycle pause
RIGHT seek 5
LEFT seek -5
UP seek 60
DOWN seek -60
Shift+RIGHT seek 1 exact
Shift+LEFT seek -1 exact
HOME seek 0 absolute
END seek 100 absolute-percent
. frame-step
, frame-back-step
[ multiply speed 1/1.1
] multiply speed 1.1
{ multiply speed 0.5
} multiply speed 2.0
BS set speed 1.0
z add sub-delay -0.1
x add sub-delay +0.1
Z add sub-delay +0.1
v cycle sub-visibility
j cycle sid
J cycle sid down
SHARP cycle aid
9 add volume -2
0 add volume 2
/ add volume -2
* add volume 2
m cycle mute
f cycle fullscreen
ENTER cycle fullscreen
ESC set fullscreen no
l ab-loop
L cycle loop-file
i cycle stats
I cycle stats
s screenshot
b cycle deband
Ctrl+s cycle-values sharpen 0 0.35 0.7 1
u cycle-values scale bilinear bicubic lanczos fsr
t cycle-values tone-mapping bt2390 hable reinhard clip
g cycle linear-scaling
Ctrl+d cycle dither
r cycle renderer
Ctrl+r cycle tier
K cycle skin
n cycle audio-normalize
Ctrl+p cycle audio-pitch-correction
WHEEL_UP add volume 2
WHEEL_DOWN add volume -2
MBTN_LEFT_DBL cycle fullscreen
`;

const NAMED: Record<string, string> = {
  ' ': 'SPACE',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  Enter: 'ENTER',
  Escape: 'ESC',
  Backspace: 'BS',
  Tab: 'TAB',
  Delete: 'DEL',
  Insert: 'INS',
  Home: 'HOME',
  End: 'END',
  PageUp: 'PGUP',
  PageDown: 'PGDWN',
};

export function parseInputConf(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue; // comment; the '#' key itself is spelled SHARP, as in mpv
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const command = m[2].replace(/\s+#.*$/, '').trim();
    if (command) map.set(m[1], command);
  }
  return map;
}

/** Translate a DOM KeyboardEvent into an mpv key name. Returns null for bare modifier presses. */
export function keyNameFromEvent(e: KeyboardEvent): string | null {
  const key = e.key;
  if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'Dead') return null;
  let name: string;
  let shiftRelevant = false;
  if (NAMED[key]) {
    name = NAMED[key];
    shiftRelevant = true;
  } else if (/^F\d{1,2}$/.test(key)) {
    name = key;
    shiftRelevant = true;
  } else if (key.length === 1) {
    name = key === '#' ? 'SHARP' : key; // already reflects Shift ("I", "{")
  } else {
    return null;
  }
  let prefix = '';
  if (e.ctrlKey) prefix += 'Ctrl+';
  if (e.altKey) prefix += 'Alt+';
  if (e.metaKey) prefix += 'Meta+';
  if (e.shiftKey && shiftRelevant) prefix += 'Shift+';
  // With Ctrl held, browsers report the lower-case letter; keep mpv's "Ctrl+s" convention.
  if (e.ctrlKey && name.length === 1) name = name.toLowerCase();
  return prefix + name;
}

export class KeyBindings {
  private map = new Map<string, string>();
  private source = '';

  constructor(conf: string = DEFAULT_INPUT_CONF) {
    this.load(conf);
  }

  /** Replace all bindings from input.conf text. */
  load(conf: string): void {
    this.source = conf;
    this.map = parseInputConf(conf);
  }

  /** Layer extra bindings on top of the current set. */
  merge(conf: string): void {
    for (const [k, v] of parseInputConf(conf)) this.map.set(k, v);
    this.source += '\n' + conf;
  }

  bind(key: string, command: string): void {
    this.map.set(key, command);
  }

  unbind(key: string): void {
    this.map.delete(key);
  }

  lookup(key: string): string | undefined {
    return this.map.get(key);
  }

  entries(): Array<[string, string]> {
    return [...this.map.entries()];
  }

  toString(): string {
    return this.source;
  }

  /** Attach to an element. Returns a detach function. */
  attach(target: HTMLElement, run: (command: string) => void): () => void {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const name = keyNameFromEvent(e);
      if (!name) return;
      const cmd = this.map.get(name);
      if (!cmd) return;
      e.preventDefault();
      e.stopPropagation();
      run(cmd);
    };
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-lp-scroll]')) return;
      const cmd = this.map.get(e.deltaY < 0 ? 'WHEEL_UP' : 'WHEEL_DOWN');
      if (!cmd) return;
      e.preventDefault();
      run(cmd);
    };
    const onDbl = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-lp-chrome]')) return;
      const cmd = this.map.get('MBTN_LEFT_DBL');
      if (cmd) run(cmd);
    };
    target.addEventListener('keydown', onKey);
    target.addEventListener('wheel', onWheel, { passive: false });
    target.addEventListener('dblclick', onDbl);
    return () => {
      target.removeEventListener('keydown', onKey);
      target.removeEventListener('wheel', onWheel);
      target.removeEventListener('dblclick', onDbl);
    };
  }
}
