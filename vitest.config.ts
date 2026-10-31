import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      thresholds: { lines: 100, branches: 100, statements: 100 },
    },
  },
});
