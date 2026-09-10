import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5199',
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5199 --strictPort',
    url: 'http://localhost:5199/tests/harness.html',
    env: { VITE_NO_HMR: '1' },
    // never reuse a server that might have HMR on, or the first evaluate after
    // an edit races a reload
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
