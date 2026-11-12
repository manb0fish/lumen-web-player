/**
 * Skin engine.
 *
 * A skin is a plain JSON package:
 *
 *   {
 *     "id": "glass", "name": "Modern Glass",
 *     "tokens":  { "--lp-accent": "#7dd3fc", ... },          // CSS custom properties
 *     "layout":  { "top": [[...]], "center": [[...]], "bottom": [[...], [...]] },
 *     "icons":   { "play": "<path d='...'/>" },               // 24x24 SVG inner markup
 *     "css":     ".lp-btn { ... }",                           // optional, auto-scoped to the skin
 *     "osd":     { "position": "top-left" },
 *     "autohide": 2500, "dock": false
 *   }
 *
 * `layout` rows contain control names ("play", "seekbar", "time" …) or objects with options
 * ({ "control": "button", "command": "seek -10", "icon": "rewind" }), so a skin can rearrange,
 * remove or add controls — including new buttons bound to any player command — without code.
 */

export type LayoutItem = string | ({ control: string } & Record<string, any>);

export interface SkinManifest {
  id: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
  tokens?: Record<string, string>;
  layout: {
    top?: LayoutItem[][];
    center?: LayoutItem[][];
    bottom?: LayoutItem[][];
  };
  icons?: Record<string, string>;
  css?: string;
  /** URL of a stylesheet, relative to the manifest (only used when loading from a URL). */
  stylesheet?: string;
  osd?: { position?: 'top-left' | 'top-right' | 'top-center' | 'center' };
  /** Milliseconds of inactivity before the chrome hides; 0 keeps it visible. */
  autohide?: number;
  /** Dock the bottom region under the picture instead of overlaying it. */
  dock?: boolean;
  seekbar?: { thumbnails?: boolean };
}

const SAFE_SVG_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'g']);
const SAFE_SVG_ATTRS = new Set([
  'd',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'points',
  'transform',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'fill-rule',
  'clip-rule',
  'fill-opacity',
]);

/** Icons come from untrusted packages: keep only inert shape elements and presentation attributes. */
export function sanitizeIcon(markup: string): string {
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return '';
  const walk = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (!SAFE_SVG_TAGS.has(tag)) return '';
    let attrs = '';
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      if (!SAFE_SVG_ATTRS.has(name)) continue;
      if (/url\s*\(|javascript:/i.test(a.value)) continue;
      attrs += ` ${name}="${a.value.replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`;
    }
    const inner = Array.from(el.children).map(walk).join('');
    return `<${tag}${attrs}>${inner}</${tag}>`;
  };
  return Array.from(doc.documentElement.children).map(walk).join('');
}

/** Pull top-level at-rules that cannot be nested (@keyframes, @font-face) out of a stylesheet. */
function splitAtRules(css: string): { hoisted: string; rest: string } {
  let hoisted = '';
  let rest = '';
  let i = 0;
  while (i < css.length) {
    const m = /@(keyframes|font-face|property)\b/y;
    m.lastIndex = i;
    const hit = m.exec(css);
    if (hit) {
      const open = css.indexOf('{', i);
      if (open < 0) break;
      let depth = 0;
      let j = open;
      for (; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}' && --depth === 0) break;
      }
      hoisted += css.slice(i, j + 1) + '\n';
      i = j + 1;
    } else {
      const next = css.slice(i).search(/@(keyframes|font-face|property)\b/);
      const end = next < 0 ? css.length : i + next;
      rest += css.slice(i, end);
      i = end;
    }
  }
  return { hoisted, rest };
}

/**
 * Scope a skin's CSS to its own data-skin attribute using native CSS nesting, and neutralise the
 * bits of CSS that could reach outside the player (imports, remote URLs).
 */
export function scopeCss(id: string, css: string): string {
  css = css.replace(/\/\*[\s\S]*?\*\//g, ''); // comments may mention at-rules; drop them before parsing
  let safe = css.replace(/@import[^;]*;/gi, '').replace(/url\(\s*(?!['"]?data:)[^)]*\)/gi, 'none');
  safe = safe.replace(/<\/style/gi, '');
  // Already scoped by its author (the built-in skins are). Minifiers drop the quotes, so accept
  // [data-skin="id"], [data-skin='id'] and [data-skin=id] alike.
  if (new RegExp(`\\[data-skin=(["']?)${id}\\1\\]`).test(safe)) return safe;
  const { hoisted, rest } = splitAtRules(safe);
  return `${hoisted}.lp-root[data-skin="${id}"] {\n${rest}\n}`;
}

export function validateSkin(input: unknown): SkinManifest {
  const m = input as SkinManifest;
  if (!m || typeof m !== 'object') throw new Error('Skin package must be a JSON object');
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(m.id))
    throw new Error('Skin "id" must be a short slug (letters, digits, - _)');
  if (typeof m.name !== 'string' || !m.name) throw new Error('Skin "name" is required');
  if (!m.layout || typeof m.layout !== 'object') throw new Error('Skin "layout" is required');
  const layout: SkinManifest['layout'] = {};
  for (const region of ['top', 'center', 'bottom'] as const) {
    const rows = (m.layout as any)[region];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) throw new Error(`layout.${region} must be an array of rows`);
    layout[region] = rows.map((row: unknown) => {
      if (!Array.isArray(row)) throw new Error(`layout.${region} rows must be arrays of controls`);
      return row.map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof (item as any).control === 'string') return item as LayoutItem;
        throw new Error(`layout.${region}: every item must be a control name or { "control": … }`);
      });
    });
  }
  const tokens: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.tokens ?? {})) {
    if (/^--[a-z0-9-]+$/i.test(k) && typeof v === 'string' && !/[{};]|url\s*\(/i.test(v)) tokens[k] = v;
  }
  const icons: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.icons ?? {})) {
    if (typeof v === 'string') icons[k] = sanitizeIcon(v);
  }
  return {
    id: m.id,
    name: m.name,
    version: typeof m.version === 'string' ? m.version : undefined,
    author: typeof m.author === 'string' ? m.author : undefined,
    description: typeof m.description === 'string' ? m.description : undefined,
    tokens,
    layout,
    icons,
    css: typeof m.css === 'string' ? m.css : undefined,
    stylesheet: typeof m.stylesheet === 'string' ? m.stylesheet : undefined,
    osd: m.osd && typeof m.osd === 'object' ? { position: m.osd.position } : undefined,
    autohide: typeof m.autohide === 'number' ? Math.max(0, m.autohide) : 2500,
    dock: !!m.dock,
    seekbar: m.seekbar && typeof m.seekbar === 'object' ? { thumbnails: m.seekbar.thumbnails !== false } : undefined,
  };
}

export class SkinEngine {
  private skins = new Map<string, SkinManifest>();
  private style: HTMLStyleElement;
  private overrides = new Map<string, Record<string, string>>();
  private applied: string[] = [];
  current: SkinManifest | null = null;
  /** Called after a skin has been applied so the UI can rebuild its layout. */
  onApply: (skin: SkinManifest) => void = () => {};

  constructor(private root: HTMLElement) {
    this.style = document.createElement('style');
    this.style.dataset.lumenSkin = '';
    document.head.appendChild(this.style);
  }

  register(manifest: unknown): SkinManifest {
    const skin = validateSkin(manifest);
    this.skins.set(skin.id, skin);
    return skin;
  }

  has(id: string): boolean {
    return this.skins.has(id);
  }

  list(): SkinManifest[] {
    return [...this.skins.values()];
  }

  /** Load a skin package from a URL (manifest JSON; an optional `stylesheet` is fetched relative to it). */
  async load(url: string): Promise<SkinManifest> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Skin ${url}: HTTP ${res.status}`);
    const json = await res.json();
    if (typeof json.stylesheet === 'string' && !json.css) {
      const cssUrl = new URL(json.stylesheet, new URL(url, location.href)).href;
      const cssRes = await fetch(cssUrl);
      if (cssRes.ok) json.css = await cssRes.text();
    }
    return this.register(json);
  }

  apply(id: string): SkinManifest {
    const skin = this.skins.get(id);
    if (!skin) throw new Error(`Unknown skin "${id}"`);
    for (const name of this.applied) this.root.style.removeProperty(name);
    this.applied = [];
    const tokens = { ...skin.tokens, ...this.overrides.get(id) };
    for (const [k, v] of Object.entries(tokens)) {
      this.root.style.setProperty(k, v);
      this.applied.push(k);
    }
    this.style.textContent = skin.css ? scopeCss(skin.id, skin.css) : '';
    this.root.dataset.skin = skin.id;
    if (skin.dock) this.root.dataset.dock = '';
    else delete this.root.dataset.dock;
    this.current = skin;
    this.onApply(skin);
    return skin;
  }

  /** Effective tokens of the current skin (manifest values + live overrides). */
  tokens(): Record<string, string> {
    if (!this.current) return {};
    return { ...this.current.tokens, ...this.overrides.get(this.current.id) };
  }

  /** Live-edit a token of the current skin. */
  setToken(name: string, value: string): void {
    if (!this.current || !/^--[a-z0-9-]+$/i.test(name) || /[{};]|url\s*\(/i.test(value)) return;
    const o = this.overrides.get(this.current.id) ?? {};
    o[name] = value;
    this.overrides.set(this.current.id, o);
    this.root.style.setProperty(name, value);
    if (!this.applied.includes(name)) this.applied.push(name);
  }

  resetTokens(): void {
    if (!this.current) return;
    this.overrides.delete(this.current.id);
    this.apply(this.current.id);
  }

  getOverrides(id: string): Record<string, string> {
    return { ...this.overrides.get(id) };
  }

  setOverrides(id: string, values: Record<string, string>): void {
    this.overrides.set(id, { ...values });
  }

  /** The current skin with live token edits baked in, ready to save as a package. */
  export(): string {
    if (!this.current) return '{}';
    return JSON.stringify({ ...this.current, tokens: this.tokens() }, null, 2);
  }

  destroy(): void {
    this.style.remove();
    for (const name of this.applied) this.root.style.removeProperty(name);
    delete this.root.dataset.skin;
    delete this.root.dataset.dock;
  }
}
