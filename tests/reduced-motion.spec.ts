import { test, expect, type Page } from '@playwright/test';
import { luminanceVariance, settle, watchErrors } from './helpers';

const ANCHOR = { x: 20, y: 20, width: 400, height: 300 };

/** Runs the real loop briefly and reports whether animated time advanced. */
async function runLoop(page: Page, options?: Record<string, unknown>): Promise<{ elapsed: number; frames: number }> {
  return page.evaluate(async (stageOptions) => {
    const h = window.harness;
    if (stageOptions) h.reconfigure(stageOptions as never);

    h.createView('a', { taa: true });
    h.populate();

    let frames = 0;
    const stop = h.stage.onAfterRender(() => {
      frames += 1;
    });

    h.stage.start();
    await new Promise((resolve) => setTimeout(resolve, 350));
    h.stage.stop();
    stop();

    return { elapsed: h.stage.elapsed, frames };
  }, options);
}

test('animated time advances normally by default', async ({ page }) => {
  await page.goto('/tests/harness.html');
  const result = await runLoop(page);

  expect(result.frames, 'the loop ran').toBeGreaterThan(0);
  expect(result.elapsed, 'time accumulates').toBeGreaterThan(0);
});

test('a reduced-motion preference freezes animated time', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tests/harness.html');

  const result = await runLoop(page);

  expect(result.frames, 'rendering continues so views stay glued to their anchors').toBeGreaterThan(0);
  expect(result.elapsed, 'but nothing driven by delta or elapsed moves').toBe(0);
});

test('reduced motion keeps drawing rather than blanking the view', async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tests/harness.html');

  await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', { taa: true }, 0x101820);
    h.populate();
    h.frame();
    h.frame();
  });

  await settle(page);
  const variance = luminanceVariance(await page.screenshot({ clip: ANCHOR }));

  expect(errors).toEqual([]);
  expect(variance, 'the frozen scene is still visible').toBeGreaterThan(20);
});

test('the ignore policy opts out of the preference', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/tests/harness.html');

  const result = await runLoop(page, { reducedMotion: 'ignore' });

  expect(result.elapsed, 'an opted-out stage keeps animating').toBeGreaterThan(0);
});

test('the state can be forced and handed back to the viewer', async ({ page }) => {
  await page.goto('/tests/harness.html');

  const result = await page.evaluate(() => {
    const h = window.harness;
    h.createView('a');

    const initial = h.stage.reducedMotion;
    h.stage.setReducedMotion(true);
    const forcedOn = h.stage.reducedMotion;
    h.stage.setReducedMotion(false);
    const forcedOff = h.stage.reducedMotion;
    h.stage.setReducedMotion(null);

    return { initial, forcedOn, forcedOff, released: h.stage.reducedMotion };
  });

  expect(result).toEqual({ initial: false, forcedOn: true, forcedOff: false, released: false });
});

test('the preference is picked up live, without a reload', async ({ page }) => {
  await page.goto('/tests/harness.html');

  const before = await page.evaluate(() => {
    window.harness.createView('a');
    return window.harness.stage.reducedMotion;
  });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const after = await page.evaluate(() => window.harness.stage.reducedMotion);

  expect(before).toBe(false);
  expect(after, 'the media query is read live').toBe(true);
});
