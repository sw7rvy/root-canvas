import { test, expect, devices } from '@playwright/test';
import { luminanceVariance, settle, watchErrors } from './helpers';

/**
 * Emulation gives a real mobile viewport, device pixel ratio and touch input.
 * It does *not* give a mobile GPU, so nothing here can speak to fill rate or
 * driver limits — `diagnostics/` exists to answer those on real hardware.
 */
test.use({ ...devices['Pixel 7'] });

test('the pixel ratio cap holds on a high-DPI screen', async ({ page }) => {
  await page.goto('/tests/harness.html');

  const result = await page.evaluate(() => {
    const h = window.harness;
    h.reconfigure({ maxPixelRatio: 2 });
    h.createView('a', { taa: true });
    h.populate();
    h.frame();

    const composer = h.view!.composer!;
    const rect = h.view!.rect;

    return {
      devicePixelRatio: window.devicePixelRatio,
      applied: h.stage.core.pixelRatio,
      rendererRatio: h.stage.core.renderer.getPixelRatio(),
      target: [composer.composer.renderTarget1.width, composer.composer.renderTarget1.height],
      expected: [Math.round(rect.width * h.stage.core.pixelRatio), Math.round(rect.height * h.stage.core.pixelRatio)],
    };
  });

  expect(result.devicePixelRatio, 'the emulated screen is high-DPI').toBeGreaterThan(2);
  expect(result.applied, 'the cap is what limits it, not the device').toBe(2);
  expect(result.rendererRatio).toBe(2);
  expect(result.target, 'targets are sized by the capped ratio').toEqual(result.expected);
});

test('the canvas covers a mobile viewport and views track their anchors', async ({ page }) => {
  await page.goto('/tests/harness.html');

  const result = await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', { taa: true });
    h.populate();
    h.frame();

    const canvas = h.stage.core.canvas;
    return {
      canvas: [h.stage.core.size.x, h.stage.core.size.y],
      viewport: [window.innerWidth, window.innerHeight],
      fixed: getComputedStyle(canvas).position,
      onScreen: h.view!.onScreen,
      rect: [Math.round(h.view!.rect.width), Math.round(h.view!.rect.height)],
    };
  });

  expect(result.canvas).toEqual(result.viewport);
  expect(result.fixed).toBe('fixed');
  expect(result.onScreen).toBe(true);
  expect(result.rect[0]).toBeGreaterThan(0);
});

test('touch input reaches the view as pointer events', async ({ page }) => {
  await page.goto('/tests/harness.html');

  await page.evaluate(() => {
    const h = window.harness;
    const view = h.createView('a', { taa: true });
    h.populate();
    h.frame();

    (window as unknown as { hits: string[] }).hits = [];
    view.on('pointerdown', () => (window as unknown as { hits: string[] }).hits.push('down'));
    view.on('pointerup', () => (window as unknown as { hits: string[] }).hits.push('up'));
  });

  await page.tap('#a');

  const hits = await page.evaluate(() => (window as unknown as { hits: string[] }).hits);
  expect(hits, 'a tap produces pointer events on the view').toContain('down');
});

test('the full chain renders under mobile emulation', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/tests/harness.html');

  await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', { depthTexture: true, taa: true, passes: window.ssao({ radius: 0.5 }) }, 0x101820);
    h.populate();
    h.frame();
    h.frame();
  });

  await settle(page);
  const variance = luminanceVariance(await page.screenshot({ clip: { x: 20, y: 20, width: 300, height: 220 } }));

  expect(errors).toEqual([]);
  expect(variance, 'geometry drew at mobile dimensions').toBeGreaterThan(20);
});

test('capabilities are detected rather than assumed', async ({ page }) => {
  await page.goto('/tests/harness.html');

  const caps = await page.evaluate(() => {
    window.harness.createView('a');
    return window.capabilities();
  });

  expect(caps.maxSamples, 'MSAA support is read from the driver').toBeGreaterThanOrEqual(0);
  expect(caps.maxTextureSize).toBeGreaterThan(0);
  expect(typeof caps.halfFloatTargets).toBe('boolean');
});

test('a device without half-float targets falls back instead of failing', async ({ page }) => {
  await page.goto('/tests/harness.html');

  const result = await page.evaluate(() => {
    // pretend the extension is missing, the way an older mobile driver would
    const gl = window.harness.stage.core.renderer.getContext();
    const original = gl.getExtension.bind(gl);
    (gl as { getExtension: unknown }).getExtension = (name: string) =>
      name.startsWith('EXT_color_buffer') ? null : original(name);

    const detected = window.detectCapabilities(window.harness.stage.core.renderer);
    const type = window.preferredTargetType();
    const samples = window.clampSamples(8);

    (gl as { getExtension: unknown }).getExtension = original;
    window.detectCapabilities(window.harness.stage.core.renderer);

    return { halfFloatTargets: detected.halfFloatTargets, type, samples, unsignedByte: window.THREE.UnsignedByteType };
  });

  expect(result.halfFloatTargets, 'the probe saw no half-float support').toBe(false);
  expect(result.type, 'targets fall back to 8-bit').toBe(result.unsignedByte);
  expect(result.samples, 'samples are clamped to what the driver reports').toBeLessThanOrEqual(8);
});
