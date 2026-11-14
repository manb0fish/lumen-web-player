/*
 * Lumen cross-origin isolation service worker.
 *
 * SharedArrayBuffer (and with it FFmpeg threads and streaming flow control) is only available on
 * a "cross-origin isolated" page, which needs two response headers that some static hosts give
 * you no way to set. This worker adds them to every response it relays, so the page becomes
 * isolated after one reload. It is registered by ensureCrossOriginIsolation() (src/isolate.ts)
 * and does nothing on a server that already sends the headers, because it is never installed
 * there.
 *
 * Remove it by unregistering the service worker in the browser's site settings.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // Sent by developer tools; such a request cannot be forwarded.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  // "?nosab" asks for a page without isolation (the fallback paths are tested that way).
  if (request.mode === 'navigate' && /[?&]nosab\b/.test(request.url)) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response; // opaque: its headers cannot be changed
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }),
  );
});
