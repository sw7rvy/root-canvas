import { test, expect } from '@playwright/test';
import { distance, samplePixel, settle } from './helpers';

/** The harness page background — anything that shows through must match it. */
const PAGE_BACKGROUND = { r: 0xd8, g: 0x1b, b: 0x60 };

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
});

test('a view with no clear colour lets the page show through', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.harness;
    h.createView('a');
    h.populate();
    h.frame();
  });

  // top-left of the anchor: inside the view, away from any geometry
  await settle(page);
  const shot = await page.screenshot({ clip: { x: 20, y: 20, width: 40, height: 40 } });
  const pixel = samplePixel(shot, 20, 20);

  expect(distance(pixel, PAGE_BACKGROUND), `empty view area should be the page colour, got ${JSON.stringify(pixel)}`).toBeLessThan(12);
});

test('a view with a clear colour paints over the page', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', undefined, 0x101820);
    h.populate();
    h.frame();
  });

  await settle(page);
  const shot = await page.screenshot({ clip: { x: 20, y: 20, width: 40, height: 40 } });
  const pixel = samplePixel(shot, 20, 20);

  expect(distance(pixel, PAGE_BACKGROUND), 'the clear colour must hide the page').toBeGreaterThan(60);
});

test('a pass that flattens alpha hides the page without preserveAlpha', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', { passes: window.alphaDestroyingPass() });
    h.populate();
    h.frame();
  });

  await settle(page);
  const shot = await page.screenshot({ clip: { x: 20, y: 20, width: 40, height: 40 } });
  const pixel = samplePixel(shot, 20, 20);

  expect(
    distance(pixel, PAGE_BACKGROUND),
    'this is the failure mode preserveAlpha exists to fix',
  ).toBeGreaterThan(60);
});

test('preserveAlpha rescues a chain that flattens alpha', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', { preserveAlpha: true, passes: window.alphaDestroyingPass() });
    h.populate();
    h.frame();
  });

  await settle(page);
  const shot = await page.screenshot({ clip: { x: 20, y: 20, width: 40, height: 40 } });
  const pixel = samplePixel(shot, 20, 20);

  expect(
    distance(pixel, PAGE_BACKGROUND),
    `the page must show through again, got ${JSON.stringify(pixel)}`,
  ).toBeLessThan(12);
});

test('each view is scissored to its own anchor', async ({ page }) => {
  await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', undefined, 0x101820);
    h.populate();
    h.frame();
  });

  // the gap between anchor "a" (ends at y=320) and anchor "b" (starts at y=340)
  await settle(page);
  const shot = await page.screenshot({ clip: { x: 200, y: 325, width: 10, height: 10 } });
  const pixel = samplePixel(shot, 5, 5);

  expect(
    distance(pixel, PAGE_BACKGROUND),
    `the gap between anchors must stay untouched, got ${JSON.stringify(pixel)}`,
  ).toBeLessThan(12);
});
