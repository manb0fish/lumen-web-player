import { defineConfig } from '@playwright/test';

/**
 * The suite drives a real, installed Chromium-family browser (Edge by default) because the
 * Chromium build bundled with Playwright ships without H.264/AAC/HEVC decoders.
 *   LUMEN_BROWSER_CHANNEL=chrome npx playwright test     use Chrome instead
 *   HEADED=1 npx playwright test                          watch it run
 */
// LUMEN_PREVIEW=1 runs the suite against the production build (vite build + vite preview)
// instead of the dev server, which is how bundling regressions are caught.
const preview = !!process.env.LUMEN_PREVIEW;
const origin = `http://127.0.0.1:${preview ? 4173 : 5173}`;

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1, // one GPU, one audio device, real-time assertions: keep runs from competing
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: origin,
    channel: process.env.LUMEN_BROWSER_CHANNEL ?? 'msedge',
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--enable-unsafe-webgpu',
        '--enable-precise-memory-info',
        '--js-flags=--expose-gc',
      ],
    },
  },
  webServer: {
    command: preview ? 'npm run build && npm run preview' : 'npm run dev',
    url: origin,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
