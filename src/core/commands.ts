/**
 * mpv-flavoured command bus + property system.
 *
 * Everything the UI (or a plugin, or a keybinding) can do goes through `run()`, e.g.
 *   run('seek 5')            run('cycle pause')         run('add sub-delay -0.1')
 *   run('multiply speed 1.1')  run('cycle-values scale bilinear bicubic lanczos fsr')
 * so the core never has to know who is driving it.
 */

export type PropType = 'number' | 'bool' | 'string' | 'choice';

export interface PropertyDef {
  type: PropType;
  get: () => any;
  set?: (value: any) => void;
  min?: number;
  max?: number;
  step?: number;
  choices?: () => any[];
  /** OSD formatter; return null to stay quiet. */
  osd?: (value: any) => string | null;
}

export type CommandHandler = (args: string[]) => void | Promise<void>;

export function tokenize(line: string): string[][] {
  // Splits on whitespace, honours "double" and 'single' quotes, and `;` as a command separator.
  const commands: string[][] = [];
  let cur: string[] = [];
  let tok = '';
  let quote: string | null = null;
  let has = false;
  const pushTok = () => {
    if (has) cur.push(tok);
    tok = '';
    has = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && i + 1 < line.length) {
        tok += line[++i];
      } else if (c === quote) {
        quote = null;
      } else tok += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === ';') {
      pushTok();
      if (cur.length) commands.push(cur);
      cur = [];
    } else if (c === ' ' || c === '\t') {
      pushTok();
    } else {
      tok += c;
      has = true;
    }
  }
  pushTok();
  if (cur.length) commands.push(cur);
  return commands;
}

function parseBool(v: string): boolean {
  return v === 'yes' || v === 'true' || v === '1' || v === 'on';
}

/** Accepts "1.1", "1/1.1", "-0.5", "+2". */
function parseNumber(v: string): number {
  if (v.includes('/')) {
    const [a, b] = v.split('/');
    return Number(a) / Number(b);
  }
  return Number(v);
}

export class CommandBus {
  private commands = new Map<string, CommandHandler>();
  private props = new Map<string, PropertyDef>();
  /** Called with a human-readable message whenever a property changes through a command. */
  onOsd: (text: string) => void = () => {};
  onError: (message: string) => void = (m) => console.warn('[lumen] command:', m);

  constructor() {
    this.register('set', ([name, value]) => this.setProp(name, value, true));
    this.register('add', ([name, delta = '1']) => {
      const def = this.requireProp(name);
      if (def.type === 'bool' || def.type === 'choice') return this.cycle(name, parseNumber(delta) < 0 ? -1 : 1);
      this.setProp(name, String(Number(def.get()) + parseNumber(delta)), true);
    });
    this.register('multiply', ([name, factor]) => {
      const def = this.requireProp(name);
      this.setProp(name, String(Number(def.get()) * parseNumber(factor)), true);
    });
    this.register('cycle', ([name, dir]) => this.cycle(name, dir === 'down' ? -1 : 1));
    this.register('toggle', ([name]) => this.cycle(name, 1));
    this.register('cycle-values', ([name, ...values]) => {
      const def = this.requireProp(name);
      if (!values.length) return;
      const cur = String(this.format(def, def.get()));
      const idx = values.findIndex((v) => v === cur || (def.type === 'number' && Number(v) === Number(cur)));
      this.setProp(name, values[(idx + 1) % values.length], true);
    });
    this.register('ignore', () => {});
  }

  register(name: string, handler: CommandHandler): () => void {
    this.commands.set(name, handler);
    return () => {
      if (this.commands.get(name) === handler) this.commands.delete(name);
    };
  }

  defineProperty(name: string, def: PropertyDef): void {
    this.props.set(name, def);
  }

  hasCommand(name: string): boolean {
    return this.commands.has(name);
  }

  listCommands(): string[] {
    return [...this.commands.keys()].sort();
  }

  listProperties(): string[] {
    return [...this.props.keys()].sort();
  }

  getProp(name: string): any {
    return this.requireProp(name).get();
  }

  private requireProp(name: string): PropertyDef {
    const def = this.props.get(name);
    if (!def) throw new Error(`unknown property "${name}"`);
    return def;
  }

  private format(def: PropertyDef, value: any): string {
    if (def.type === 'bool') return value ? 'yes' : 'no';
    return String(value);
  }

  setProp(name: string, raw: any, osd = false): void {
    const def = this.requireProp(name);
    if (!def.set) throw new Error(`property "${name}" is read-only`);
    let value: any = raw;
    if (def.type === 'number') {
      value = typeof raw === 'number' ? raw : parseNumber(String(raw));
      if (!Number.isFinite(value)) throw new Error(`"${raw}" is not a number`);
      if (def.min !== undefined) value = Math.max(def.min, value);
      if (def.max !== undefined) value = Math.min(def.max, value);
      value = Math.round(value * 1e6) / 1e6;
    } else if (def.type === 'bool') {
      value = typeof raw === 'boolean' ? raw : parseBool(String(raw));
    } else if (def.type === 'choice') {
      const choices = def.choices?.() ?? [];
      const hit = choices.find((c) => String(c) === String(raw));
      if (hit === undefined) throw new Error(`"${raw}" is not valid for ${name} (${choices.join(', ')})`);
      value = hit;
    }
    def.set(value);
    if (osd) {
      const text = def.osd ? def.osd(def.get()) : `${name}: ${this.format(def, def.get())}`;
      if (text) this.onOsd(text);
    }
  }

  private cycle(name: string, dir: number): void {
    const def = this.requireProp(name);
    if (def.type === 'bool') return this.setProp(name, !def.get(), true);
    if (def.type === 'choice') {
      const choices = def.choices?.() ?? [];
      if (!choices.length) return;
      const idx = choices.findIndex((c) => String(c) === String(def.get()));
      const next = choices[(idx + dir + choices.length) % choices.length];
      return this.setProp(name, next, true);
    }
    if (def.type === 'number') return this.setProp(name, Number(def.get()) + dir * (def.step ?? 1), true);
  }

  /** Run one or more `;`-separated commands. Accepts a string or a pre-split argv. */
  run(input: string | Array<string | number>): void {
    const list = typeof input === 'string' ? tokenize(input) : [input.map(String)];
    for (const argv of list) {
      const [name, ...args] = argv;
      const handler = this.commands.get(name);
      if (!handler) {
        this.onError(`unknown command "${name}"`);
        continue;
      }
      try {
        const r = handler(args);
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch((err) => this.onError(`${name}: ${err?.message ?? err}`));
        }
      } catch (err: any) {
        this.onError(`${name}: ${err?.message ?? err}`);
      }
    }
  }
}
