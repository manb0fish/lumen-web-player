import { expect, test, type Page } from '@playwright/test';
import { expectNoErrors, load, openApp, waitForStatus, waitForTime } from './helpers';

/**
 * Pointer handling and small screens: the double-click that used to blip the pause, touch
 * gestures, and the compact layout every skin falls back to when its controls do not fit.
 */

const root = (page: Page) => page.locator('#player');

/** Record every change of the paused flag, so a pause that was immediately undone still shows up. */
async function recordPauses(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__pauses = [];
    let last = window.player.store.state.paused;
    window.player.store.subscribe((s: any) => {
      if (s.paused !== last) (window as any).__pauses.push((last = s.paused));
    });
  });
}
const pauses = (page: Page): Promise<boolean[]> => page.evaluate(() => (window as any).__pauses);

async function stageCentre(page: Page, fx = 0.5, fy = 0.4): Promise<{ x: number; y: number }> {
  const b = (await root(page).boundingBox())!;
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}

test.describe('mouse', () => {
  test('a double-click runs its binding without pausing; a single click still pauses', async ({ page }) => {
    const errors = await openApp(page);
    // Bind the double-click to something observable that works in a headless browser.
    await page.evaluate(() => window.player.keys.load('MBTN_LEFT_DBL cycle deband\nSPACE cycle pause\n'));
    await load(page, 'h264_aac_long.mp4', { autoplay: true });
    await waitForTime(page, 0.5);
    await recordPauses(page);
    const c = await stageCentre(page);
    const deband0 = await page.evaluate(() => window.player.store.state.deband);

    await page.mouse.dblclick(c.x, c.y);
    await page.waitForTimeout(700);
    expect(await pauses(page), 'paused flag changes during a double-click').toEqual([]);
    expect(await page.evaluate(() => window.player.store.state.deband)).toBe(!deband0);
    expect(await page.evaluate(() => window.player.store.state.paused)).toBe(false);

    // A single click pauses, once the double-click window has passed.
    await page.mouse.click(c.x, c.y);
    await expect.poll(() => page.evaluate(() => window.player.store.state.paused)).toBe(true);
    await page.mouse.click(c.x, c.y);
    await expect.poll(() => page.evaluate(() => window.player.store.state.paused)).toBe(false);
    await page.waitForTimeout(400);

    // A slow double-click (second click after the pause already happened) ends up playing again.
    await page.evaluate(() => ((window as any).__pauses.length = 0));
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(340);
    await page.mouse.down({ clickCount: 2 }); // the second press of the same double-click, nothing more
    await page.mouse.up({ clickCount: 2 });
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.player.store.state.paused), 'state after a slow double-click').toBe(false);
    expect(await page.evaluate(() => window.player.store.state.deband)).toBe(deband0);

    // With nothing bound to the double-click there is nothing to wait for: the click acts at once.
    await page.evaluate(() => window.player.keys.load('SPACE cycle pause\n'));
    await page.mouse.click(c.x, c.y);
    expect(await page.evaluate(() => window.player.store.state.paused)).toBe(true);
    expectNoErrors(errors);
  });
});

interface Fit {
  size: string | undefined;
  short: boolean;
  touch: boolean;
  outside: string[];
  small: string[];
  visible: string[];
  seekWidth: number;
  width: number;
}

/** Geometry of the visible controls relative to the player. */
function measure(page: Page, minTarget: number): Promise<Fit> {
  return page.evaluate((minTarget) => {
    const el = document.getElementById('player')!;
    const r = el.getBoundingClientRect();
    const outside: string[] = [];
    const small: string[] = [];
    const visible: string[] = [];
    for (const c of el.querySelectorAll<HTMLElement>('.lp-chrome [data-control]')) {
      const b = c.getBoundingClientRect();
      if (!b.width || !b.height || getComputedStyle(c).visibility === 'hidden') continue;
      const name = c.dataset.control!;
      visible.push(name);
      if (b.left < r.left - 1 || b.right > r.right + 1 || b.top < r.top - 1 || b.bottom > r.bottom + 1) outside.push(name);
      if (c.matches('.lp-btn') && (b.height < minTarget - 0.5 || b.width < minTarget - 0.5)) small.push(`${name} ${b.width}x${b.height}`);
    }
    const bar = el.querySelector<HTMLElement>('.lp-seekbar');
    return {
      size: el.dataset.size,
      short: el.hasAttribute('data-short'),
      touch: el.hasAttribute('data-touch'),
      outside,
      small,
      visible,
      seekWidth: bar ? bar.getBoundingClientRect().width : 0,
      width: r.width,
    };
  }, minTarget);
}

const screens = [
  { name: 'phone, upright', viewport: { width: 375, height: 812 } },
  { name: 'small phone, upright', viewport: { width: 320, height: 568 } },
  { name: 'phone, sideways', viewport: { width: 812, height: 375 } },
  { name: 'tablet, upright', viewport: { width: 768, height: 1024 } },
];

for (const screen of screens) {
  test.describe(`${screen.name} (${screen.viewport.width}x${screen.viewport.height})`, () => {
    test.use({ viewport: screen.viewport, hasTouch: true, isMobile: true });

    test('every skin keeps its controls on screen, reachable and finger-sized', async ({ page }) => {
      const errors = await openApp(page, { sidebar: undefined });
      await load(page, 'h264_aac_long.mp4', { autoplay: false });
      await page.evaluate(() => window.ui.loadSkin('/skins/neon.json', false));
      for (const skin of ['glass', 'mpv', 'studio', 'neon']) {
        await page.evaluate((id) => window.ui.setSkin(id), skin);
        await expect(root(page)).toHaveAttribute('data-skin', skin);
        const m = await measure(page, skin === 'mpv' ? 34 : 40);
        const where = `${skin} on ${screen.name}`;
        expect(m.touch, `${where}: touch mode`).toBe(true);
        expect(m.outside, `${where}: controls outside the player`).toEqual([]);
        expect(m.small, `${where}: targets smaller than a fingertip`).toEqual([]);
        expect(m.visible, `${where}: play`).toContain('play');
        expect(m.visible, `${where}: fullscreen`).toContain('fullscreen');
        expect(m.seekWidth, `${where}: seek bar width`).toBeGreaterThanOrEqual(Math.min(180, m.width * 0.4));
        // Whatever a compact layout hides must stay reachable through the overflow menu.
        if (m.size === 'compact' && skin !== 'neon') expect(m.visible, `${where}: overflow menu`).toContain('more');
      }
      expectNoErrors(errors);
    });
  });
}

test.describe('phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('tap shows and hides the controls, double tap seeks or pauses, and never both', async ({ page }) => {
    const errors = await openApp(page);
    await load(page, 'h264_aac_long.mp4', { autoplay: true });
    await waitForTime(page, 0.5);
    await recordPauses(page);
    const hidden = () => root(page).getAttribute('data-chrome');

    // Controls hide on their own while playing; a tap brings them back without pausing.
    await expect.poll(hidden, { timeout: 8000 }).toBe('hidden');
    const c = await stageCentre(page);
    await page.touchscreen.tap(c.x, c.y);
    await expect.poll(hidden).toBeNull();
    await page.waitForTimeout(450);
    expect(await pauses(page), 'a tap must not pause').toEqual([]);
    expect(await hidden(), 'still visible after the double-tap window').toBeNull();

    // A second tap puts them away again.
    await page.touchscreen.tap(c.x, c.y);
    await expect.poll(hidden).toBe('hidden');
    expect(await pauses(page)).toEqual([]);

    // Double tap on the right third: +10 s. On the left third: -10 s.
    const right = await stageCentre(page, 0.85);
    const t0 = await page.evaluate(() => window.player.currentTime);
    await page.touchscreen.tap(right.x, right.y);
    await page.touchscreen.tap(right.x, right.y);
    await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeGreaterThan(t0 + 9);
    const left = await stageCentre(page, 0.15);
    const t1 = await page.evaluate(() => window.player.currentTime);
    await page.touchscreen.tap(left.x, left.y);
    await page.touchscreen.tap(left.x, left.y);
    await expect.poll(() => page.evaluate(() => window.player.currentTime)).toBeLessThan(t1 - 5);
    await waitForStatus(page, 'playing');
    expect(await pauses(page), 'seeking by double tap must not pause').toEqual([]);

    // Double tap in the middle: play / pause. The centre button then resumes.
    await page.touchscreen.tap(c.x, c.y);
    await page.touchscreen.tap(c.x, c.y);
    await expect.poll(() => page.evaluate(() => window.player.store.state.paused)).toBe(true);
    const big = page.locator('.lp-big-play');
    await expect(big).toBeVisible();
    await big.tap();
    await expect.poll(() => page.evaluate(() => window.player.store.state.paused)).toBe(false);
    // While playing with touch input the same button stays available as a pause button.
    await expect(big).toHaveAttribute('data-state', 'playing');
    await expect(big).toBeVisible();
    expectNoErrors(errors);
  });

  test('the overflow menu opens as a bottom sheet and reaches the hidden controls', async ({ page }) => {
    const errors = await openApp(page);
    await load(page, 'h264_aac_long.mp4', { autoplay: false });
    await expect(root(page)).toHaveAttribute('data-size', 'compact');
    await expect(page.locator('[data-control="speed"]')).toBeHidden();

    await page.locator('[data-control="more"]').tap();
    const menu = page.locator('.lp-menu');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    const player = (await root(page).boundingBox())!;
    expect(box.width, 'sheet spans the player').toBeGreaterThan(player.width - 20);
    expect(Math.abs(box.y + box.height - (player.y + player.height - 8)), 'sheet sits on the bottom edge').toBeLessThan(2);

    // Submenu, and back again.
    await menu.locator('.lp-menu-item', { hasText: 'Playback speed' }).tap();
    await expect(menu.locator('.lp-menu-item', { hasText: 'Back' })).toBeVisible();
    await menu.locator('.lp-menu-item', { hasText: 'Back' }).tap();
    await expect(menu.locator('.lp-menu-item', { hasText: 'Decode pipeline' })).toBeVisible();
    await menu.locator('.lp-menu-item', { hasText: 'Playback speed' }).tap();
    await menu.locator('.lp-menu-item', { hasText: '1.5×' }).tap();
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => window.player.store.state.speed)).toBe(1.5);

    // Toggles keep the sheet open.
    await page.locator('[data-control="more"]').tap();
    await page.locator('.lp-menu-item', { hasText: 'Muted' }).tap();
    await expect(page.locator('.lp-menu-item', { hasText: 'Muted' })).toHaveAttribute('data-checked', 'true');
    expect(await page.evaluate(() => window.player.store.state.muted)).toBe(true);
    await page.locator('.lp-menu-item', { hasText: 'Stats for nerds' }).tap();
    await expect(page.locator('.lp-stats')).toBeVisible();
    expectNoErrors(errors);
  });

  test('the demo page keeps its sample list in a drawer', async ({ page }) => {
    const errors = await openApp(page, { sidebar: undefined });
    const drawer = page.locator('#drawer');
    const offScreen = async () => {
      const b = (await drawer.boundingBox())!;
      return b.x + b.width <= 1;
    };
    await expect.poll(offScreen).toBe(true);
    await page.locator('#drawer-tab').tap();
    await expect.poll(offScreen).toBe(false);
    await drawer.locator('button', { hasText: 'h264_aac.mp4' }).first().tap();
    await expect.poll(offScreen).toBe(true);
    await waitForStatus(page, ['playing', 'buffering']);
    await waitForTime(page, 0.3);
    expectNoErrors(errors);
  });
});

test('a wide desktop player keeps the full layout and mouse-sized controls', async ({ page }) => {
  const errors = await openApp(page);
  await load(page, 'h264_aac_long.mp4', { autoplay: false });
  for (const skin of ['glass', 'mpv', 'studio']) {
    await page.evaluate((id) => window.ui.setSkin(id), skin);
    const m = await measure(page, 0);
    expect(m.size, `${skin}: layout`).toBe('wide');
    expect(m.touch, `${skin}: touch mode`).toBe(false);
    expect(m.outside, `${skin}: controls outside the player`).toEqual([]);
    expect(m.visible, `${skin}: no overflow menu when everything fits`).not.toContain('more');
    expect(m.visible, `${skin}: speed menu`).toContain('speed');
  }
  // Narrowing the window switches to the compact layout and back, live.
  await page.setViewportSize({ width: 430, height: 720 });
  await expect(root(page)).toHaveAttribute('data-size', 'compact');
  await expect(page.locator('[data-control="more"]')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(root(page)).toHaveAttribute('data-size', 'wide');
  await expect(page.locator('[data-control="more"]')).toBeHidden();
  expectNoErrors(errors);
});
