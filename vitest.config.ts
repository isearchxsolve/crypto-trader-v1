import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    isolate: true,
    exclude: [
      'test/failsafe.test.cjs',   // uses node:test, not vitest
      'tests/newMintGate.test.ts', // uses node:assert + custom runner, not vitest
      // 'routes.test.ts' REMOVED from exclude — now fully mockable (storage + jupiter + fetch mocked)
      'node_modules/**',
      'dist/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/**', 'vitest.config.ts', 'tests/**']
    }
  }
});