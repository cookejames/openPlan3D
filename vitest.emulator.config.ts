import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Emulator-backed tests (Firestore/Storage rules, cloud store). Run via `npm run test:emulator`.
export default defineConfig({
  plugins: base.plugins,
  resolve: base.resolve,
  test: {
    environment: 'node',
    include: ['tests/emulator/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
