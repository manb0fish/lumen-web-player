import { defineConfig, type Plugin } from 'vite';

/**
 * Cross-origin isolation (COOP/COEP) unlocks SharedArrayBuffer, which the FFmpeg-WASM tier uses
 * for threads and for Atomics-based flow control. Appending `?nosab` to the page URL serves the
 * document WITHOUT those headers so the non-SAB fallback paths can be exercised on the same server.
 */
function crossOriginIsolation(): Plugin {
  const apply = (req: any, res: any, next: () => void) => {
    const url: string = req.url ?? '';
    const isolated = !/[?&]nosab\b/.test(url);
    if (isolated) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  };
  return {
    name: 'lumen:cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use(apply);
    },
    configurePreviewServer(server) {
      server.middlewares.use(apply);
    },
  };
}

/**
 * Content types for media the static file server does not know. Without one, `vite preview`
 * treats the file as text and gzips it, while range requests for the same URL are answered
 * uncompressed under the same ETag. The browser cache then mixes the two and a full download
 * (the FFmpeg tier fetches the whole file) can come back damaged. Media must never be compressed.
 */
const MEDIA_TYPES: Record<string, string> = {
  mkv: 'video/x-matroska',
  mka: 'audio/x-matroska',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  sup: 'application/octet-stream',
  ass: 'text/x-ssa; charset=utf-8',
  ssa: 'text/x-ssa; charset=utf-8',
  srt: 'application/x-subrip; charset=utf-8',
};

function mediaContentTypes(): Plugin {
  const apply = (req: any, res: any, next: () => void) => {
    const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(req.url ?? '')?.[1]?.toLowerCase();
    const type = ext ? MEDIA_TYPES[ext] : undefined;
    // The static middleware keeps a Content-Type that is already set.
    if (type) res.setHeader('Content-Type', type);
    next();
  };
  return {
    name: 'lumen:media-content-types',
    configureServer(server) {
      server.middlewares.use(apply);
    },
    configurePreviewServer(server) {
      server.middlewares.use(apply);
    },
  };
}

export default defineConfig({
  plugins: [crossOriginIsolation(), mediaContentTypes()],
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  preview: { port: 4173, strictPort: true, host: '127.0.0.1' },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    // index.html is the demo app; harness.html is the bare, UI-less page the leak tests drive.
    rollupOptions: { input: { main: 'index.html', harness: 'harness.html' } },
  },
  optimizeDeps: {
    // These ship their own workers / wasm resolved through import.meta.url; pre-bundling breaks that.
    exclude: ['jassub', '@ffmpeg/core', '@ffmpeg/core-mt'],
    // ...but jassub's CommonJS dependencies still need converting to ESM.
    include: ['mediabunny', 'jassub > throughput', 'jassub > rvfc-polyfill'],
  },
});
