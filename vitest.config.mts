import { defineConfig } from 'vitest/config';
import os from 'os';
import path from 'path';

// Vitest sizes its worker pool from the machine: `cpus - 1` in run mode, half
// that in watch. On a many-core dev box that is 7 workers, and when the box is
// already busy the pool oversubscribes it. The symptom is not slowness but
// *false failures*: unrelated test files time out, and log files get read back
// empty, both traced to contention rather than to the code under review.
//
// Measured on this 8-core box: 8 workers uncapped, 4 capped. Capped runs came
// back green at 62-68s (load average 12-15); uncapped runs were faster (46s)
// only when the box was calm, and failed three times under sustained load at
// 83-105s. That is the trade — a slower run on an idle box, for a run that
// stops inventing failures on a busy one.
//
// The cap never exceeds what Vitest would have picked anyway, so 2-4 core CI
// runners keep exactly the worker count they have today. `VITEST_MAX_WORKERS`
// still wins: Vitest applies it after this config is resolved.
const MAX_WORKERS = 4;
const CPU_COUNT = os.availableParallelism();
const maxWorkers = Math.min(MAX_WORKERS, Math.max(CPU_COUNT - 1, 1));

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
      // Ratcheted to just under the measured baseline (≈56.4% lines / 48.5%
      // branches / 64.9% functions / 56.1% statements) so regressions fail CI
      // instead of being tolerated down to the old 30/35/28/30 floor.
      thresholds: {
        lines: 54,
        functions: 62.5,
        branches: 46,
        statements: 54,
      },
    },
    mockReset: true,
    restoreMocks: true,

    // Derived above from the core count; see the comment there.
    maxWorkers,

    // The 5s default stays for unit tests, so a genuine hang is still caught
    // fast. The E2E files raise it where the slow work actually lives.
    //
    // Tests that measure a real limit (the CPU-budget test waits out a 120s wall
    // clock) declare their own timeout and ignore both of these.
    testTimeout: 5_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
