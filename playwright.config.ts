import { defineConfig } from '@playwright/test';

const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    launchOptions: chromiumExecutable ? { executablePath: chromiumExecutable } : undefined,
    // Use a fixed viewport so screenshots are deterministic
    viewport: { width: 480, height: 320 },
    screenshot: 'off',
  },
  webServer: {
    command: 'npm run dev -- --port 5173',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  // Store screenshots in a dedicated directory
  outputDir: './test-results',
  snapshotDir: './test-snapshots',
});
