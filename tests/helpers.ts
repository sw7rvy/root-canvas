import type { Page } from '@playwright/test';
import { PNG } from 'pngjs';

export type Rgb = { r: number; g: number; b: number };

/**
 * `renderOnce()` draws synchronously, but the canvas is only handed to the
 * compositor on the next frame — screenshotting before that can capture the
 * previous contents. Two animation frames guarantee presentation.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

export function samplePixel(buffer: Buffer, x: number, y: number): Rgb {
  const png = PNG.sync.read(buffer);
  const index = (png.width * y + x) * 4;
  return { r: png.data[index]!, g: png.data[index + 1]!, b: png.data[index + 2]! };
}

export function distance(a: Rgb, b: Rgb): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

function luminances(buffer: Buffer): number[] {
  const png = PNG.sync.read(buffer);
  const values: number[] = [];

  for (let i = 0; i < png.data.length; i += 4) {
    values.push(0.2126 * png.data[i]! + 0.7152 * png.data[i + 1]! + 0.0722 * png.data[i + 2]!);
  }

  return values;
}

export function meanLuminance(buffer: Buffer): number {
  const values = luminances(buffer);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * A blank or silently-failing chain renders a flat rectangle. Real geometry
 * spreads luminance out, so variance separates "drew something" from "drew
 * nothing" without depending on where any particular object lands.
 */
export function luminanceVariance(buffer: Buffer): number {
  const values = luminances(buffer);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
}

export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}
