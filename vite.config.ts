import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Cross-origin isolation (COOP/COEP) unlocks SharedArrayBuffer, which the FFmpeg-WASM tier uses
 * for threads and for Atomics-based flow control. Appending `?nosab` to the page URL serves the
 * document WITHOUT those headers so the non-SAB fallback paths can be exercised on the same server.
 */
function crossOriginIsolation(): Plugin {
  const apply = (req: any, res: any, next: () => void) => {
    const url: string = req.url ?? '';
    // `?noheaders` leaves them out too, but there the page may still isolate itself (service worker).
    const isolated = !/[?&](nosab|noheaders)\b/.test(url);
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

/**
 * A deliberately slow file server for measuring network behaviour, on the dev and preview servers:
 *
 *   /slow/<kbit-per-second>/<latency-ms>/<path under public/>[?noranges]
 *
 * It honours range requests, waits `latency` before the first byte of every response and then
 * paces the bodies so that all responses at one rate together stay within it, as on a real link.
 * `/slow/stats` reports how many requests and bytes were served since `/slow/reset`. Responses
 * are never cached, so every read really crosses this "network".
 */
function slowMedia(): Plugin {
  const stats = { requests: 0, bytes: 0, ranges: [] as string[] };
  const links = new Map<string, { free: number }>();
  const TYPES: Record<string, string> = { ...MEDIA_TYPES, mp4: 'video/mp4', webm: 'video/webm', ts: 'video/mp2t', mp3: 'audio/mpeg' };
  const handler = (dirs: string[]) => (req: any, res: any, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/slow/')) return next();
    if (url.pathname === '/slow/stats') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify(stats));
    }
    if (url.pathname === '/slow/reset') {
      stats.requests = 0;
      stats.bytes = 0;
      stats.ranges = [];
      res.setHeader('Cache-Control', 'no-store');
      return res.end('ok');
    }
    const m = /^\/slow\/(\d+)\/(\d+)\/(.+)$/.exec(decodeURIComponent(url.pathname));
    const rel = m ? normalize(m[3]) : '';
    const file = m && !rel.startsWith('..') ? dirs.map((d) => join(d, rel)).find((f) => existsSync(f) && statSync(f).isFile()) : undefined;
    if (!m || !file) {
      res.statusCode = 404;
      return res.end('not found');
    }
    const bytesPerSecond = (Number(m[1]) * 1000) / 8;
    // One link per rate, shared by every response on it, like a real connection.
    let link = links.get(m[1]);
    if (!link) links.set(m[1], (link = { free: 0 }));
    const latency = Number(m[2]);
    const size = statSync(file).size;
    // `?noranges` plays a server that ignores range requests and always sends the whole file.
    const noRanges = url.searchParams.has('noranges');
    const range = noRanges ? null : /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    if (range) {
      if (range[1] === '') start = Math.max(0, size - Number(range[2]));
      else {
        start = Number(range[1]);
        if (range[2] !== '') end = Math.min(end, Number(range[2]));
      }
      if (start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    stats.requests++;
    stats.ranges.push(req.method === 'HEAD' ? 'HEAD' : `${start}-${end}`);
    if (!noRanges) res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(end - start + 1));
    res.setHeader('Content-Type', TYPES[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD') return res.end();
    let closed = false;
    res.on('close', () => (closed = true));
    setTimeout(() => {
      if (closed) return;
      const stream = createReadStream(file, { start, end, highWaterMark: 32 * 1024 });
      res.on('close', () => stream.destroy());
      // When this response's latest chunk has finished crossing the link.
      let due = 0;
      const resume = () => {
        if (closed) return;
        const wait = due - Date.now();
        if (wait > 1) setTimeout(resume, wait);
        else stream.resume();
      };
      stream.on('data', (chunk) => {
        stats.bytes += chunk.length;
        // Every chunk books its time on the link behind whatever is already booked, by this
        // response or any other. Timers are coarse (15 ms on Windows), so a booking may start up
        // to 40 ms in the past: a late wake-up is made up for instead of idling the link.
        const begin = Math.max(Date.now() - 40, link.free);
        due = link.free = begin + (bytesPerSecond > 0 ? (chunk.length / bytesPerSecond) * 1000 : 0);
        const flushed = res.write(chunk);
        if (flushed && due - Date.now() <= 1) return;
        stream.pause();
        // A full socket buffer says nothing about the pace: go on as soon as it has drained.
        if (flushed) resume();
        else res.once('drain', resume);
      });
      stream.on('end', () => res.end());
      stream.on('error', () => res.destroy());
    }, latency);
  };
  return {
    name: 'lumen:slow-media',
    configureServer(server) {
      server.middlewares.use(handler([resolve(server.config.root, 'public')]));
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler([resolve(server.config.root, server.config.build.outDir), resolve(server.config.root, 'public')]));
    },
  };
}

export default defineConfig({
  plugins: [crossOriginIsolation(), mediaContentTypes(), slowMedia()],
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
