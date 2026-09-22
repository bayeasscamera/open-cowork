import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Resolve Electron to a stable test double so CI does not depend on the
    // postinstall-generated `node_modules/electron/path.txt` file.
    alias: {
      electron: path.resolve(import.meta.dirname, './tests/mocks/electron.ts'),
    },
    server: {
      deps: {
        inline: ['electron-store'],
      },
    },
    include: ['src/**/*.{test,spec}.{js,ts}', 'tests/**/*.{test,spec}.{js,ts}'],
    exclude: ['node_modules', 'dist', 'dist-electron', '.claude'],
    coverage: {
      provider: 'v8',
      // text: human-readable table in CI logs; json-summary: machine-readable for badge tools
      reporter: ['text', 'text-summary', 'json', 'json-summary', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'dist-electron/',
        'src/renderer/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData',
      ],
      // Ratcheted to just under the measured baseline (≈54.7% lines / 47.4%
      // branches / 62.7% functions / 54.5% statements) so regressions fail CI
      // instead of being tolerated down to the old 30/35/28/30 floor.
      thresholds: {
        lines: 52,
        functions: 60,
        branches: 45,
        statements: 52,
      },
    },
    mockReset: true,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
