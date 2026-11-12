import { DEFAULT_INPUT_CONF } from '../core/keybindings';
import type { Player, PlayerStats } from '../core/player';
import { formatTime } from '../core/types';
import { listControls } from './controls';
import type { SkinEngine } from './skin';

type Disposer = () => void;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---- OSD ---------------------------------------------------------------------------------------

export function createOsd(player: Player, layer: HTMLElement): Disposer {
  const box = el('div', 'lp-osd-box');
  const text = el('div', 'lp-osd-text');
  const bar = el('div', 'lp-osd-bar');
  const fill = document.createElement('i');
  bar.appendChild(fill);
  box.append(text, bar);
  layer.appendChild(box);
  let timer = 0;
  const off = player.events.on('osd', ({ text: message, duration }) => {
    text.textContent = message;
    // mpv-style bar for the two quantities people adjust blind: volume and position.
    let value: number | null = null;
    const vol = /^Volume:\s*(\d+)%/.exec(message);
    if (vol) value = Number(vol[1]) / 130;
    else if (/^\d[\d:]*\s\/\s\d/.test(message) && player.duration) value = player.store.state.currentTime / player.duration;
    if (value !== null) {
      box.dataset.bar = '';
      fill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
    } else delete box.dataset.bar;
    box.dataset.show = '';
    clearTimeout(timer);
    timer = window.setTimeout(() => delete box.dataset.show, duration);
  });
  return () => {
    off();
    clearTimeout(timer);
    box.remove();
  };
}

// ---- Stats for nerds ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export function formatStats(s: PlayerStats): string {
  const p = s.pipeline;
  const row = (k: string, v: string) => `<b>${k.padEnd(13)}</b>${esc(v)}\n`;
  let out = '';
  out += row('Pipeline', `${s.tier ?? '-'}  (${s.mode ?? '-'})`);
  out += `<span class="lp-stats-dim">${''.padEnd(13)}${esc(s.routeReason)}</span>\n`;
  out += row('Renderer', `${s.renderer ?? '-'}  —  ${s.rendererDetail}`);
  out += row('Shader chain', s.chain);
  out += row('Container', s.container);
  out += row('Video', s.video);
  out += row('Audio', s.audio);
  out += row('Color space', s.colorSpace);
  out += row('Resolution', `${s.dimensions.video} → ${s.dimensions.canvas}  (dpr ${s.dimensions.dpr})`);
  out += row('Position', `${formatTime(s.time, true)} / ${formatTime(s.duration, true)}  ×${s.speed.toFixed(2)}`);
  if (p) {
    out += row('FPS', `${p.fps} presented/s   total ${p.presented}`);
    out += row('Frames', `dropped ${p.dropped}   delayed ${p.delayed}   queue ${p.queue}`);
    out += row('A/V sync', `${p.driftMs.toFixed(1)} ms   avg ${p.driftAvgMs.toFixed(1)}   max ${p.driftMaxMs.toFixed(1)}`);
    out += row('Decoder', `latency ${p.decodeLatencyMs.toFixed(1)} ms${p.hold ? '   hold: ' + p.hold : ''}`);
    out += row('Buffer', `video ${p.videoAhead.toFixed(2)} s   audio ${p.audioAhead.toFixed(2)} s   underruns ${p.underruns}`);
  }
  out += row(
    'Render',
    `${s.render.lastRenderMs.toFixed(2)} ms/frame   textures ${s.render.texturesCreated - s.render.texturesDestroyed} live (${s.render.texturesCreated} created)`,
  );
  out += row('Audio out', `${s.audioEngine.state}  ${s.audioEngine.sampleRate} Hz  latency ${s.audioEngine.latencyMs.toFixed(0)} ms`);
  out += row('Subtitles', `${s.subtitles.engine}${s.subtitles.fonts.length ? '   fonts: ' + s.subtitles.fonts.join(', ') : ''}`);
  out += row('VideoFrames', `${s.frames.alive} open   (${s.frames.opened} received, ${s.frames.closed} closed)`);
  const c = s.capabilities;
  out += row(
    'Capabilities',
    `webcodecs ${c.webcodecs ? '✓' : '✗'}  mse ${c.mse ? '✓' : '✗'}  webgpu ${c.webgpu ? '✓' : '✗'}  sab ${c.sab ? '✓' : '✗'}`,
  );
  if (s.jsHeapMB !== null) out += row('JS heap', `${s.jsHeapMB.toFixed(1)} MB`);
  if (s.notes.length) out += `<span class="lp-stats-dim">${esc(s.notes.slice(-4).join('\n'))}</span>\n`;
  return out;
}

export function createStats(player: Player, layer: HTMLElement): Disposer {
  const panel = el('div', 'lp-stats');
  panel.dataset.lpChrome = '';
  panel.dataset.lpScroll = '';
  const text = el('div');
  const graph = el('canvas');
  graph.width = 520;
  graph.height = 88;
  panel.append(text, graph);
  const history: number[] = [];
  let timer = 0;
  let visible = false;

  const draw = () => {
    const g = graph.getContext('2d')!;
    const W = graph.width;
    const H = graph.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(0, 0, W, H);
    // ±40 ms scale, zero line in the middle
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.beginPath();
    g.moveTo(0, H / 2);
    g.lineTo(W, H / 2);
    g.stroke();
    g.strokeStyle = getComputedStyle(panel).getPropertyValue('--lp-accent') || '#7dd3fc';
    g.lineWidth = 1.5;
    g.beginPath();
    history.forEach((v, i) => {
      const x = (i / 119) * W;
      const y = H / 2 - (Math.max(-40, Math.min(40, v)) / 40) * (H / 2 - 4);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
    g.fillStyle = 'rgba(230,237,243,0.55)';
    g.font = '11px ui-monospace, monospace';
    g.fillText('A/V sync (±40 ms)', 6, 13);
  };

  const update = () => {
    const s = player.getStats();
    text.innerHTML = formatStats(s);
    history.push(s.pipeline?.driftMs ?? 0);
    if (history.length > 120) history.shift();
    draw();
  };
  const off = player.store.watch(['stats'], (st) => {
    if (st.stats === visible) return;
    visible = st.stats;
    if (visible) {
      layer.appendChild(panel);
      update();
      timer = window.setInterval(update, 250);
    } else {
      panel.remove();
      clearInterval(timer);
    }
  });
  return () => {
    off();
    clearInterval(timer);
    panel.remove();
  };
}

// ---- Audio visualizer (shown when there is no picture) ------------------------------------------

export function createVisualizer(player: Player, layer: HTMLElement, root: HTMLElement): Disposer {
  const canvas = el('canvas');
  layer.appendChild(canvas);
  let raf = 0;
  let spectrum: Uint8Array<ArrayBuffer> | null = null;
  let wave: Float32Array<ArrayBuffer> | null = null;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (root.dataset.hasVideo !== 'false' || root.dataset.loaded !== 'true') return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(canvas.clientWidth * dpr);
    const H = Math.round(canvas.clientHeight * dpr);
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const audio = player.audio;
    const n = audio.fftBins;
    if (!spectrum || spectrum.length !== n) {
      spectrum = new Uint8Array(n);
      wave = new Float32Array(n * 2);
    }
    audio.getSpectrum(spectrum);
    audio.getWaveform(wave!);
    const g = canvas.getContext('2d')!;
    const accent = getComputedStyle(root).getPropertyValue('--lp-accent').trim() || '#7dd3fc';
    g.clearRect(0, 0, W, H);
    const bars = Math.min(96, Math.floor(W / (7 * dpr)));
    const bw = W / bars;
    g.fillStyle = accent;
    for (let i = 0; i < bars; i++) {
      const lo = Math.floor(Math.pow(n * 0.75, i / bars) + i);
      const hi = Math.max(lo + 1, Math.floor(Math.pow(n * 0.75, (i + 1) / bars) + i + 1));
      let v = 0;
      for (let k = lo; k < hi && k < n; k++) v = Math.max(v, spectrum[k]);
      const h = (v / 255) * H * 0.42;
      g.globalAlpha = 0.25 + 0.75 * (v / 255);
      g.fillRect(i * bw + bw * 0.15, H * 0.62 - h, bw * 0.7, h);
      g.globalAlpha *= 0.25;
      g.fillRect(i * bw + bw * 0.15, H * 0.62 + 2 * dpr, bw * 0.7, h * 0.35);
    }
    g.globalAlpha = 0.9;
    g.strokeStyle = accent;
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    const step = Math.max(1, Math.floor(wave!.length / W));
    for (let x = 0, i = 0; i < wave!.length && x < W; x++, i += step) {
      const y = H * 0.82 + wave![i] * H * 0.1;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.globalAlpha = 1;
  };
  raf = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(raf);
    canvas.remove();
  };
}

// ---- Skin inspector / key bindings ------------------------------------------------------------

function toHexColor(v: string): string | null {
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s.slice(1).replace(/./g, (c) => c + c);
  return null;
}

export interface InspectorHandle {
  toggle(tab?: string): void;
  refresh(): void;
  destroy(): void;
}

export function createInspector(
  player: Player,
  layer: HTMLElement,
  engine: SkinEngine,
  api: { setSkin(id: string): void; loadSkinFile(): void; persist(): void; saveKeys(conf: string | null): void },
): InspectorHandle {
  const panel = el('div', 'lp-inspector');
  panel.dataset.lpChrome = '';
  panel.dataset.lpScroll = '';
  const header = el('header');
  header.append(el('span', undefined, 'Customize'), el('span', 'lp-spacer'));
  const close = el('button', 'lp-btn');
  close.type = 'button';
  close.title = 'Close';
  close.textContent = '✕';
  close.style.minWidth = '28px';
  close.style.height = '28px';
  header.appendChild(close);
  const tabs = el('div', 'lp-inspector-tabs');
  const body = el('div', 'lp-inspector-body');
  panel.append(header, tabs, body);
  let open = false;
  let tab = 'skin';

  const action = (label: string, fn: () => void) => {
    const b = el('button', 'lp-btn', label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  };

  const renderSkin = () => {
    body.append(
      el(
        'p',
        undefined,
        'Skins are JSON packages: design tokens, a declarative control layout, icons and optional CSS. Switch instantly, tweak tokens live, or load your own.',
      ),
    );
    for (const skin of engine.list()) {
      const card = el('button', 'lp-skin-card');
      card.type = 'button';
      card.dataset.active = String(skin.id === engine.current?.id);
      card.dataset.skinId = skin.id;
      const sw = el('span', 'lp-skin-swatch');
      sw.style.background = `linear-gradient(135deg, ${skin.tokens?.['--lp-accent'] ?? '#888'} 0 50%, ${skin.tokens?.['--lp-bg-solid'] ?? '#222'} 50% 100%)`;
      const info = el('span');
      info.append(el('b', undefined, skin.name), el('small', undefined, skin.description ?? skin.id));
      card.append(sw, info);
      card.addEventListener('click', () => api.setSkin(skin.id));
      body.appendChild(card);
    }
    const actions = el('div', 'lp-inspector-actions');
    actions.append(
      action('Load skin package…', () => api.loadSkinFile()),
      action('Export current', () => {
        const blob = new Blob([engine.export()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${engine.current?.id ?? 'skin'}.lumen-skin.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }),
      action('Reset tokens', () => {
        engine.resetTokens();
        api.persist();
        render();
      }),
    );
    body.appendChild(actions);
    body.appendChild(el('h4', undefined, `Tokens — ${engine.current?.name ?? ''}`));
    for (const [name, value] of Object.entries(engine.tokens())) {
      const row = el('div', 'lp-token-row');
      const label = el('label', undefined, name);
      label.title = name;
      const hex = toHexColor(value);
      const color = el('input');
      color.type = 'color';
      const textInput = el('input');
      textInput.type = 'text';
      textInput.value = value;
      textInput.spellcheck = false;
      textInput.dataset.token = name;
      if (hex) color.value = hex;
      else color.style.visibility = 'hidden';
      color.addEventListener('input', () => {
        textInput.value = color.value;
        engine.setToken(name, color.value);
        api.persist();
      });
      textInput.addEventListener('input', () => {
        engine.setToken(name, textInput.value);
        const h = toHexColor(textInput.value);
        if (h) color.value = h;
        api.persist();
      });
      textInput.addEventListener('keydown', (e) => e.stopPropagation());
      row.append(label, color, textInput);
      body.appendChild(row);
    }
    body.appendChild(el('h4', undefined, 'Available controls'));
    body.appendChild(el('p', undefined, listControls().join(' · ')));
  };

  const renderKeys = () => {
    body.append(
      el(
        'p',
        undefined,
        'mpv input.conf syntax: one "KEY command" per line. Commands are the same ones the UI uses (seek, cycle, add, set, multiply, frame-step, ab-loop …).',
      ),
    );
    const area = el('textarea');
    area.spellcheck = false;
    area.value = player.keys.toString();
    area.addEventListener('keydown', (e) => e.stopPropagation());
    body.appendChild(area);
    const actions = el('div', 'lp-inspector-actions');
    actions.append(
      action('Apply', () => {
        player.keys.load(area.value);
        api.saveKeys(area.value);
        player.osd('Key bindings applied');
      }),
      action('Reset to defaults', () => {
        area.value = DEFAULT_INPUT_CONF;
        player.keys.load(DEFAULT_INPUT_CONF);
        api.saveKeys(null);
        player.osd('Key bindings reset');
      }),
    );
    body.appendChild(actions);
    body.appendChild(el('h4', undefined, 'Properties'));
    body.appendChild(el('p', undefined, player.commands.listProperties().join(' · ')));
    body.appendChild(el('h4', undefined, 'Commands'));
    body.appendChild(el('p', undefined, player.commands.listCommands().join(' · ')));
  };

  const render = () => {
    tabs.textContent = '';
    for (const [id, label] of [
      ['skin', 'Skin'],
      ['keys', 'Key bindings'],
    ]) {
      const b = el('button', undefined, label);
      b.type = 'button';
      b.dataset.active = String(tab === id);
      b.addEventListener('click', () => {
        tab = id;
        render();
      });
      tabs.appendChild(b);
    }
    body.textContent = '';
    if (tab === 'keys') renderKeys();
    else renderSkin();
  };

  const setOpen = (v: boolean) => {
    open = v;
    if (open) {
      render();
      layer.appendChild(panel);
    } else panel.remove();
  };
  close.addEventListener('click', () => setOpen(false));

  return {
    toggle(next?: string) {
      if (open && (!next || next === tab)) return setOpen(false);
      if (next) tab = next;
      setOpen(true);
    },
    refresh() {
      if (open) render();
    },
    destroy() {
      panel.remove();
    },
  };
}
