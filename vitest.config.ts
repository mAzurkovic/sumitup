import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // End-to-end specs run in Playwright against a real browser.
    exclude: ['tests/e2e/**', 'node_modules/**'],
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      thresholds: { lines: 100, branches: 100, statements: 100 },
    },
  },
});
