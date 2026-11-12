// Quick manual probe against a running dev server (npm run dev):
//   node scripts/probe.mjs <file> [tier] [renderer] [extra query]      e.g.  hevc10_aac.mkv wasm webgl2 threads=1
// Prints route, sync and frame statistics after 3 s of playback. BRIEF=1 for one line, SHOT=path for a screenshot.
import { chromium } from '@playwright/test';

const [file = 'h264_aac.mp4', tier = 'auto', renderer = 'auto', extra = ''] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: 'msedge',
  headless: !process.env.HEADED,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
page.on('console', (m) => console.log(`  [${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
page.on('response', (r) => {
  if (r.status() >= 400) console.log('  [http]', r.status(), r.url());
});
await page.goto(`http://127.0.0.1:5173/harness.html?tier=${tier}&renderer=${renderer}${extra ? '&' + extra : ''}`);
await page.waitForFunction('window.ready === true');
const res = await page.evaluate(async (file) => {
  const p = window.player;
  const out = {};
  try {
    await p.load('/media/' + file, { autoplay: true });
  } catch (e) {
    out.loadError = String(e?.message ?? e);
  }
  await new Promise((r) => setTimeout(r, 3000));
  const st = p.getStats();
  out.state = {
    status: p.store.state.status,
    time: p.currentTime,
    tier: st.tier,
    mode: st.mode,
    renderer: st.renderer,
    detail: st.rendererDetail,
    chain: st.chain,
  };
  out.video = st.video;
  out.audio = st.audio;
  out.color = st.colorSpace;
  out.pipeline = st.pipeline;
  out.audioEngine = st.audioEngine;
  out.frames = st.frames;
  out.frameStats = p.debug.frameStats();
  out.level = p.audio.getLevel();
  out.notes = st.notes;
  out.isolated = crossOriginIsolated;
  return out;
}, file);
const brief = process.env.BRIEF;
if (brief) {
  const p = res.pipeline || {};
  console.log(
    JSON.stringify({
      err: res.loadError,
      ...res.state,
      video: res.video,
      audio: res.audio,
      presented: p.presented,
      dropped: p.dropped,
      drift: [p.driftAvgMs?.toFixed(1), p.driftMaxMs?.toFixed(1)],
      lat: p.decodeLatencyMs?.toFixed(0),
      hold: p.hold,
      underruns: p.underruns,
      frames: res.frames,
      luma: res.frameStats && [res.frameStats.mean.toFixed(0), res.frameStats.stdev.toFixed(0)],
      level: res.level?.rms?.toFixed(3),
      notes: res.notes,
    }),
  );
} else console.log(JSON.stringify(res, null, 1));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await browser.close();
