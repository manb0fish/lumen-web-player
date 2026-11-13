/**
 * Demo application: the player filling the window plus a sidebar of the synthesised test media.
 *
 * URL parameters (all optional):
 *   src=<url>            media to load          autoplay=0     do not start automatically
 *   tier=auto|webcodecs|mse|wasm|native         renderer=auto|webgpu|webgl2|canvas2d
 *   wasm=auto|sw|remux   force an FFmpeg strategy  threads=0|1 single- / multi-threaded FFmpeg core
 *   skin=glass|mpv|studio                       sub=<url>      external subtitle to add
 *   sidebar=0            hide the sample list   persist=0      do not touch localStorage
 *   nosab                run without cross-origin isolation (no SharedArrayBuffer)
 */
import { Player } from './core/player';
import type { RendererRequest, TierRequest } from './core/types';
import type { WasmMode } from './pipeline/router';
import './element'; // registers <lumen-player>
import { ensureCrossOriginIsolation } from './isolate';
import { mountUI } from './ui';

const q = new URLSearchParams(location.search);
// On a host that does not send the isolation headers, a service worker adds them (one reload on
// the first visit). Without isolation FFmpeg has no threads and cannot stream; see the guide.
if (!q.has('nosab')) void ensureCrossOriginIsolation(new URL('lumen-isolation-sw.js', document.baseURI).href);
const root = document.getElementById('player')!;
const app = document.getElementById('app')!;
if (q.get('sidebar') === '0') app.dataset.sidebar = 'off';

const player = new Player({
  container: root,
  renderer: (q.get('renderer') as RendererRequest) ?? 'auto',
  tier: (q.get('tier') as TierRequest) ?? 'auto',
  wasmMode: (q.get('wasm') as WasmMode) ?? 'auto',
  wasmThreads: q.has('threads') ? q.get('threads') === '1' : undefined,
  injectWebCodecsFaultAfter: Number(q.get('fault')) || undefined,
});
const ui = mountUI(player, root, { skin: q.get('skin') ?? undefined, persist: q.get('persist') !== '0' });
Object.assign(window, { player, ui });

const caps = player.capabilities;
document.getElementById('caps')!.textContent = [caps.webcodecs && 'WC', caps.mse && 'MSE', caps.webgpu && 'GPU', caps.sab && 'SAB']
  .filter(Boolean)
  .join(' · ');

// ---- sample list ---------------------------------------------------------------------------------
interface ManifestFile {
  file: string;
  container: string;
  video: string | null;
  audio: string | null;
  bitDepth?: number;
  hdr?: string;
  colors?: boolean;
  subtitles?: string[];
  long?: boolean;
  channels?: number;
  perf?: boolean;
}

const nav = document.getElementById('samples')!;
let activeButton: HTMLButtonElement | null = null;

// On small screens the sample list is a drawer (see index.html); the tab on the edge opens it.
const drawerTab = document.getElementById('drawer-tab')!;
function setDrawer(open: boolean): void {
  if (open) app.dataset.drawer = 'open';
  else delete app.dataset.drawer;
  drawerTab.setAttribute('aria-expanded', String(open));
}
drawerTab.addEventListener('click', () => setDrawer(app.dataset.drawer !== 'open'));
document.getElementById('scrim')!.addEventListener('click', () => setDrawer(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setDrawer(false);
});

function section(title: string): void {
  const h = document.createElement('h3');
  h.textContent = title;
  nav.appendChild(h);
}

function entry(label: string, tag: string, onClick: (b: HTMLButtonElement) => void): void {
  const b = document.createElement('button');
  b.type = 'button';
  const span = document.createElement('span');
  span.textContent = label;
  const small = document.createElement('small');
  small.textContent = tag;
  b.append(span, small);
  b.addEventListener('click', () => onClick(b));
  nav.appendChild(b);
}

function play(file: string, b: HTMLButtonElement): void {
  if (activeButton) activeButton.dataset.active = 'false';
  activeButton = b;
  b.dataset.active = 'true';
  player.load(`/media/${file}`, { autoplay: true }).catch(() => {});
  setDrawer(false);
  root.focus({ preventScroll: true });
}

async function buildSamples(): Promise<void> {
  let manifest: { files: ManifestFile[]; extras: string[] };
  try {
    const res = await fetch('/media/manifest.json');
    if (!res.ok) throw new Error(String(res.status));
    manifest = await res.json();
  } catch {
    const p = document.createElement('p');
    p.innerHTML = 'No sample media yet. Run <code>npm run media</code> to synthesise the test matrix, or drop a file on the player.';
    nav.appendChild(p);
    return;
  }
  const tag = (f: ManifestFile) =>
    [f.video ? `${f.video}${f.bitDepth && f.bitDepth > 8 ? '·' + f.bitDepth : ''}` : null, f.audio].filter(Boolean).join(' + ');
  const groups: Array<[string, (f: ManifestFile) => boolean]> = [
    ['Video', (f) => !!f.video && !f.colors && !f.subtitles && !f.perf],
    ['1080p (performance)', (f) => !!f.perf],
    ['Subtitles (embedded)', (f) => !!f.subtitles],
    ['Colour & HDR', (f) => !!f.colors],
    ['Audio only', (f) => !f.video],
  ];
  for (const [title, test] of groups) {
    const files = manifest.files.filter(test);
    if (!files.length) continue;
    section(title);
    for (const f of files) entry(f.file, tag(f), (b) => play(f.file, b));
  }
  section('External subtitles');
  for (const name of manifest.extras) {
    entry(name, 'add', () => {
      player.addSubtitle({ name, url: `/media/${name}` }).then(
        () => player.osd(`Subtitles: ${name}`, 1800),
        (err) => player.osd(String(err?.message ?? err), 3000),
      );
    });
  }
  const p = document.createElement('p');
  p.innerHTML =
    'Keys: <code>Space</code> <code>, .</code> <code>[ ]</code> <code>z x</code> <code>l</code> <code>i</code> <code>r</code> <code>u</code> <code>K</code>';
  nav.appendChild(p);
}
void buildSamples();

// ---- deep link -----------------------------------------------------------------------------------
const src = q.get('src');
if (src) {
  player
    .load(src, { autoplay: q.get('autoplay') !== '0', startTime: Number(q.get('t')) || 0 })
    .then(() => {
      const sub = q.get('sub');
      if (sub) return player.addSubtitle({ name: sub.split('/').pop() ?? 'subtitle', url: sub });
    })
    .catch(() => {});
}
