import { test, expect, type Page } from '@playwright/test';

type MotionSource = 'rigid' | 'skinned' | 'instanced' | 'morphed' | 'instancedMorph' | 'batched';

/**
 * Two deterministic frames: one to seed the previous-state mirrors, one after
 * mutating a single motion source. Whatever the velocity buffer holds is
 * attributable to that source alone.
 */
async function velocityAfterMoving(page: Page, source: MotionSource | null): Promise<number> {
  return page.evaluate((moved) => {
    const h = window.harness;
    h.frame();
    h.frame();
    if (moved) h.move(moved as never);
    h.frame();
    return h.peakVelocity();
  }, source);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  (page as Page & { __errors: string[] }).__errors = errors;

  await page.goto('/tests/harness.html');
  await page.evaluate(() => {
    window.harness.createView('a', { taa: true });
    window.harness.populate();
  });
});

test.afterEach(async ({ page }) => {
  const errors = (page as Page & { __errors?: string[] }).__errors ?? [];
  expect(errors, 'no console or page errors').toEqual([]);
});

test('a still scene produces no motion', async ({ page }) => {
  expect(await velocityAfterMoving(page, null)).toBeLessThan(1e-3);
});

const sources: MotionSource[] = ['rigid', 'skinned', 'instanced', 'morphed', 'instancedMorph', 'batched'];

for (const source of sources) {
  test(`velocity buffer records ${source} motion`, async ({ page }) => {
    const peak = await velocityAfterMoving(page, source);
    expect(peak, `${source} should register screen-space motion`).toBeGreaterThan(5e-3);
  });
}

test('velocity is only written where geometry was drawn', async ({ page }) => {
  const coverage = await page.evaluate(() => {
    const h = window.harness;
    h.frame();
    h.frame();

    const velocity = h.view!.composer!.taaPass!.velocity!;
    const { width, height } = velocity.target;
    const buffer = new Uint16Array(width * height * 4);
    h.stage.core.renderer.readRenderTargetPixels(velocity.target, 0, 0, width, height, buffer);

    let written = 0;
    for (let i = 2; i < buffer.length; i += 4) {
      // half-float 1.0 is 0x3c00; the mask channel is written as exactly 1 or 0
      if (buffer[i] === 0x3c00) written += 1;
    }

    return { written, total: width * height };
  });

  expect(coverage.written, 'geometry covers part of the frame').toBeGreaterThan(0);
  expect(coverage.written, 'background is left unwritten').toBeLessThan(coverage.total);
});
