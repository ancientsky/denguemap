// Backtest of the forecast model (npm run backtest): slow, writes files, so not part of `npm test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/backtest/**/*.run.mjs'], environment: 'node', testTimeout: 1_800_000 },
});
