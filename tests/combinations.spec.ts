import { test, expect, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

const ANCHOR = { x: 20, y: 20, width: 400, height: 300 };

/**
 * A blank or silently-failing chain renders a flat rectangle. Real geometry
 * spreads luminance out, so variance separates "drew something" from "drew
 * nothing" without depending on where any particular object lands.
 */
function luminanceVariance(buffer: Buffer): number {
  const png = PNG.sync.read(buffer);
  const samples: number[] = [];

  for (let i = 0; i < png.data.length; i += 4) {
    samples.push(0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!);
  }

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  return samples.reduce((total, value) => total + (value - mean) ** 2, 0) / samples.length;
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe('option combinations render without error', () => {
  const combinations: Array<{ name: string; effects?: Record<string, unknown>; clearColor?: number }> = [
    { name: 'no effects at all' },
    { name: 'effects with an opaque clear colour', effects: { taa: true }, clearColor: 0x101820 },
    { name: 'MSAA together with a depth texture', effects: { samples: 4, depthTexture: true } },
    { name: 'TAA at a reduced resolution scale', effects: { taa: true, resolutionScale: 0.5 } },
    { name: 'TAA with the velocity buffer disabled', effects: { taa: { velocity: false } } },
    { name: 'preserveAlpha stacked with TAA', effects: { preserveAlpha: true, taa: true } },
    { name: 'no output pass', effects: { output: false } },
    { name: 'blending disabled', effects: { blend: false } },
    { name: 'stencil disabled for the view', effects: { stencil: false, taa: true } },
    {
      name: 'everything at once',
      effects: { taa: true, preserveAlpha: true, samples: 4, depthTexture: true },
    },
  ];

  for (const { name, effects, clearColor } of combinations) {
    test(name, async ({ page }) => {
      const errors = watchErrors(page);
      await page.goto('/tests/harness.html');

      await page.evaluate(
        ({ viewEffects, viewClearColor }) => {
          const h = window.harness;
          h.createView('a', viewEffects as never, viewClearColor as never);
          h.populate();
          h.frame();
          h.frame();
        },
        { viewEffects: effects, viewClearColor: clearColor },
      );

      const variance = luminanceVariance(await page.screenshot({ clip: ANCHOR }));

      expect(errors, 'no shader or runtime errors').toEqual([]);
      expect(variance, `the view drew geometry, got variance ${variance.toFixed(1)}`).toBeGreaterThan(20);
    });
  }
});

test('an orthographic camera drives jitter, depth and velocity', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/tests/harness.html');

  const peak = await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', { taa: true, depthTexture: true, passes: window.ssao({ radius: 0.5 }) }, undefined, true);
    h.populate();
    h.frame();
    h.frame();
    h.move('rigid');
    h.frame();
    return h.peakVelocity();
  });

  const variance = luminanceVariance(await page.screenshot({ clip: ANCHOR }));

  expect(errors).toEqual([]);
  expect(variance, 'the orthographic view rendered').toBeGreaterThan(20);
  expect(peak, 'motion vectors work under an orthographic projection').toBeGreaterThan(5e-3);
});

test('a stencil mask coexists with TAA', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/tests/harness.html');

  await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', { taa: true, passes: window.maskedDotScreen() }, 0x101820);
    h.populate();
    h.frame();
    h.frame();
  });

  const variance = luminanceVariance(await page.screenshot({ clip: ANCHOR }));

  expect(errors).toEqual([]);
  expect(variance, 'the masked chain rendered').toBeGreaterThan(20);
});

test('resolutionScale shrinks every target in the chain', async ({ page }) => {
  await page.goto('/tests/harness.html');

  const sizes = await page.evaluate(() => {
    window.harness.createView('a', { taa: true, resolutionScale: 0.5 });
    window.harness.populate();
    window.harness.frame();

    const composer = window.harness.view!.composer!;
    const rect = window.harness.view!.rect;
    const ratio = window.harness.stage.core.pixelRatio;

    return {
      expected: [Math.round(rect.width * ratio * 0.5), Math.round(rect.height * ratio * 0.5)],
      composer: [composer.composer.renderTarget1.width, composer.composer.renderTarget1.height],
      velocity: [composer.taaPass!.velocity!.target.width, composer.taaPass!.velocity!.target.height],
    };
  });

  expect(sizes.composer, 'composer targets follow the scale').toEqual(sizes.expected);
  expect(sizes.velocity, 'the velocity buffer follows too').toEqual(sizes.expected);
});

test('an off-screen view is skipped entirely', async ({ page }) => {
  await page.goto('/tests/harness.html');

  const result = await page.evaluate(() => {
    const h = window.harness;
    const onScreen = h.createView('a', { taa: true });
    h.populate();
    const offScreen = h.stage.createView({
      element: document.getElementById('far')!,
      effects: { taa: true },
    });

    h.frame();

    return {
      onScreen: { visible: onScreen.onScreen, built: onScreen.composer !== null },
      offScreen: { visible: offScreen.onScreen, built: offScreen.composer !== null },
    };
  });

  expect(result.onScreen).toEqual({ visible: true, built: true });
  expect(result.offScreen.visible, 'the far anchor is below the fold').toBe(false);
  expect(result.offScreen.built, 'a skipped view allocates nothing').toBe(false);
});
