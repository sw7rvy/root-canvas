import { test, expect, type Page } from '@playwright/test';
import { meanLuminance, settle } from './helpers';

const ANCHOR = { x: 20, y: 20, width: 400, height: 300 };

async function renderWithAO(page: Page, options: Record<string, number>): Promise<number> {
  await page.goto('/tests/harness.html');
  await page.evaluate((ssaoOptions) => {
    const h = window.harness;
    h.createView('a', { depthTexture: true, passes: window.ssao(ssaoOptions) }, 0x808080);
    h.populate();
    h.frame();
  }, options);

  await settle(page);
  return meanLuminance(await page.screenshot({ clip: ANCHOR }));
}

test('ambient occlusion darkens the scene', async ({ page }) => {
  const withoutAO = await renderWithAO(page, { radius: 0.5, intensity: 0 });
  const withAO = await renderWithAO(page, { radius: 0.5, intensity: 1 });

  expect(withAO, `AO must remove light, got ${withAO.toFixed(1)} vs ${withoutAO.toFixed(1)}`).toBeLessThan(
    withoutAO - 1,
  );
});

test('a higher contrast exponent occludes more', async ({ page }) => {
  const flat = await renderWithAO(page, { radius: 0.5, intensity: 1, power: 1 });
  const steep = await renderWithAO(page, { radius: 0.5, intensity: 1, power: 4 });

  // pow(ao, power) with ao <= 1 is monotonic in power, unlike radius, which can
  // *reduce* occlusion once samples start landing on the background
  expect(steep, `steeper falloff should darken further, got ${steep.toFixed(1)} vs ${flat.toFixed(1)}`).toBeLessThan(
    flat - 1,
  );
});

test('occlusion stays off the background', async ({ page }) => {
  await page.goto('/tests/harness.html');
  await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', { depthTexture: true, passes: window.ssao({ radius: 1.2, output: 'ao' }) }, 0x000000);
    h.populate();
    h.frame();
  });

  // An unoccluded AO of 1.0 still passes through ACES and sRGB before it
  // reaches a screenshot, landing near 226 — that is fixed maths, so it holds
  // across GPUs, unlike a scene-dependent average.
  await settle(page);
  const corner = meanLuminance(await page.screenshot({ clip: { x: 24, y: 24, width: 12, height: 12 } }));

  expect(corner, `empty space must read as unoccluded, got ${corner.toFixed(1)}`).toBeGreaterThan(220);
});
