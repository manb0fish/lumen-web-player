import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, load, openApp, readFrame, seekPaused, state, waitForStatus, waitForTime } from './helpers';

/**
 * The UI layer: runtime skin hot-swapping (built-in and external packages), the declarative
 * layout / token / icon engine, mpv-style key bindings, the stats overlay, and that the UI drives
 * the core purely through commands.
 */

const SKINS = ['glass', 'mpv', 'studio'] as const;
const root = (page: Page) => page.locator('.lp-root');
const cssVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.querySelector('.lp-root')!).getPropertyValue(n).trim(), name);

test('skins hot-swap during playback with zero console errors', async ({ page }) => {
  const errors = await openApp(page);
  await load(page, 'h264_aac_long.mp4', { autoplay: true });
  await waitForTime(page, 0.6);
  const accents = new Set<string>();
  let lastTime = 0;
  for (let round = 0; round < 3; round++) {
    for (const skin of SKINS) {
      await page.evaluate((s) => window.ui.setSkin(s), skin);
      await page.waitForTimeout(220);
      await expect(root(page)).toHaveAttribute('data-skin', skin);
      expect((await state(page)).skin).toBe(skin);
      await page.mouse.move(640, 600 + round);
      await expect(page.locator('[data-control="play"]')).toBeVisible();
      await expect(page.locator('[data-control="seekbar"]')).toBeVisible();
      accents.add(await cssVar(page, '--lp-accent'));

      if (skin === 'glass') {
        await expect(page.locator('[data-control="title"]')).toHaveText('h264_aac_long.mp4');
        await expect(root(page)).not.toHaveAttribute('data-dock', '');
      } else if (skin === 'mpv') {
        await expect(page.locator('[data-control="status-line"]')).toHaveText(
          /AV: \d\d:\d\d \/ 01:00 \(\d+%\) A-V: -?\d\.\d{3} Dropped: \d+/,
        );
        expect(await page.evaluate(() => getComputedStyle(document.querySelector('.lp-root')!).fontFamily)).toMatch(/mono/i);
      } else {
        await expect(page.locator('.lp-lcd-time')).toHaveText(/\d\d:\d\d\.\d{3}/);
        await expect(page.locator('.lp-vu')).toBeVisible();
        await expect(root(page)).toHaveAttribute('data-dock', '');
        // The deck is docked: the picture area shrinks instead of being covered.
        const geo = await page.evaluate(() => {
          const r = document.querySelector('.lp-root')!.getBoundingClientRect();
          const s = document.querySelector('.lp-stage')!.getBoundingClientRect();
          const d = document.querySelector('.lp-region-bottom')!.getBoundingClientRect();
          return { root: r.height, stage: s.height, dock: d.height };
        });
        expect(geo.dock).toBeGreaterThan(80);
        expect(Math.abs(geo.root - geo.stage - geo.dock)).toBeLessThan(2);
      }
      // Playback never stops while the chrome is rebuilt.
      const s = await state(page);
      expect(s.status).toBe('playing');
      const t = await page.evaluate(() => window.player.currentTime);
      expect(t).toBeGreaterThan(lastTime);
      lastTime = t;
    }
  }
  expect(accents.size, 'each skin has its own accent token').toBe(3);
  // The picture is still right after nine swaps.
  const f = await readFrame(page);
  expect(Math.abs(f.frame - f.time * 30)).toBeLessThanOrEqual(2.5);
  // Keyboard: K cycles skins.
  await root(page).focus();
  const before = (await state(page)).skin;
  await page.keyboard.press('K');
  await expect.poll(async () => (await state(page)).skin).not.toBe(before);
  expectNoErrors(errors);
});

test('a custom skin package rearranges controls, binds new buttons to commands, and is sanitised', async ({ page }) => {
  const errors = await openApp(page);
  await load(page, 'h264_aac_long.mp4');
  const pkg = {
    id: 'test-skin',
    name: 'Test Skin',
    tokens: { '--lp-accent': '#ff00aa', '--evil': 'url(http://evil.example/x)', 'not-a-token': 'red' },
    layout: {
      bottom: [
        [
          'play',
          { control: 'button', command: 'seek 20 absolute', label: 'JUMP', title: 'Jump to 20 s' },
          'seekbar',
          'time',
          'no-such-control',
        ],
      ],
    },
    icons: {
      play: '<path d="M4 4h16v16H4z"/><script>window.__pwned = 1</script><circle cx="2" cy="2" r="1" onload="window.__pwned = 1"/><image href="http://evil.example/i.png"/>',
    },
    css: '@import url("http://evil.example/a.css"); .lp-btn { outline: 3px solid rgb(255, 0, 170); } .lp-time { background-image: url(http://evil.example/t.png); } @keyframes test-spin { to { transform: rotate(1turn); } }',
    osd: { position: 'center' },
    autohide: 0,
  };
  await page.evaluate((p) => window.ui.loadSkin(p), pkg);
  await expect(root(page)).toHaveAttribute('data-skin', 'test-skin');

  // Layout from the manifest: exactly the controls it asked for (unknown ones are skipped).
  const controls = await page
    .locator('.lp-region-bottom [data-control]')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.control));
  expect(controls).toEqual(['play', 'button', 'seekbar', 'time']);
  await expect(page.locator('.lp-region-top')).toBeHidden();

  // Tokens and scoped CSS are live.
  expect(await cssVar(page, '--lp-accent')).toBe('#ff00aa');
  expect(await cssVar(page, '--evil')).toBe('');
  expect(await page.locator('[data-control="play"]').evaluate((e) => getComputedStyle(e).outlineColor)).toBe('rgb(255, 0, 170)');

  // The custom button drives the core through the command bus.
  await page.getByRole('button', { name: 'Jump to 20 s' }).click();
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(19.9);
  expect(await page.evaluate(() => window.player.currentTime)).toBeLessThan(20.2);

  // Hostile content is neutralised.
  const playHtml = await page.locator('[data-control="play"]').innerHTML();
  expect(playHtml).toContain('<path');
  expect(playHtml).not.toMatch(/script|onload|image|evil/i);
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  const styleText = await page.evaluate(() => document.querySelector('style[data-lumen-skin]')!.textContent);
  expect(styleText).not.toContain('evil.example');
  expect(styleText).not.toContain('@import');
  expect(styleText).toContain('@keyframes test-spin');
  expect(styleText).toContain('.lp-root[data-skin="test-skin"]');

  // Switching away removes every trace of the package's styling.
  await page.evaluate(() => window.ui.setSkin('glass'));
  expect(await cssVar(page, '--lp-accent')).toBe('#7dd3fc');
  expect(await page.locator('[data-control="play"]').evaluate((e) => getComputedStyle(e).outlineStyle)).toBe('none');

  // Malformed packages are rejected with a reason.
  const bad = await page.evaluate(() =>
    window.ui.loadSkin({ id: 'bad id!', name: 'x', layout: {} }).then(
      () => null,
      (e: Error) => e.message,
    ),
  );
  expect(bad).toContain('id');
  const bad2 = await page.evaluate(() =>
    window.ui.loadSkin({ id: 'ok', name: 'x', layout: { bottom: ['play'] } }).then(
      () => null,
      (e: Error) => e.message,
    ),
  );
  expect(bad2).toContain('rows');
  expectNoErrors(errors);
});

test('an external skin package loads from a URL (manifest + stylesheet)', async ({ page }) => {
  const errors = await openApp(page);
  await load(page, 'h264_aac.mp4', { autoplay: true });
  await page.evaluate(() => window.ui.loadSkin('/skins/neon.json'));
  await expect(root(page)).toHaveAttribute('data-skin', 'neon');
  expect(await cssVar(page, '--lp-accent')).toBe('#39ff14');
  await page.mouse.move(600, 650);
  await expect(page.getByRole('button', { name: 'Cycle speed' })).toHaveText('TURBO');
  await page.getByRole('button', { name: 'Cycle speed' }).click();
  expect((await state(page)).speed).toBe(1.5);
  // the stylesheet's @keyframes was hoisted and its rules were scoped
  expect(await page.locator('[data-control="play"]').evaluate((e) => getComputedStyle(e).animationName)).toBe('lp-neon-pulse');
  expect(await page.evaluate(() => window.ui.skins().map((s: any) => s.id))).toEqual(['glass', 'mpv', 'studio', 'neon']);
  expect((await state(page)).status).toBe('playing');
  expectNoErrors(errors);
});

test('skin inspector: live token editing and skin cards', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => window.ui.toggleInspector('skin'));
  await expect(page.locator('.lp-inspector')).toBeVisible();
  await page.locator('input[data-token="--lp-accent"]').fill('#00ff88');
  expect(await cssVar(page, '--lp-accent')).toBe('#00ff88');
  await page.locator('.lp-skin-card[data-skin-id="studio"]').click();
  await expect(root(page)).toHaveAttribute('data-skin', 'studio');
  await expect(page.locator('.lp-skin-card[data-skin-id="studio"]')).toHaveAttribute('data-active', 'true');
  // edits are per skin: going back to glass restores the edited value, reset clears it
  await page.locator('.lp-skin-card[data-skin-id="glass"]').click();
  expect(await cssVar(page, '--lp-accent')).toBe('#00ff88');
  await page.getByRole('button', { name: 'Reset tokens' }).click();
  expect(await cssVar(page, '--lp-accent')).toBe('#7dd3fc');
  // key-binding editor round trip
  await page.locator('.lp-inspector-tabs button', { hasText: 'Key bindings' }).click();
  const area = page.locator('.lp-inspector textarea');
  await expect(area).toHaveValue(/SPACE cycle pause/);
  await area.fill('SPACE cycle pause\ng show-text "custom binding works" 3000\n');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.locator('.lp-inspector header button').click();
  await root(page).focus();
  await page.keyboard.press('g');
  await expect(page.locator('.lp-osd-box')).toHaveText('custom binding works');
  expectNoErrors(errors);
});

test('mpv-style key bindings drive playback', async ({ page }) => {
  const errors = await openApp(page, { tier: 'webcodecs' });
  await load(page, 'h264_aac_long.mp4');
  await seekPaused(page, 10);
  await root(page).focus();
  const key = (k: string) => page.keyboard.press(k);
  const st = () => state(page);

  // frame stepping: . and ,
  const f0 = (await readFrame(page)).frame;
  expect(f0).toBe(300);
  for (let i = 1; i <= 5; i++) {
    await key('.');
    await expect.poll(async () => (await readFrame(page)).frame, { message: `after ${i} forward steps` }).toBe(f0 + i);
  }
  for (let i = 1; i <= 3; i++) {
    await key(',');
    await expect.poll(async () => (await readFrame(page)).frame, { message: `after ${i} back steps` }).toBe(f0 + 5 - i);
  }
  expect((await st()).paused).toBe(true);

  // speed: [ ] { } BS
  await key(']');
  expect((await st()).speed).toBeCloseTo(1.1, 5);
  await key('[');
  expect((await st()).speed).toBeCloseTo(1, 5);
  await key('}');
  expect((await st()).speed).toBe(2);
  await key('{');
  await key('{');
  expect((await st()).speed).toBe(0.5);
  await key('Backspace');
  expect((await st()).speed).toBe(1);

  // seeking: arrows, Shift+arrows (exact, 1 s), Home
  await key('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(14.9);
  await key('ArrowLeft');
  await key('Shift+ArrowRight');
  await expect.poll(async () => Math.abs((await page.evaluate(() => window.player.currentTime)) - 11.07)).toBeLessThan(0.08);
  await key('ArrowUp');
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(59);
  await key('Home');
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeLessThan(0.1);

  // volume / mute
  await key('9');
  expect((await st()).volume).toBe(98);
  await key('0');
  await key('0');
  expect((await st()).volume).toBe(102);
  await key('m');
  expect((await st()).muted).toBe(true);
  await key('m');
  await expect(page.locator('.lp-osd-box')).toHaveText('Mute: no');

  // shader toggles and renderer cycling
  await key('u');
  expect((await st()).scaler).toBe('lanczos');
  await key('b');
  expect((await st()).deband).toBe(true);
  await key('Control+s');
  expect((await st()).sharpen).toBeCloseTo(0.35, 5);
  await key('t');
  expect((await st()).toneMapping).toBe('hable');
  await key('r');
  await expect.poll(async () => (await st()).renderer).toBe('webgl2');
  await key('r');
  await expect.poll(async () => (await st()).renderer).toBe('canvas2d');
  await key('r');
  await expect.poll(async () => (await st()).renderer).toBe('webgpu');

  // play / pause and A-B loop
  await key('Space');
  await waitForStatus(page, 'playing');
  await waitForTime(page, 0.5);
  await key('l');
  const a = (await st()).abLoopA;
  expect(a).toBeGreaterThan(0.4);
  await page.waitForTimeout(700);
  await key('l');
  const s2 = await st();
  expect(s2.abLoopB).toBeGreaterThan(a + 0.5);
  await page.waitForTimeout(1600);
  const t = await page.evaluate(() => window.player.currentTime);
  expect(t, 'looping inside A-B').toBeLessThan(s2.abLoopB + 0.2);
  expect(t).toBeGreaterThan(a - 0.1);
  await key('l');
  expect((await st()).abLoopA).toBeNull();
  await key('Space');
  await waitForStatus(page, 'paused');

  // programmatic rebinding uses the same input.conf grammar
  await page.evaluate(() => window.player.keys.merge('q seek 30 absolute\nCtrl+g cycle-values speed 1 1.5\nSPACE ignore'));
  await key('q');
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(29.9);
  await key('Control+g');
  expect((await st()).speed).toBe(1.5);
  await key('Space');
  await page.waitForTimeout(150);
  expect((await st()).paused, 'SPACE was rebound to "ignore"').toBe(true);
  expectNoErrors(errors);
});

test('stats for nerds shows live pipeline data', async ({ page }) => {
  const errors = await openApp(page, { tier: 'wasm' });
  await load(page, 'hevc10_aac.mkv', { autoplay: true });
  await waitForTime(page, 1);
  await root(page).focus();
  await page.keyboard.press('i');
  const panel = page.locator('.lp-stats');
  await expect(panel).toBeVisible();
  const text = await panel.innerText();
  for (const expected of [
    /Pipeline\s+wasm\s+\(wasm-sw\)/,
    /Renderer\s+webgpu/,
    /Shader chain\s+yuv10le→rgb → bicubic → dither/,
    /Video\s+hevc 640x360 30fps 10-bit/,
    /Audio\s+aac 48000Hz 2ch/,
    /Color space\s+bt709\/bt709\/bt709 limited/,
    /FPS\s+\d+ presented\/s/,
    /Frames\s+dropped \d+\s+delayed \d+\s+queue \d+/,
    /A\/V sync\s+-?\d+\.\d ms\s+avg \d+\.\d\s+max \d+\.\d/,
    /Decoder\s+latency \d+\.\d ms/,
    /Buffer\s+video \d\.\d\d s\s+audio \d\.\d\d s\s+underruns 0/,
    /Capabilities\s+webcodecs ✓\s+mse ✓\s+webgpu ✓\s+sab ✓/,
  ]) {
    expect(text, `stats overlay matches ${expected}`).toMatch(expected);
  }
  // it is live
  await page.waitForTimeout(700);
  expect(await panel.innerText()).not.toBe(text);
  await page.keyboard.press('i');
  await expect(panel).toBeHidden();
  expectNoErrors(errors);
});

test('mouse: buttons, seek bar with thumbnail preview, menus, volume', async ({ page }) => {
  const errors = await openApp(page, { skin: 'glass' });
  await load(page, 'subs_embedded.mkv');
  await page.waitForFunction(() => window.player.store.state.subTracks.length === 5);
  await page.mouse.move(640, 640);

  await page.locator('[data-control="play"]').click();
  await waitForStatus(page, 'playing');
  await page.locator('[data-control="play"]').click();
  await waitForStatus(page, 'paused');

  // click in the middle of the seek bar
  const bar = page.locator('[data-control="seekbar"]');
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect(page.locator('.lp-seek-tip-time')).toHaveText(/00:0[34]\.\d{3}/);
  await expect(page.locator('.lp-seek-tip')).toHaveAttribute('data-thumb', '', { timeout: 10_000 });
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(3.8);
  expect(await page.evaluate(() => window.player.currentTime)).toBeLessThan(4.3);
  // drag to 25 %
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await page.evaluate(() => window.player.currentTime)) - 2.0)).toBeLessThan(0.15);

  // menus
  await page.locator('[data-control="speed"]').click();
  await expect(page.locator('.lp-menu')).toBeVisible();
  await page.locator('.lp-menu-item', { hasText: '1.5×' }).click();
  await expect(page.locator('.lp-menu')).toHaveCount(0);
  expect((await state(page)).speed).toBe(1.5);

  await page.locator('[data-control="subtitles"]').click();
  await expect(page.locator('.lp-menu-item', { hasText: 'Torture' })).toBeVisible();
  await expect(page.locator('.lp-menu-item[data-checked="true"]').first()).toContainText('Sync boxes');
  await page.locator('.lp-menu-item', { hasText: 'PGS' }).click();
  await expect
    .poll(async () => {
      const s = await state(page);
      return s.subTracks.find((t: any) => t.id === s.subTrack)?.label;
    })
    .toBe('PGS');

  await page.locator('[data-control="video"]').click();
  await page.locator('.lp-menu-item', { hasText: 'Lanczos 3' }).click();
  expect((await state(page)).scaler).toBe('lanczos');
  await expect(page.locator('.lp-menu')).toBeVisible(); // toggles keep the menu open
  await page.keyboard.press('Escape');
  await expect(page.locator('.lp-menu')).toHaveCount(0);

  // volume slider + OSD
  await page.locator('[data-control="volume"]').fill('40');
  expect((await state(page)).volume).toBe(40);
  await page.locator('[data-control="mute"]').click();
  expect((await state(page)).muted).toBe(true);
  expectNoErrors(errors);
});

test('public API: plugins, screenshot, thumbnails, <lumen-player> element', async ({ page }) => {
  const errors = await openApp(page);
  await load(page, 'h264_aac.mp4');
  await seekPaused(page, 2);

  const plugin = await page.evaluate(async () => {
    const p = window.player;
    const w = window as any;
    w.__frames = 0;
    p.use({
      name: 'test-plugin',
      install(player: any) {
        const off = player.events.on('frame', () => w.__frames++);
        const unregister = player.commands.register('hello', ([who]: string[]) => player.osd(`hello ${who}`));
        player.commands.defineProperty('answer', { type: 'number', get: () => 42 });
        return () => {
          off();
          unregister();
          w.__disposed = true;
        };
      },
    });
    p.command('hello world');
    p.frameStep(1); // produces a "frame" event for the plugin's listener
    await new Promise((r) => setTimeout(r, 400));
    return { answer: p.commands.getProp('answer'), commands: p.commands.listCommands().includes('hello') };
  });
  expect(plugin).toEqual({ answer: 42, commands: true });
  await expect(page.locator('.lp-osd-box')).toHaveText('hello world');

  const shot = await page.evaluate(async () => {
    const blob: Blob = await window.player.screenshot();
    const bmp = await createImageBitmap(blob);
    return { type: blob.type, size: blob.size, w: bmp.width, h: bmp.height };
  });
  expect(shot.type).toBe('image/png');
  expect(shot.size).toBeGreaterThan(5000);
  expect(shot.w).toBeGreaterThanOrEqual(640);

  const thumb = await page.evaluate(async () => {
    const { bitmap, time } = await window.player.thumbnail(5.4, 160);
    const out = { w: bitmap?.width ?? 0, h: bitmap?.height ?? 0, time };
    bitmap?.close();
    return out;
  });
  expect(thumb.w).toBe(160);
  expect(thumb.h).toBe(90);
  expect(thumb.time, 'thumbnail comes from the key frame at/before the requested time').toBe(5);

  // Declarative element.
  const el = await page.evaluate(async () => {
    const e = document.createElement('lumen-player') as any;
    e.setAttribute('src', '/media/h264_aac.mp4');
    e.setAttribute('skin', 'mpv');
    e.setAttribute('autoplay', '');
    e.style.cssText = 'position:fixed;right:8px;bottom:8px;width:320px;height:180px;z-index:99';
    document.body.appendChild(e);
    const t0 = performance.now();
    while (e.player.store.state.status !== 'playing' && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 500));
    const res = { status: e.player.store.state.status, skin: e.querySelector('.lp-root')?.dataset.skin, time: e.player.currentTime };
    e.remove();
    return res;
  });
  expect(el.status).toBe('playing');
  expect(el.skin).toBe('mpv');
  expect(el.time).toBeGreaterThan(0.2);

  const frames = await page.evaluate(() => (window as any).__frames);
  expect(frames).toBeGreaterThan(0);
  await page.evaluate(async () => {
    window.ui.destroy();
    await window.player.destroy();
  });
  expect(await page.evaluate(() => (window as any).__disposed)).toBe(true);
  expectNoErrors(errors);
});
