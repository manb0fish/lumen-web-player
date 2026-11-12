// Bare harness (headless player, no UI). Served as /harness.html and driven by the test-suite for
// low-level pipeline, teardown and memory checks, and by scripts/probe.mjs.
import { Player, type PlayerOptions } from './core/player';
import { frameLedger } from './pipeline/types';
import { textureLedger } from './render';

const q = new URLSearchParams(location.search);
const host = document.getElementById('host')!;

function make(extra: Partial<PlayerOptions> = {}): Player {
  const player = new Player({
    container: host,
    renderer: (q.get('renderer') as any) ?? 'auto',
    tier: (q.get('tier') as any) ?? 'auto',
    wasmMode: (q.get('wasm') as any) ?? 'auto',
    wasmThreads: q.get('threads') === '1',
    injectWebCodecsFaultAfter: Number(q.get('fault')) || undefined,
    ...extra,
  });
  // Routing decisions and fallbacks, visible to scripts/probe.mjs through the browser console.
  player.events.on('note', (m) => console.info('[note]', m));
  return player;
}

Object.assign(window, { Lumen: { make, frameLedger, textureLedger } });
if (q.get('auto') !== '0') (window as any).player = make();
(window as any).ready = true;
