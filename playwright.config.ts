import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/build.ts',
  // Every test shares one fake provider on a fixed port, so tests run one at a time.
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'list',
});
