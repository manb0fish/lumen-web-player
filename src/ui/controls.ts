import type { Player } from '../core/player';
import { clamp, formatTime, type PlayerState } from '../core/types';
import { openMenu, type MenuItem } from './menu';
import type { SkinManifest } from './skin';

/** Everything a control factory may touch. */
export interface ControlContext {
  player: Player;
  root: HTMLElement;
  skin: SkinManifest;
  /** SVG markup for an icon name, honouring the skin's overrides. */
  icon(name: string): string;
  /** Run `fn` when this control is torn down (skin switch / destroy). */
  cleanup(fn: () => void): void;
  /** Run `fn` on every animation frame while the control exists. */
  frame(fn: () => void): void;
  /** Subscribe to store keys; called immediately. Auto-unsubscribed on teardown. */
  watch<K extends keyof PlayerState>(keys: K[], fn: (s: Readonly<PlayerState>) => void): void;
  ui: {
    skins(): SkinManifest[];
    setSkin(id: string): void;
    toggleInspector(tab?: string): void;
    openFile(): void;
    openSubtitle(): void;
  };
}

export type ControlFactory = (ctx: ControlContext, cfg: Record<string, any>) => HTMLElement;

const registry = new Map<string, ControlFactory>();

/** Register a control so skins can place it by name. Plugins use this to add their own widgets. */
export function registerControl(name: string, factory: ControlFactory): void {
  registry.set(name, factory);
}

export function getControl(name: string): ControlFactory | undefined {
  return registry.get(name);
}

export function listControls(): string[] {
  return [...registry.keys()].sort();
}

// ---- helpers -----------------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface ButtonOptions {
  icon?: string;
  label?: string;
  title: string;
  onClick: (b: HTMLButtonElement) => void;
  className?: string;
}

function button(ctx: ControlContext, o: ButtonOptions): HTMLButtonElement {
  const b = el('button', `lp-btn ${o.className ?? ''}`.trim());
  b.type = 'button';
  b.title = o.title;
  b.setAttribute('aria-label', o.title);
  setButtonFace(ctx, b, o.icon, o.label);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    o.onClick(b);
    // Keep keyboard shortcuts working after clicking a control.
    ctx.root.focus({ preventScroll: true });
  });
  return b;
}

function setButtonFace(ctx: ControlContext, b: HTMLButtonElement, icon?: string, label?: string): void {
  let html = icon ? ctx.icon(icon) : '';
  if (label !== undefined && label !== '') html += `<span class="lp-btn-label"></span>`;
  b.innerHTML = html;
  if (label !== undefined && label !== '') (b.lastElementChild as HTMLElement).textContent = label;
  if (icon) b.dataset.icon = icon;
}

const run = (ctx: ControlContext, cmd: string) => ctx.player.command(cmd);

/** A button bound to a command, optionally lit while a boolean property is true. */
function commandButton(
  ctx: ControlContext,
  cfg: Record<string, any>,
  d: { icon?: string; title: string; command: string; active?: string; label?: string },
): HTMLButtonElement {
  const title = cfg.title ?? d.title;
  // A skin-supplied label turns the control into a text button (unless it also names an icon).
  const text = cfg.label ?? (cfg.text === true ? title : d.label);
  const b = button(ctx, {
    icon: cfg.label !== undefined || cfg.text === true ? cfg.icon : (cfg.icon ?? d.icon),
    label: text,
    title,
    className: cfg.class,
    onClick: () => run(ctx, cfg.command ?? d.command),
  });
  const prop = cfg.active ?? d.active;
  if (prop) {
    const refresh = () => {
      let on = false;
      try {
        const v = ctx.player.commands.getProp(prop);
        on = cfg.activeValue !== undefined ? String(v) === String(cfg.activeValue) : v === true || (typeof v === 'number' && v > 0);
      } catch {
        on = false;
      }
      b.dataset.active = String(on);
    };
    const off = ctx.player.store.subscribe(refresh);
    ctx.cleanup(off);
    refresh();
  }
  return b;
}

function template(format: string, s: { current: number; duration: number }): string {
  const pct = s.duration ? (s.current / s.duration) * 100 : 0;
  return format
    .replace('{current}', formatTime(s.current))
    .replace('{current.ms}', formatTime(s.current, true))
    .replace('{duration}', formatTime(s.duration))
    .replace('{remaining}', '-' + formatTime(Math.max(0, s.duration - s.current)))
    .replace('{percent}', pct.toFixed(0));
}

// ---- transport ---------------------------------------------------------------------------------

registerControl('play', (ctx, cfg) => {
  const b = button(ctx, {
    title: 'Play / Pause (Space)',
    className: `lp-btn-play ${cfg.class ?? ''}`,
    onClick: () => ctx.player.togglePause(),
  });
  ctx.watch(['paused', 'ended', 'status'], (s) => {
    const icon = s.ended ? 'replay' : s.paused ? 'play' : 'pause';
    if (b.dataset.icon !== icon) setButtonFace(ctx, b, icon, cfg.text ? (s.paused || s.ended ? 'PLAY' : 'PAUSE') : undefined);
    b.dataset.state = s.paused || s.ended ? 'paused' : 'playing';
  });
  return b;
});

registerControl('big-play', (ctx, cfg) => {
  const b = button(ctx, {
    icon: 'play',
    title: 'Play / Pause',
    className: `lp-big-play ${cfg.class ?? ''}`,
    onClick: () => ctx.player.togglePause(),
  });
  ctx.watch(['paused', 'ended', 'status'], (s) => {
    // Shown while paused. With touch input the stylesheet also shows it while playing (as a pause
    // button), because a tap on the picture brings up the controls instead of pausing.
    const ready = s.status !== 'idle' && s.status !== 'loading' && s.status !== 'error';
    b.dataset.state = !ready ? 'off' : s.paused || s.ended ? 'paused' : 'playing';
    const icon = s.ended ? 'replay' : s.paused ? 'play' : 'pause';
    if (b.dataset.icon !== icon) setButtonFace(ctx, b, icon);
  });
  return b;
});

registerControl('stop', (ctx, cfg) => commandButton(ctx, cfg, { icon: 'stop', title: 'Stop', command: 'set pause yes ; seek 0 absolute' }));
registerControl('prev-frame', (ctx, cfg) =>
  commandButton(ctx, cfg, { icon: 'prev-frame', title: 'Previous frame (,)', command: 'frame-back-step' }),
);
registerControl('next-frame', (ctx, cfg) =>
  commandButton(ctx, cfg, { icon: 'next-frame', title: 'Next frame (.)', command: 'frame-step' }),
);
registerControl('rewind', (ctx, cfg) => commandButton(ctx, cfg, { icon: 'rewind', title: 'Back 10 s', command: 'seek -10' }));
registerControl('forward', (ctx, cfg) => commandButton(ctx, cfg, { icon: 'forward', title: 'Forward 10 s', command: 'seek 10' }));
registerControl('loop', (ctx, cfg) =>
  commandButton(ctx, cfg, { icon: 'loop', title: 'Loop file (L)', command: 'cycle loop-file', active: 'loop-file' }),
);
registerControl('abloop', (ctx, cfg) => {
  const b = commandButton(ctx, cfg, { icon: 'abloop', title: 'A-B loop (l)', command: 'ab-loop' });
  ctx.watch(['abLoopA', 'abLoopB'], (s) => (b.dataset.active = String(s.abLoopA !== null)));
  return b;
});
registerControl('screenshot', (ctx, cfg) =>
  commandButton(ctx, cfg, { icon: 'screenshot', title: 'Screenshot (s)', command: 'screenshot' }),
);
registerControl('stats', (ctx, cfg) =>
  commandButton(ctx, cfg, { icon: 'stats', title: 'Stats for nerds (i)', command: 'cycle stats', active: 'stats' }),
);
registerControl('deband', (ctx, cfg) =>
  commandButton(ctx, cfg, { title: 'Deband (b)', label: 'DEBAND', command: 'cycle deband', active: 'deband' }),
);
registerControl('normalize', (ctx, cfg) =>
  commandButton(ctx, cfg, { title: 'Gain normalization (n)', label: 'NORM', command: 'cycle audio-normalize', active: 'audio-normalize' }),
);
registerControl('sub-toggle', (ctx, cfg) =>
  commandButton(ctx, cfg, { title: 'Subtitle visibility (v)', label: 'SUB', command: 'cycle sub-visibility', active: 'sub-visibility' }),
);

/** Generic command button for skins: { control: "button", command, icon?, label?, title?, active? }. */
registerControl('button', (ctx, cfg) =>
  commandButton(ctx, cfg, {
    title: cfg.title ?? cfg.command ?? 'button',
    command: cfg.command ?? 'ignore',
    icon: cfg.icon,
    label: cfg.label,
    active: cfg.active,
  }),
);

registerControl('fullscreen', (ctx, cfg) => {
  const b = button(ctx, { title: 'Fullscreen (f)', className: cfg.class, onClick: () => run(ctx, 'cycle fullscreen') });
  ctx.watch(['fullscreen'], (s) =>
    setButtonFace(ctx, b, cfg.text ? undefined : s.fullscreen ? 'fullscreen-exit' : 'fullscreen', cfg.text ? 'FS' : undefined),
  );
  return b;
});

registerControl('open', (ctx, cfg) =>
  button(ctx, {
    icon: cfg.text ? undefined : 'open',
    label: cfg.text ? 'OPEN' : cfg.label,
    title: 'Open file…',
    className: cfg.class,
    onClick: () => ctx.ui.openFile(),
  }),
);

// ---- layout atoms ------------------------------------------------------------------------------

registerControl('spacer', () => el('div', 'lp-spacer'));
registerControl('separator', () => el('div', 'lp-separator'));
registerControl('text', (_ctx, cfg) => el('span', `lp-text ${cfg.class ?? ''}`.trim(), String(cfg.text ?? '')));

registerControl('title', (ctx, cfg) => {
  const t = el('div', `lp-title ${cfg.class ?? ''}`.trim());
  ctx.watch(['title'], (s) => (t.textContent = s.title || 'Lumen'));
  return t;
});

registerControl('tier-badge', (ctx, cfg) => {
  const b = el('span', `lp-badge ${cfg.class ?? ''}`.trim());
  ctx.watch(['tier', 'mode', 'renderer'], (s) => {
    b.textContent = s.tier ? `${s.tier} · ${s.renderer ?? '—'}` : 'idle';
    b.title = s.mode ? `decode: ${s.mode}\nrender: ${s.renderer}` : '';
  });
  return b;
});

// ---- time --------------------------------------------------------------------------------------

registerControl('time', (ctx, cfg) => {
  const t = el('div', `lp-time ${cfg.class ?? ''}`.trim());
  let remaining = false;
  let last = '';
  if (cfg.format) {
    ctx.frame(() => {
      const format = (ctx.root.dataset.size === 'compact' && cfg.compactFormat) || cfg.format;
      const text = template(format, { current: ctx.player.currentTime, duration: ctx.player.duration });
      if (text !== last) t.textContent = last = text;
    });
    return t;
  }
  const cur = el('span', 'lp-time-current');
  const sep = el('span', 'lp-time-sep', ' / ');
  const dur = el('span', 'lp-time-duration');
  t.append(cur, sep, dur);
  t.title = 'Click to toggle remaining time';
  t.addEventListener('click', () => (remaining = !remaining));
  ctx.frame(() => {
    const c = ctx.player.currentTime;
    const d = ctx.player.duration;
    const text = remaining ? '-' + formatTime(Math.max(0, d - c)) : formatTime(c);
    if (text !== last) cur.textContent = last = text;
  });
  ctx.watch(['duration'], (s) => (dur.textContent = formatTime(s.duration)));
  return t;
});

/** mpv-terminal style status line: "AV: 00:00:05 / 00:01:00 (8%) A-V: 0.004 Dropped: 0". */
registerControl('status-line', (ctx, cfg) => {
  const t = el('div', `lp-status-line ${cfg.class ?? ''}`.trim());
  let last = '';
  let n = 0;
  ctx.frame(() => {
    if (n++ % 6) return;
    const p = ctx.player;
    const s = p.store.state;
    const st = p.getStats().pipeline;
    const c = p.currentTime;
    const d = p.duration;
    const kind = s.mediaInfo ? (s.mediaInfo.video ? (s.mediaInfo.audio ? 'AV' : 'V') : 'A') : '--';
    const flag = s.status === 'buffering' ? '(Buffering) ' : s.paused ? '(Paused) ' : '';
    const speed = s.speed !== 1 ? ` x${s.speed.toFixed(2)}` : '';
    const text = `${flag}${kind}: ${formatTime(c)} / ${formatTime(d)} (${d ? ((c / d) * 100).toFixed(0) : 0}%)${speed} A-V: ${((st?.driftMs ?? 0) / 1000).toFixed(3)} Dropped: ${st?.dropped ?? 0}`;
    if (text !== last) t.textContent = last = text;
  });
  return t;
});

/** Studio-deck timecode display. */
registerControl('lcd', (ctx, cfg) => {
  const box = el('div', `lp-lcd ${cfg.class ?? ''}`.trim());
  const main = el('div', 'lp-lcd-time', '00:00.000');
  const sub = el('div', 'lp-lcd-sub');
  const a = el('span', 'lp-lcd-cell');
  const b = el('span', 'lp-lcd-cell');
  const c = el('span', 'lp-lcd-cell');
  sub.append(a, b, c);
  box.append(main, sub);
  let last = '';
  ctx.frame(() => {
    const text = formatTime(ctx.player.currentTime, true);
    if (text !== last) main.textContent = last = text;
  });
  ctx.watch(['duration', 'tier', 'renderer', 'speed', 'status'], (s) => {
    a.textContent = `DUR ${formatTime(s.duration)}`;
    b.textContent = `${(s.tier ?? '---').toUpperCase()}·${(s.renderer ?? '---').toUpperCase()}`;
    c.textContent = `${s.speed.toFixed(2)}x`;
    box.dataset.status = s.status;
  });
  return box;
});

// ---- seek bar ----------------------------------------------------------------------------------

registerControl('seekbar', (ctx, cfg) => {
  const p = ctx.player;
  const bar = el('div', `lp-seekbar ${cfg.class ?? ''}`.trim());
  bar.tabIndex = 0;
  bar.setAttribute('role', 'slider');
  bar.setAttribute('aria-label', 'Seek');
  const track = el('div', 'lp-seek-track');
  const buffer = el('div', 'lp-seek-buffer');
  const ab = el('div', 'lp-seek-ab');
  const fill = el('div', 'lp-seek-fill');
  const thumb = el('div', 'lp-seek-thumb');
  track.append(buffer, ab, fill, thumb);
  const tip = el('div', 'lp-seek-tip');
  const thumbCanvas = el('canvas', 'lp-seek-thumbnail');
  thumbCanvas.width = 160;
  thumbCanvas.height = 90;
  const tipTime = el('span', 'lp-seek-tip-time', '00:00');
  tip.append(thumbCanvas, tipTime);
  bar.append(track, tip);

  const wantThumbs = ctx.skin.seekbar?.thumbnails !== false && cfg.thumbnails !== false;
  let dragging = false;
  let dragTime = 0;
  let lastScrub = 0;
  let thumbToken = 0;
  let thumbTimer = 0;

  const timeAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * p.duration;
  };
  const showTip = (clientX: number) => {
    const r = bar.getBoundingClientRect();
    const t = timeAt(clientX);
    tip.style.left = `${clamp(clientX - r.left, 40, Math.max(40, r.width - 40))}px`;
    tipTime.textContent = formatTime(t, p.duration < 60);
    bar.dataset.hover = '';
    if (!wantThumbs || !p.store.state.mediaInfo?.video) return;
    const token = ++thumbToken;
    clearTimeout(thumbTimer);
    thumbTimer = window.setTimeout(() => {
      p.thumbnail(t, 160).then(({ bitmap }) => {
        if (!bitmap) return;
        if (token === thumbToken) {
          const c2 = thumbCanvas.getContext('2d')!;
          const h = Math.round((160 * bitmap.height) / bitmap.width);
          if (thumbCanvas.height !== h) {
            thumbCanvas.height = h;
            thumbCanvas.style.height = `${h}px`;
          }
          c2.drawImage(bitmap, 0, 0, 160, h);
          tip.dataset.thumb = '';
        }
        bitmap.close();
      });
    }, 60);
  };

  bar.addEventListener('pointermove', (e) => {
    showTip(e.clientX);
    if (!dragging) return;
    dragTime = timeAt(e.clientX);
    const now = performance.now();
    if (now - lastScrub > 110) {
      lastScrub = now;
      p.seek(dragTime, false); // key-frame scrubbing while dragging
    }
  });
  bar.addEventListener('pointerleave', () => {
    if (!dragging) delete bar.dataset.hover;
  });
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !p.duration) return;
    dragging = true;
    bar.dataset.dragging = '';
    bar.setPointerCapture(e.pointerId);
    dragTime = timeAt(e.clientX);
    lastScrub = performance.now();
    showTip(e.clientX);
    p.seek(dragTime, false);
    e.stopPropagation();
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    delete bar.dataset.dragging;
    delete bar.dataset.hover;
    try {
      bar.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    p.seek(timeAt(e.clientX), true); // settle on the exact frame
    ctx.root.focus({ preventScroll: true });
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', (e) => e.stopPropagation());
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      run(ctx, `seek ${e.key === 'ArrowLeft' ? -5 : 5}`);
    }
  });

  ctx.frame(() => {
    const d = p.duration;
    const t = dragging ? dragTime : p.currentTime;
    const f = d ? clamp(t / d, 0, 1) : 0;
    fill.style.width = `${f * 100}%`;
    thumb.style.left = `${f * 100}%`;
    const ahead = p.store.state.bufferAhead;
    buffer.style.width = `${d ? clamp((t + ahead) / d, 0, 1) * 100 : 0}%`;
  });
  ctx.watch(['abLoopA', 'abLoopB', 'duration', 'currentTime'], (s) => {
    bar.setAttribute('aria-valuemax', String(Math.round(s.duration)));
    bar.setAttribute('aria-valuenow', String(Math.round(s.currentTime)));
    bar.setAttribute('aria-valuetext', `${formatTime(s.currentTime)} of ${formatTime(s.duration)}`);
    if (s.abLoopA === null || !s.duration) {
      ab.style.display = 'none';
      return;
    }
    const a = s.abLoopA / s.duration;
    const b = (s.abLoopB ?? s.abLoopA) / s.duration;
    ab.style.display = 'block';
    ab.style.left = `${a * 100}%`;
    ab.style.width = `${Math.max(0.4, (b - a) * 100)}%`;
  });
  ctx.cleanup(() => clearTimeout(thumbTimer));
  return bar;
});

// ---- volume ------------------------------------------------------------------------------------

registerControl('mute', (ctx, cfg) => {
  const b = button(ctx, { title: 'Mute (m)', className: cfg.class, onClick: () => run(ctx, 'cycle mute') });
  ctx.watch(['muted', 'volume'], (s) => {
    const icon = s.muted || s.volume === 0 ? 'mute' : s.volume < 45 ? 'volume-low' : 'volume';
    setButtonFace(ctx, b, cfg.text ? undefined : icon, cfg.text ? (s.muted ? 'MUTED' : 'VOL') : undefined);
    b.dataset.active = String(s.muted);
  });
  return b;
});

registerControl('volume', (ctx, cfg) => {
  const input = el('input', `lp-range lp-volume ${cfg.class ?? ''}`.trim());
  input.type = 'range';
  input.min = '0';
  input.max = '130';
  input.step = '1';
  input.title = 'Volume (9 / 0)';
  input.setAttribute('aria-label', 'Volume');
  input.addEventListener('input', () => {
    ctx.player.setVolume(Number(input.value));
    if (ctx.player.store.state.muted) ctx.player.setMuted(false);
  });
  input.addEventListener('keydown', (e) => e.stopPropagation());
  input.addEventListener('pointerup', () => ctx.root.focus({ preventScroll: true }));
  ctx.watch(['volume', 'muted'], (s) => {
    input.value = String(s.muted ? 0 : s.volume);
    input.style.setProperty('--lp-range-fill', `${((s.muted ? 0 : s.volume) / 130) * 100}%`);
  });
  return input;
});

// ---- menus -------------------------------------------------------------------------------------

function menuButton(
  ctx: ControlContext,
  cfg: Record<string, any>,
  d: { icon: string; title: string; label?: string },
  build: () => MenuItem[],
): HTMLButtonElement {
  return button(ctx, {
    icon: cfg.text ? undefined : (cfg.icon ?? d.icon),
    label: cfg.text ? (cfg.label ?? d.label ?? d.title.toUpperCase()) : cfg.label,
    title: d.title,
    className: cfg.class,
    onClick: (b) => openMenu(ctx.root, b, build),
  });
}

function speedItems(ctx: ControlContext): MenuItem[] {
  const cur = ctx.player.store.state.speed;
  const items: MenuItem[] = [{ type: 'header', label: 'Speed  ·  [ and ] to nudge' }];
  for (const v of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]) {
    items.push({ label: `${v}×`, checked: Math.abs(cur - v) < 0.005, onSelect: () => run(ctx, `set speed ${v}`) });
  }
  items.push({ type: 'separator' });
  items.push({
    label: 'Preserve pitch',
    checked: ctx.player.store.state.pitchCorrection,
    keepOpen: true,
    onSelect: () => run(ctx, 'cycle audio-pitch-correction'),
  });
  return items;
}

registerControl('speed', (ctx, cfg) => {
  const b = menuButton(ctx, cfg, { icon: 'speed', title: 'Playback speed', label: 'SPEED' }, () => speedItems(ctx));
  if (cfg.showValue) {
    ctx.watch(['speed'], (s) => setButtonFace(ctx, b, undefined, `${s.speed.toFixed(2)}×`));
  }
  return b;
});

registerControl('subtitles', (ctx, cfg) => {
  const b = menuButton(ctx, cfg, { icon: 'subtitles', title: 'Subtitles', label: 'SUBS' }, () => {
    const s = ctx.player.store.state;
    const items: MenuItem[] = [{ type: 'header', label: 'Subtitles' }];
    items.push({ label: 'Off', checked: s.subTrack < 0, onSelect: () => run(ctx, 'set sid no') });
    for (const t of s.subTracks) {
      items.push({
        label: t.label,
        hint: t.codec.toUpperCase(),
        checked: t.id === s.subTrack,
        onSelect: () => run(ctx, `set sid ${t.id}`),
      });
    }
    items.push({ type: 'separator' });
    items.push({ label: 'Load subtitle file…', onSelect: () => ctx.ui.openSubtitle() });
    items.push({ label: 'Visible', checked: s.subVisible, keepOpen: true, onSelect: () => run(ctx, 'cycle sub-visibility') });
    items.push({ label: 'Delay −100 ms', hint: 'z', keepOpen: true, onSelect: () => run(ctx, 'add sub-delay -0.1') });
    items.push({ label: 'Delay +100 ms', hint: 'x', keepOpen: true, onSelect: () => run(ctx, 'add sub-delay 0.1') });
    items.push({ label: `Reset delay (${Math.round(s.subDelay * 1000)} ms)`, onSelect: () => run(ctx, 'set sub-delay 0') });
    return items;
  });
  ctx.watch(['subTrack', 'subVisible'], (s) => (b.dataset.active = String(s.subTrack >= 0 && s.subVisible)));
  return b;
});

function audioItems(ctx: ControlContext): MenuItem[] {
  const s = ctx.player.store.state;
  const items: MenuItem[] = [{ type: 'header', label: 'Audio track' }];
  const tracks = s.mediaInfo?.audioTracks ?? [];
  if (!tracks.length) items.push({ label: 'No audio', checked: true });
  for (const t of tracks) {
    items.push({
      label: `#${t.index + 1} ${t.name ?? t.language}`,
      hint: `${t.codec} ${t.channels}ch`,
      checked: t.index === s.audioTrack,
      onSelect: () => run(ctx, `set aid ${t.index}`),
    });
  }
  items.push({ type: 'separator' });
  items.push({
    label: 'Gain normalization',
    hint: 'n',
    checked: s.normalize,
    keepOpen: true,
    onSelect: () => run(ctx, 'cycle audio-normalize'),
  });
  items.push({
    label: 'Preserve pitch when changing speed',
    checked: s.pitchCorrection,
    keepOpen: true,
    onSelect: () => run(ctx, 'cycle audio-pitch-correction'),
  });
  return items;
}

registerControl('audio', (ctx, cfg) => menuButton(ctx, cfg, { icon: 'audio', title: 'Audio', label: 'AUDIO' }, () => audioItems(ctx)));

function videoItems(ctx: ControlContext): MenuItem[] {
  const s = ctx.player.store.state;
  const items: MenuItem[] = [{ type: 'header', label: 'Renderer  ·  r' }];
  for (const r of ['webgpu', 'webgl2', 'canvas2d'] as const) {
    items.push({
      label: r === 'webgpu' ? 'WebGPU' : r === 'webgl2' ? 'WebGL 2' : 'Canvas 2D',
      checked: s.renderer === r,
      onSelect: () => run(ctx, `set renderer ${r}`),
    });
  }
  items.push({ type: 'header', label: 'Scaler  ·  u' });
  for (const [v, label] of [
    ['bilinear', 'Bilinear'],
    ['bicubic', 'Bicubic (Catmull-Rom)'],
    ['lanczos', 'Lanczos 3'],
    ['fsr', 'FSR / EASU'],
  ]) {
    items.push({ label, checked: s.scaler === v, keepOpen: true, onSelect: () => run(ctx, `set scale ${v}`) });
  }
  items.push({ type: 'header', label: 'Post-processing' });
  items.push({ label: 'Deband', hint: 'b', checked: s.deband, keepOpen: true, onSelect: () => run(ctx, 'cycle deband') });
  items.push({
    label: `Sharpen (RCAS): ${s.sharpen.toFixed(2)}`,
    hint: 'Ctrl+s',
    checked: s.sharpen > 0,
    keepOpen: true,
    onSelect: () => run(ctx, 'cycle-values sharpen 0 0.35 0.7 1'),
  });
  items.push({ label: 'Dither', checked: s.dither, keepOpen: true, onSelect: () => run(ctx, 'cycle dither') });
  items.push({
    label: 'Scale in linear light',
    hint: 'g',
    checked: s.linearScaling,
    keepOpen: true,
    onSelect: () => run(ctx, 'cycle linear-scaling'),
  });
  items.push({ type: 'header', label: 'HDR tone mapping  ·  t' });
  for (const v of ['bt2390', 'hable', 'reinhard', 'clip']) {
    items.push({
      label: v === 'bt2390' ? 'BT.2390' : v[0].toUpperCase() + v.slice(1),
      checked: s.toneMapping === v,
      keepOpen: true,
      onSelect: () => run(ctx, `set tone-mapping ${v}`),
    });
  }
  items.push({ type: 'header', label: 'Wide gamut to display' });
  for (const [v, label] of [
    ['soft', 'Compress saturation (keeps hue)'],
    ['clip', 'Clip'],
  ]) {
    items.push({
      label,
      checked: s.gamutMapping === v,
      keepOpen: true,
      onSelect: () => run(ctx, `set gamut-mapping ${v}`),
    });
  }
  return items;
}

registerControl('video', (ctx, cfg) =>
  menuButton(ctx, cfg, { icon: 'video', title: 'Video & shaders', label: 'VIDEO' }, () => videoItems(ctx)),
);

function tierItems(ctx: ControlContext): MenuItem[] {
  const s = ctx.player.store.state;
  const items: MenuItem[] = [{ type: 'header', label: `Decode tier  ·  now: ${s.mode ?? '—'}` }];
  for (const [v, label, hint] of [
    ['auto', 'Automatic', 'best available'],
    ['webcodecs', 'WebCodecs', 'tier 1'],
    ['mse', 'Media Source Extensions', 'tier 2'],
    ['wasm', 'FFmpeg WebAssembly', 'tier 3'],
  ]) {
    items.push({ label, hint, checked: s.tierRequest === v, onSelect: () => run(ctx, `set tier ${v}`) });
  }
  return items;
}

registerControl('tier', (ctx, cfg) =>
  menuButton(ctx, cfg, { icon: 'tier', title: 'Decode pipeline', label: 'TIER' }, () => tierItems(ctx)),
);

function skinItems(ctx: ControlContext): MenuItem[] {
  const items: MenuItem[] = [{ type: 'header', label: 'Skin  ·  K' }];
  for (const sk of ctx.ui.skins()) {
    items.push({ label: sk.name, checked: sk.id === ctx.skin.id, onSelect: () => ctx.ui.setSkin(sk.id) });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Skin inspector…', onSelect: () => ctx.ui.toggleInspector('skin') });
  items.push({ label: 'Key bindings…', onSelect: () => ctx.ui.toggleInspector('keys') });
  return items;
}

registerControl('skins', (ctx, cfg) => menuButton(ctx, cfg, { icon: 'skin', title: 'Skins', label: 'SKIN' }, () => skinItems(ctx)));

/**
 * Overflow menu: everything a compact layout has no room for, one tap away. Only shown while the
 * player is in its compact layout, unless the skin passes { "always": true }.
 */
registerControl('more', (ctx, cfg) => {
  const b = menuButton(ctx, cfg, { icon: 'more', title: 'More', label: 'MORE' }, () => {
    const s = ctx.player.store.state;
    return [
      { type: 'header', label: 'More' },
      { label: 'Playback speed', hint: `${s.speed.toFixed(2)}×  ›`, submenu: () => speedItems(ctx) },
      { label: 'Audio', submenu: () => audioItems(ctx) },
      { label: 'Video & shaders', submenu: () => videoItems(ctx) },
      { label: 'Decode pipeline', hint: `${s.tier ?? '—'}  ›`, submenu: () => tierItems(ctx) },
      { label: 'Skins', submenu: () => skinItems(ctx) },
      { type: 'separator' },
      { label: 'Muted', checked: s.muted, keepOpen: true, onSelect: () => run(ctx, 'cycle mute') },
      { label: `Volume −   (${Math.round(s.volume)}%)`, keepOpen: true, onSelect: () => run(ctx, 'add volume -10') },
      { label: 'Volume +', keepOpen: true, onSelect: () => run(ctx, 'add volume 10') },
      { label: 'Previous frame', hint: ',', keepOpen: true, onSelect: () => run(ctx, 'frame-back-step') },
      { label: 'Next frame', hint: '.', keepOpen: true, onSelect: () => run(ctx, 'frame-step') },
      { label: 'Loop file', checked: s.loop, keepOpen: true, onSelect: () => run(ctx, 'cycle loop-file') },
      { type: 'separator' },
      { label: 'Stats for nerds', checked: s.stats, onSelect: () => run(ctx, 'cycle stats') },
      { label: 'Screenshot', onSelect: () => run(ctx, 'screenshot') },
      { label: 'Open file…', onSelect: () => ctx.ui.openFile() },
    ] satisfies MenuItem[];
  });
  if (!cfg.always) b.classList.add('lp-show-narrow');
  return b;
});

// ---- meters ------------------------------------------------------------------------------------

/** Spectrum / level meter. `{ control: "vu", bars: 24 }` */
registerControl('vu', (ctx, cfg) => {
  const canvas = el('canvas', `lp-vu ${cfg.class ?? ''}`.trim());
  const bars = Math.max(4, Math.min(64, cfg.bars ?? 20));
  canvas.width = bars * 6;
  canvas.height = 40;
  const g = canvas.getContext('2d')!;
  let spectrum: Uint8Array<ArrayBuffer> | null = null;
  const peaks = new Float32Array(bars);
  ctx.frame(() => {
    const audio = ctx.player.audio;
    const n = audio.fftBins;
    if (!spectrum || spectrum.length !== n) spectrum = new Uint8Array(n);
    audio.getSpectrum(spectrum);
    const style = getComputedStyle(canvas);
    const color = style.getPropertyValue('--lp-vu-color').trim() || style.color;
    const peakColor = style.getPropertyValue('--lp-vu-peak').trim() || color;
    const W = canvas.width;
    const H = canvas.height;
    g.clearRect(0, 0, W, H);
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      // logarithmic band edges from ~40 Hz to ~16 kHz
      const lo = Math.floor(Math.pow(n * 0.7, i / bars) + i);
      const hi = Math.max(lo + 1, Math.floor(Math.pow(n * 0.7, (i + 1) / bars) + i + 1));
      let v = 0;
      for (let k = lo; k < hi && k < n; k++) v = Math.max(v, spectrum[k]);
      const level = v / 255;
      peaks[i] = Math.max(level, peaks[i] - 0.012);
      const h = Math.round(level * H);
      g.fillStyle = color;
      g.fillRect(i * bw + 1, H - h, bw - 2, h);
      g.fillStyle = peakColor;
      g.fillRect(i * bw + 1, H - Math.round(peaks[i] * H) - 1, bw - 2, 1.5);
    }
  });
  return canvas;
});
