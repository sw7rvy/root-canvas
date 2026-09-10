import { chromium } from '@playwright/test';

const URL = process.env.BENCH_URL ?? 'http://localhost:5199/tests/harness.html';
const FRAMES = Number(process.env.BENCH_FRAMES ?? 120);
const HEAVY = process.env.BENCH_HEAVY === '1';

const CONFIGS = [
  { name: 'no effects', effects: undefined },
  { name: 'composer only', effects: {} },
  { name: 'SSAO', effects: { depthTexture: true, ssao: true } },
  { name: 'TAA, no velocity', effects: { taa: { velocity: false } } },
  { name: 'TAA + velocity', effects: { taa: true } },
  { name: 'SSAO + TAA + velocity', effects: { depthTexture: true, taa: true, ssao: true } },
  { name: 'MSAA 4x alone', effects: { samples: 4 } },
  { name: 'MSAA 4x + depth texture', effects: { samples: 4, depthTexture: true } },
  { name: 'everything + MSAA 4x', effects: { depthTexture: true, taa: true, ssao: true, samples: 4 } },
  { name: 'everything at 0.5 scale', effects: { depthTexture: true, taa: true, ssao: true, resolutionScale: 0.5 } },
];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader'],
});

const page = await browser.newPage({ viewport: { width: 900, height: 800 }, deviceScaleFactor: 1 });
const rows = [];
let gpu = 'unknown';

for (const config of CONFIGS) {
  await page.goto(URL);

  const result = await page.evaluate(
    ({ effects, frames, heavy }) => {
      const h = window.harness;
      const options = effects ? { ...effects } : undefined;

      if (options && 'ssao' in options) {
        delete options.ssao;
        options.passes = window.ssao({ radius: 0.5 });
      }

      h.createView('a', options, 0x101820);
      if (heavy) h.populateHeavy();
      else h.populate();

      const stats = h.bench(frames);
      return { gpu: h.renderer(), ...stats, bytes: h.targetBytes() };
    },
    { effects: config.effects, frames: FRAMES, heavy: HEAVY },
  );

  gpu = result.gpu;
  rows.push({ name: config.name, ...result });
}

// how cost scales with view count, all running the full chain
await page.goto(URL);
const fps = await page.evaluate(
  async ({ heavy }) => {
    const h = window.harness;
    h.createView('a', { depthTexture: true, taa: true, passes: window.ssao({ radius: 0.5 }) }, 0x101820);
    if (heavy) h.populateHeavy(120);
    else h.populate();
    return h.throughput(2000);
  },
  { heavy: HEAVY },
);

await page.goto(URL);
const fourViews = await page.evaluate(
  ({ frames, heavy }) => {
    const h = window.harness;
    for (const anchor of ['a', 'b']) {
      h.createView(anchor, { depthTexture: true, taa: true, passes: window.ssao({ radius: 0.5 }) }, 0x101820);
      if (heavy) h.populateHeavy();
      else h.populate();
    }
    return h.bench(frames);
  },
  { frames: FRAMES, heavy: HEAVY },
);

await browser.close();

const baseline = rows[0].median;
const pad = (value, width) => String(value).padStart(width);

console.log(`\nGPU: ${gpu}`);
console.log(`Viewport 900x800, one 400x300 view, ${FRAMES} timed frames, DPR 1\n`);
console.log(`Scene: ${rows[0].triangles.toLocaleString()} triangles, ${rows[0].calls} draws
`);
console.log('| configuration | median ms | vs baseline | draws | target MB |');
console.log('| --- | ---: | ---: | ---: | ---: |');

for (const row of rows) {
  console.log(
    `| ${row.name} | ${pad(row.median.toFixed(2), 6)} | ` +
      `${pad((row.median / baseline).toFixed(2) + 'x', 7)} | ${pad(row.calls, 5)} | ` +
      `${pad((row.bytes / 1024 / 1024).toFixed(1), 5)} |`,
  );
}

const full = rows.find((row) => row.name === 'SSAO + TAA + velocity');
console.log(
  `\nTwo views on the full chain: ${fourViews.median.toFixed(2)} ms median ` +
    `(${(fourViews.median / full.median).toFixed(2)}x one view), ${fourViews.calls} draws`,
);
console.log(`Sustained frame rate under the real loop, full chain: ${fps.toFixed(0)} fps`);
