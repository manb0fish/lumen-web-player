/**
 * Cross-origin isolation on servers that do not send the headers for it.
 *
 * SharedArrayBuffer is what lets the FFmpeg tier use threads, pace a running decode and share its
 * input cache with a read-ahead worker. Browsers only expose it on a cross-origin isolated page:
 * one served with `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`. Where those cannot be configured (plain static
 * hosting), a service worker can add them instead; the page has to be loaded through it once, so
 * the first visit reloads.
 */

const RELOAD_FLAG = 'lumen.isolationReload';

export type IsolationResult = 'isolated' | 'reloading' | 'unavailable';

/**
 * Make sure the page is cross-origin isolated, registering `workerUrl` (a copy of
 * public/lumen-isolation-sw.js, served from the page's own directory or above) if it is not.
 *
 * Resolves to "isolated" when nothing needed doing, "reloading" when the page is about to reload
 * under the service worker, and "unavailable" when isolation cannot be had here (no service
 * workers, an insecure origin, or the reload did not help) — the player then uses its slower,
 * single-threaded FFmpeg path.
 */
export async function ensureCrossOriginIsolation(workerUrl = 'lumen-isolation-sw.js'): Promise<IsolationResult> {
  const flag = {
    get: () => {
      try {
        return sessionStorage.getItem(RELOAD_FLAG);
      } catch {
        return 'blocked'; // no storage: never risk a reload loop
      }
    },
    set: (v: string | null) => {
      try {
        if (v === null) sessionStorage.removeItem(RELOAD_FLAG);
        else sessionStorage.setItem(RELOAD_FLAG, v);
      } catch {
        /* storage unavailable */
      }
    },
  };
  if (globalThis.crossOriginIsolated) {
    flag.set(null);
    return 'isolated';
  }
  if (!('serviceWorker' in navigator) || !globalThis.isSecureContext) return 'unavailable';
  if (flag.get()) return 'unavailable'; // already reloaded once in this tab and it did not help
  try {
    await navigator.serviceWorker.register(workerUrl);
    await navigator.serviceWorker.ready;
    flag.set('1');
    location.reload();
    return 'reloading';
  } catch {
    return 'unavailable';
  }
}
