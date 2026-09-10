import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/harness.html');
});

test('every view shares one canvas and one context', async ({ page }) => {
  const result = await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', { taa: true });
    h.populate();
    h.createView('b', { depthTexture: true, passes: window.ssao({ radius: 0.4 }) });
    h.frame();

    return {
      canvases: document.querySelectorAll('canvas').length,
      views: h.stage.views.all.length,
      composers: h.stage.views.all.filter((v) => v.composer !== null).length,
    };
  });

  expect(result.canvases).toBe(1);
  expect(result.views).toBe(2);
  expect(result.composers, 'both views built their own chain').toBe(2);
});

test('disposal returns GPU memory to zero', async ({ page }) => {
  const result = await page.evaluate(() => {
    const h = window.harness;
    h.createView('a', { taa: true, depthTexture: true, passes: window.ssao({ radius: 0.4 }) });
    h.populate();
    h.frame();
    h.frame();

    const before = h.memory();
    h.destroy();
    return { before, after: h.memory() };
  });

  expect(result.before.geometries, 'the scene allocated something to free').toBeGreaterThan(0);
  expect(result.before.textures).toBeGreaterThan(0);
  expect(result.after).toEqual({ geometries: 0, textures: 0, canvases: 0 });
});

test('removing a view frees its resources but leaves the stage running', async ({ page }) => {
  const result = await page.evaluate(() => {
    const h = window.harness;
    const view = h.createView('a', { taa: true });
    h.populate();
    h.frame();
    h.frame();

    const before = h.memory();
    h.stage.removeView(view);
    const after = h.memory();

    return { before, after, destroyed: h.stage.isDestroyed, canvases: after.canvases };
  });

  expect(result.after.textures).toBeLessThan(result.before.textures);
  expect(result.after.geometries).toBeLessThan(result.before.geometries);
  expect(result.destroyed, 'the stage survives a view removal').toBe(false);
  expect(result.canvases, 'the shared canvas is untouched').toBe(1);
});

test('context loss stops the loop and restore discards temporal history', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = window.harness;
    h.createView('a', { taa: true });
    h.populate();

    // step frames by hand: a software renderer on CI may only manage one or two
    // per animation frame, which makes any wall-clock frame count meaningless
    for (let i = 0; i < 5; i += 1) h.frame();
    const framesBefore = h.view!.composer!.taaPass!.frame;

    h.stage.start();
    await new Promise((r) => setTimeout(r, 100));
    h.loseContext();
    await new Promise((r) => setTimeout(r, 400));
    const lost = { contextLost: h.stage.core.contextLost, running: h.stage.isRunning };

    h.restoreContext();
    for (let i = 0; i < 40 && h.frameAtRestore < 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    h.stage.stop();

    return {
      framesBefore,
      lost,
      frameAtRestore: h.frameAtRestore,
      contextLost: h.stage.core.contextLost,
    };
  });

  expect(result.framesBefore, 'TAA accumulated history before the loss').toBeGreaterThan(0);
  expect(result.lost).toEqual({ contextLost: true, running: false });
  expect(result.contextLost).toBe(false);
  expect(result.frameAtRestore, 'the restore handler ran').toBeGreaterThanOrEqual(0);
  expect(result.frameAtRestore, 'stale history is discarded on restore').toBe(0);
});

test('composer targets follow the anchor size', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = window.harness;
    h.createView('a', { taa: true });
    h.populate();
    h.frame();

    const composer = h.view!.composer!.composer;
    const before = [composer.renderTarget1.width, composer.renderTarget1.height];

    document.getElementById('a')!.style.width = '250px';
    document.getElementById('a')!.style.height = '160px';
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    h.frame();

    const ratio = h.stage.core.pixelRatio;
    return {
      before,
      after: [composer.renderTarget1.width, composer.renderTarget1.height],
      expected: [250 * ratio, 160 * ratio],
    };
  });

  expect(result.after).not.toEqual(result.before);
  expect(result.after).toEqual(result.expected);
});
