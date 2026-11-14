import './base.css';
import type { Player } from '../core/player';
import type { PlayerState } from '../core/types';
import { getControl, type ControlContext } from './controls';
import { DEFAULT_ICONS, iconSvg } from './icons';
import { closeMenu, isMenuOpen } from './menu';
import { createInspector, createOsd, createStats, createVisualizer, type InspectorHandle } from './overlays';
import { SkinEngine, type LayoutItem, type SkinManifest } from './skin';
import glassCss from './skins/glass.css?inline';
import glass from './skins/glass.json';
import mpvCss from './skins/mpv.css?inline';
import mpv from './skins/mpv.json';
import studioCss from './skins/studio.css?inline';
import studio from './skins/studio.json';

export { registerControl, type ControlContext, type ControlFactory } from './controls';
export { SkinEngine, validateSkin, type SkinManifest, type LayoutItem } from './skin';

export const BUILTIN_SKINS: SkinManifest[] = [
  { ...(glass as unknown as SkinManifest), css: glassCss },
  { ...(mpv as unknown as SkinManifest), css: mpvCss },
  { ...(studio as unknown as SkinManifest), css: studioCss },
];

export interface UIOptions {
  /** Skin to start with (defaults to the last one used, then "glass"). */
  skin?: string;
  /** Remember skin, token edits and key bindings in localStorage. Default true. */
  persist?: boolean;
  /** Extra skin packages to register up front. */
  skins?: unknown[];
}

export interface UIHandle {
  readonly root: HTMLElement;
  readonly engine: SkinEngine;
  setSkin(id: string): void;
  skins(): SkinManifest[];
  /** Register a skin package (object) or fetch one (URL), then optionally switch to it. */
  loadSkin(source: string | unknown, apply?: boolean): Promise<SkinManifest>;
  toggleInspector(tab?: string): void;
  destroy(): void;
}

const MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|ts|m2ts|mts|avi|flv|wmv|mpg|mpeg|ogv|mp3|flac|wav|ogg|oga|opus|m4a|aac|ac3|mka)$/i;
const SUB_EXT = /\.(ass|ssa|srt|vtt|sup)$/i;
const FONT_EXT = /\.(ttf|otf|ttc|woff2?)$/i;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
};

/**
 * Attach the skinnable UI to a headless Player. `root` must be the element the player was created
 * in. Everything here goes through the player's public store / command bus / events — the core has
 * no knowledge of this module.
 */
export function mountUI(player: Player, root: HTMLElement, opts: UIOptions = {}): UIHandle {
  const persist = opts.persist !== false;
  root.classList.add('lp-root');
  root.tabIndex = 0;

  const layer = (name: string) => {
    const d = document.createElement('div');
    d.className = `lp-layer lp-${name}`;
    root.appendChild(d);
    return d;
  };
  const visual = layer('visual');
  const osdLayer = layer('osd');
  const chrome = layer('chrome');
  const overlay = layer('overlay');

  const idle = document.createElement('div');
  idle.className = 'lp-idle';
  idle.innerHTML = `<svg class="lp-idle-mark" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" fill="none" stroke="currentColor" stroke-width="2.5" opacity=".5"/><path d="M26 20.5v23a1.5 1.5 0 0 0 2.3 1.27l18-11.5a1.5 1.5 0 0 0 0-2.54l-18-11.5A1.5 1.5 0 0 0 26 20.5z" fill="currentColor"/></svg><b>Drop a media file here</b><span>or use Open — video, audio, subtitles, fonts and skin packages are all accepted</span>`;
  visual.appendChild(idle);
  const spinner = document.createElement('div');
  spinner.className = 'lp-spinner';
  const errorBox = document.createElement('div');
  errorBox.className = 'lp-error';
  const drop = document.createElement('div');
  drop.className = 'lp-drop';
  drop.textContent = 'Drop to open';
  overlay.append(spinner, errorBox, drop);

  const disposers: Array<() => void> = [];
  disposers.push(createOsd(player, osdLayer), createStats(player, overlay), createVisualizer(player, visual, root));

  // ---- file inputs ------------------------------------------------------------------------------
  const picker = (accept: string, multiple: boolean, onFiles: (files: File[]) => void) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.value = '';
      if (files.length) onFiles(files);
    });
    root.appendChild(input);
    return input;
  };

  const handleFiles = async (files: File[]) => {
    const media = files.find((f) => f.type.startsWith('video/') || f.type.startsWith('audio/') || MEDIA_EXT.test(f.name));
    for (const f of files) {
      if (FONT_EXT.test(f.name)) player.subs.addFont(f.name, new Uint8Array(await f.arrayBuffer()));
      else if (/\.json$/i.test(f.name)) {
        try {
          const skin = engine.register(JSON.parse(await f.text()));
          saveUserSkin(skin);
          setSkin(skin.id);
          player.osd(`Skin loaded: ${skin.name}`, 2000);
        } catch (err: any) {
          player.osd(`Invalid skin package: ${err?.message ?? err}`, 3500);
        }
      }
    }
    if (media) {
      try {
        await player.load(media, { autoplay: true });
      } catch {
        /* surfaced through the error state */
      }
    }
    for (const f of files) {
      if (SUB_EXT.test(f.name)) {
        try {
          await player.addSubtitle(f);
          player.osd(`Subtitles: ${f.name}`, 1800);
        } catch (err: any) {
          player.osd(`Could not load ${f.name}: ${err?.message ?? err}`, 3000);
        }
      }
    }
  };
  const mediaInput = picker('video/*,audio/*,.mkv,.ts,.avi,.flv,.mka,.ass,.ssa,.srt,.vtt,.sup,.ttf,.otf', true, handleFiles);
  const subInput = picker('.ass,.ssa,.srt,.vtt,.sup,.ttf,.otf,.ttc', true, handleFiles);
  const skinInput = picker('.json,application/json', false, handleFiles);

  // ---- skins --------------------------------------------------------------------------------------
  const engine = new SkinEngine(root);
  for (const s of BUILTIN_SKINS) engine.register(s);
  for (const s of opts.skins ?? []) engine.register(s);

  const saveUserSkin = (skin: SkinManifest) => {
    if (!persist) return;
    const all = JSON.parse(store.get('lumen.userSkins') ?? '{}');
    all[skin.id] = skin;
    store.set('lumen.userSkins', JSON.stringify(all));
  };
  if (persist) {
    try {
      for (const s of Object.values(JSON.parse(store.get('lumen.userSkins') ?? '{}'))) engine.register(s);
      const tokens = JSON.parse(store.get('lumen.skinTokens') ?? '{}');
      for (const [id, values] of Object.entries(tokens)) engine.setOverrides(id, values as Record<string, string>);
      const conf = store.get('lumen.inputConf');
      if (conf) player.keys.load(conf);
    } catch {
      /* ignore corrupt storage */
    }
  }
  const persistTokens = () => {
    if (!persist) return;
    const out: Record<string, Record<string, string>> = {};
    for (const s of engine.list()) {
      const o = engine.getOverrides(s.id);
      if (Object.keys(o).length) out[s.id] = o;
    }
    store.set('lumen.skinTokens', JSON.stringify(out));
  };

  // ---- chrome construction ------------------------------------------------------------------------
  let cleanups: Array<() => void> = [];
  let frames: Array<() => void> = [];
  let raf = 0;
  let hideTimer = 0;
  let autohide = 2500;
  let dockObserver: ResizeObserver | null = null;
  let inspector: InspectorHandle | null = null;
  // True while the last pointer used was a finger: bigger targets, taps instead of hover.
  let touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  root.toggleAttribute('data-touch', touch);

  const tick = () => {
    raf = requestAnimationFrame(tick);
    for (const fn of frames) fn();
  };
  raf = requestAnimationFrame(tick);

  const setSkin = (id: string) => {
    if (!engine.has(id)) return;
    engine.apply(id);
    player.store.set({ skin: id });
    if (persist) store.set('lumen.skin', id);
    inspector?.refresh();
  };

  const uiApi: ControlContext['ui'] = {
    skins: () => engine.list(),
    setSkin,
    toggleInspector: (tab) => inspector?.toggle(tab),
    openFile: () => mediaInput.click(),
    openSubtitle: () => subInput.click(),
  };

  const buildItem = (skin: SkinManifest, item: LayoutItem): HTMLElement | null => {
    const name = typeof item === 'string' ? item : item.control;
    const cfg: Record<string, any> = typeof item === 'string' ? {} : item;
    if (name === 'group') {
      const g = document.createElement('div');
      g.className = `lp-group ${cfg.class ?? ''}`.trim();
      for (const child of (cfg.items ?? []) as LayoutItem[]) {
        const c = buildItem(skin, child);
        if (c) g.appendChild(c);
      }
      return g;
    }
    const factory = getControl(name);
    if (!factory) {
      console.warn(`[lumen] skin "${skin.id}" references unknown control "${name}"`);
      return null;
    }
    const ctx: ControlContext = {
      player,
      root,
      skin,
      icon: (n) => iconSvg(skin.icons?.[n] ?? DEFAULT_ICONS[n] ?? ''),
      cleanup: (fn) => cleanups.push(fn),
      frame: (fn) => frames.push(fn),
      watch: (keys, fn) => cleanups.push(player.store.watch(keys, fn)),
      ui: uiApi,
    };
    const node = factory(ctx, cfg);
    node.dataset.control = name;
    if (cfg.hideNarrow) node.classList.add('lp-hide-narrow');
    return node;
  };

  const rebuild = (skin: SkinManifest) => {
    closeMenu();
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    cleanups = [];
    frames = [];
    dockObserver?.disconnect();
    dockObserver = null;
    chrome.textContent = '';
    for (const region of ['top', 'center', 'bottom'] as const) {
      const rows = skin.layout[region] ?? [];
      const box = document.createElement('div');
      box.className = `lp-region lp-region-${region}`;
      if (region !== 'center') box.dataset.lpChrome = '';
      for (const row of rows) {
        const r = document.createElement('div');
        r.className = 'lp-row';
        for (const item of row) {
          const node = buildItem(skin, item);
          if (node) r.appendChild(node);
        }
        box.appendChild(r);
      }
      if (!rows.length && region !== 'center') box.style.display = 'none';
      chrome.appendChild(box);
    }
    osdLayer.dataset.pos = skin.osd?.position ?? 'top-left';
    autohide = skin.autohide ?? 2500;
    if (skin.dock) {
      const bottom = chrome.querySelector('.lp-region-bottom') as HTMLElement;
      dockObserver = new ResizeObserver(() => root.style.setProperty('--lp-dock-h', `${bottom.offsetHeight}px`));
      dockObserver.observe(bottom);
      root.style.setProperty('--lp-dock-h', `${bottom.offsetHeight}px`);
    } else {
      root.style.setProperty('--lp-dock-h', '0px');
    }
    showChrome();
    fit();
  };
  engine.onApply = rebuild;

  // ---- adaptive layout ----------------------------------------------------------------------------
  // Whether the controls fit is measured, not assumed. The skin is laid out at full size, and if
  // any row overflows (or the seek bar is squeezed to a stub) the player switches to "compact":
  // controls marked hideNarrow go away and the overflow menu takes their place. Because it is a
  // measurement it holds for any skin, font size and input mode, including skin packages this
  // code has never seen. "short" marks a low player (a phone held sideways).
  const fit = () => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (!w || !h) return;
    root.toggleAttribute('data-short', h < 430);
    root.dataset.size = 'wide';
    let cramped = false;
    for (const row of chrome.querySelectorAll<HTMLElement>('.lp-row')) {
      if (row.scrollWidth > row.clientWidth + 1) cramped = true;
    }
    const bar = chrome.querySelector<HTMLElement>('.lp-seekbar');
    if (bar && bar.offsetWidth > 0 && bar.offsetWidth < Math.min(180, w * 0.4)) cramped = true;
    if (cramped) root.dataset.size = 'compact';
  };
  // Measured on the next frame rather than inside the observer callback: changing the layout from
  // within it makes the browser report a "ResizeObserver loop" error.
  let fitFrame = 0;
  const sizeObserver = new ResizeObserver(() => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(fit);
  });
  sizeObserver.observe(root);
  // The time display grows with the duration (hours), so measure again once a file is known.
  disposers.push(player.store.watch(['duration', 'mediaInfo'], () => fit()));

  const setTouch = (on: boolean) => {
    if (on === touch) return;
    touch = on;
    root.toggleAttribute('data-touch', on);
    fit();
  };

  // ---- auto-hide ----------------------------------------------------------------------------------
  const showChrome = () => {
    if (root.dataset.chrome === 'hidden') delete root.dataset.chrome;
    clearTimeout(hideTimer);
    if (!autohide) return;
    hideTimer = window.setTimeout(() => {
      const s = player.store.state;
      const hovering = !touch && chrome.querySelector('.lp-region:hover') !== null;
      if (s.paused || s.status !== 'playing' || hovering || isMenuOpen() || overlay.querySelector('.lp-inspector')) {
        showChrome();
        return;
      }
      root.dataset.chrome = 'hidden';
    }, autohide);
  };
  const hideChrome = () => {
    clearTimeout(hideTimer);
    if (autohide) root.dataset.chrome = 'hidden';
  };
  const onActivity = (e: Event) => {
    const type = (e as PointerEvent).pointerType;
    if (type === 'touch') setTouch(true);
    else if (type === 'mouse') setTouch(false);
    showChrome();
  };
  root.addEventListener('pointermove', onActivity);
  root.addEventListener('pointerdown', onActivity);
  root.addEventListener('keydown', onActivity);

  // ---- state → attributes (what skin CSS keys off) ------------------------------------------------
  disposers.push(
    player.store.watch(['status', 'paused', 'fullscreen', 'mediaInfo', 'tier', 'renderer', 'error'], (s: Readonly<PlayerState>) => {
      root.dataset.status = s.status;
      root.dataset.paused = String(s.paused);
      root.dataset.fullscreen = String(s.fullscreen);
      root.dataset.loaded = String(!!s.mediaInfo);
      root.dataset.hasVideo = String(!!s.mediaInfo?.video);
      root.dataset.tier = s.tier ?? '';
      root.dataset.renderer = s.renderer ?? '';
      errorBox.textContent = s.error ?? '';
      if (s.paused) showChrome();
    }),
  );

  // ---- input ----------------------------------------------------------------------------------------
  disposers.push(player.keys.attach(root, (cmd) => player.command(cmd)));
  const onStage = (t: EventTarget | null) =>
    t instanceof Element && !t.closest('[data-lp-chrome], .lp-menu, .lp-inspector, .lp-stats, button, input');

  // Mouse. The browser reports a double-click as click, click, dblclick, so pausing on every click
  // would pause and resume around each double-click (fullscreen by default). The pause therefore
  // waits a moment to see whether a second click follows. If the second click comes later than
  // that, the pause the first one caused is taken back.
  const DOUBLE_CLICK_MS = 250;
  let clickTimer = 0;
  let clickPaused = false;
  let lastTouchUp = -1e9;
  const fromTouch = () => performance.now() - lastTouchUp < 600;
  const onClick = (e: MouseEvent) => {
    if (!onStage(e.target)) return;
    root.focus({ preventScroll: true });
    // Taps are handled by the touch gestures below: ignore the click the browser derives from one.
    if ((e as PointerEvent).pointerType === 'touch' || fromTouch()) return;
    const status = player.store.state.status;
    if (status === 'idle') {
      mediaInput.click();
      return;
    }
    if (status === 'error') return;
    if (!player.keys.lookup('MBTN_LEFT_DBL')) {
      player.togglePause(); // nothing is bound to a double-click, so there is nothing to wait for
      return;
    }
    if (e.detail > 1) {
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = 0;
      } else if (clickPaused) player.togglePause();
      clickPaused = false;
      return;
    }
    clearTimeout(clickTimer);
    clickPaused = false;
    clickTimer = window.setTimeout(() => {
      clickTimer = 0;
      clickPaused = true;
      player.togglePause();
    }, DOUBLE_CLICK_MS);
  };
  root.addEventListener('click', onClick);

  // Touch. A tap shows or hides the controls. A double tap seeks 10 s back or forward on the left
  // or right third of the picture and toggles play/pause in the middle. Skins that keep their
  // controls on screen (autohide 0) have nothing to show or hide, so there a tap is play/pause.
  const DOUBLE_TAP_MS = 300;
  let touchDown: { id: number; x: number; y: number; t: number; hidden: boolean } | null = null;
  let lastTap = { t: -1e9, x: 0, y: 0 };
  let tapTimer = 0;
  const onTouchDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    // Capture phase: this runs before the activity handler brings the controls back.
    touchDown = onStage(e.target)
      ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), hidden: root.dataset.chrome === 'hidden' }
      : null;
  };
  const onTouchUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const now = performance.now();
    lastTouchUp = now;
    const d = touchDown;
    touchDown = null;
    if (!d || d.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 16 || now - d.t > 500) return; // a drag or a long press
    const status = player.store.state.status;
    if (status === 'idle') {
      mediaInput.click();
      return;
    }
    if (status === 'error') return;
    if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 80) {
      clearTimeout(tapTimer);
      tapTimer = 0;
      lastTap.t = -1e9;
      const r = root.getBoundingClientRect();
      const f = (e.clientX - r.left) / Math.max(1, r.width);
      if (f < 0.35) player.command('seek -10');
      else if (f > 0.65) player.command('seek 10');
      else player.togglePause();
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    clearTimeout(tapTimer);
    tapTimer = window.setTimeout(() => {
      tapTimer = 0;
      if (!autohide) player.togglePause();
      else if (!d.hidden && !player.store.state.paused && player.store.state.status === 'playing' && !isMenuOpen()) hideChrome();
    }, DOUBLE_TAP_MS);
  };
  // A double tap must not also run the mouse double-click binding.
  const onDblClick = (e: MouseEvent) => {
    if (fromTouch()) e.stopImmediatePropagation();
  };
  root.addEventListener('pointerdown', onTouchDown, true);
  root.addEventListener('pointerup', onTouchUp);
  root.addEventListener('dblclick', onDblClick, true);

  // On a phone, fullscreen video belongs in landscape. Browsers that cannot lock simply refuse.
  let orientationLocked = false;
  disposers.push(
    player.store.watch(['fullscreen'], (s) => {
      const o = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
      const v = s.mediaInfo?.video;
      if (s.fullscreen && touch && o?.lock && v && v.displayWidth >= v.displayHeight) {
        orientationLocked = true;
        o.lock('landscape').catch(() => (orientationLocked = false));
      } else if (!s.fullscreen && orientationLocked) {
        orientationLocked = false;
        try {
          o?.unlock();
        } catch {
          /* not locked */
        }
      }
    }),
  );

  let dragDepth = 0;
  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    root.dataset.dropping = '';
  };
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  };
  const onDragLeave = () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      delete root.dataset.dropping;
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth = 0;
    delete root.dataset.dropping;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) void handleFiles(files);
  };
  root.addEventListener('dragenter', onDragEnter);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('dragleave', onDragLeave);
  root.addEventListener('drop', onDrop);

  disposers.push(
    player.events.on('screenshot', (blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const t = player.currentTime.toFixed(3).replace('.', '_');
      a.download = `lumen-${t}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }),
  );

  // ---- skin as a player property, so `cycle skin` / keybindings / plugins can drive it ------------
  player.commands.defineProperty('skin', {
    type: 'choice',
    choices: () => engine.list().map((s) => s.id),
    get: () => engine.current?.id ?? '',
    set: (v: string) => setSkin(v),
    osd: (v) => `Skin: ${engine.list().find((s) => s.id === v)?.name ?? v}`,
  });
  player.commands.register('skin-inspector', () => inspector?.toggle('skin'));

  inspector = createInspector(player, overlay, engine, {
    setSkin,
    loadSkinFile: () => skinInput.click(),
    persist: persistTokens,
    saveKeys: (conf) => persist && store.set('lumen.inputConf', conf),
  });

  const initial = opts.skin && engine.has(opts.skin) ? opts.skin : (persist && store.get('lumen.skin')) || 'glass';
  setSkin(engine.has(initial) ? initial : 'glass');

  return {
    root,
    engine,
    setSkin,
    skins: () => engine.list(),
    async loadSkin(source, apply = true) {
      const skin = typeof source === 'string' ? await engine.load(source) : engine.register(source);
      saveUserSkin(skin);
      if (apply) setSkin(skin.id);
      inspector?.refresh();
      return skin;
    },
    toggleInspector: (tab) => inspector?.toggle(tab),
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(hideTimer);
      clearTimeout(clickTimer);
      clearTimeout(tapTimer);
      closeMenu();
      dockObserver?.disconnect();
      sizeObserver.disconnect();
      cancelAnimationFrame(fitFrame);
      for (const fn of [...cleanups, ...disposers]) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      inspector?.destroy();
      root.removeEventListener('pointermove', onActivity);
      root.removeEventListener('pointerdown', onActivity);
      root.removeEventListener('keydown', onActivity);
      root.removeEventListener('click', onClick);
      root.removeEventListener('pointerdown', onTouchDown, true);
      root.removeEventListener('pointerup', onTouchUp);
      root.removeEventListener('dblclick', onDblClick, true);
      for (const a of ['data-size', 'data-short', 'data-touch']) root.removeAttribute(a);
      root.removeEventListener('dragenter', onDragEnter);
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('dragleave', onDragLeave);
      root.removeEventListener('drop', onDrop);
      engine.destroy();
      for (const n of [visual, osdLayer, chrome, overlay, mediaInput, subInput, skinInput]) n.remove();
      root.classList.remove('lp-root');
    },
  };
}
