import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import { resolve } from 'path';
import { builtinModules } from 'module';
import { execSync } from 'child_process';

/**
 * Build staleness guard.
 *
 * Bakes the built revision and timestamp into the bundle so Settings → General
 * can show which commit the RUNNING app was built from. Without it a stale
 * /Applications install silently keeps old UI — historically the most frequent
 * cause of "the feature is missing from the installed app".
 */
function readBuildStamp(): { sha: string; time: string } {
  const time = new Date().toISOString();
  const fromCi = process.env.GITHUB_SHA?.slice(0, 7);
  if (fromCi) return { sha: fromCi, time };
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return { sha: sha || 'unknown', time };
  } catch {
    // No git available (e.g. building from a tarball) — never fail the build.
    return { sha: 'unknown', time };
  }
}

const buildStamp = readBuildStamp();

// Node built-in modules must be external for Electron main process
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);
// Keep the SDK's module boundary: bundling it makes Rollup's CJS namespace
// helper crash on inherited enumerable exports from the external `ws` package.
const googleGenAiExternals = ['@google/genai', /^@google\/genai\//];
const mcpExternals = [/^@modelcontextprotocol\/(?:client|core|server)(?:\/.*)?$/];
// mistral 2.x (pulled in by pi-ai 0.73) ships an OpenTelemetry integration it
// loads through a guarded dynamic import, and declares `@opentelemetry/api` as
// an OPTIONAL peer: the import sits in a try/catch and degrades to a no-op when
// the package is absent. It is absent here, so the bundler must not resolve
// named exports off it — that fails the build ("trace is not exported by
// __vite-optional-peer-dep..."). External keeps the lazy chunk's require, whose
// failure at load time is exactly the path mistral already handles.
const otelExternals = [/^@opentelemetry\/api(?:\/.*)?$/];
const ignoredWatchPaths = [
  '**/release/**',
  '**/dist/**',
  '**/dist-electron/**',
  '**/dist-wsl-agent/**',
  '**/dist-lima-agent/**',
  '**/dist-mcp/**',
];

export default defineConfig({
  plugins: [
    react(),
    // `vite-plugin-electron` forces `emptyOutDir: false` on its sub-builds,
    // because its entries all default to the SAME outDir and emptying would wipe
    // a sibling's output. The three entries below each own a distinct directory,
    // so that reason does not apply — and leaving the default in place made every
    // build append a fresh ~9 MB `index-<hash>.js` beside the previous ones.
    // Measured 2026-10-07: 21 stale main bundles (~190 MB) had accumulated in
    // `dist-electron/main`, and because electron-builder packages that directory
    // wholesale they shipped inside a 367 MB app.asar — over half the archive was
    // dead code from earlier builds. Each entry now empties its own directory.
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(args) {
          args.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron/main',
            emptyOutDir: true,
            rollupOptions: {
              external: [
                ...nodeBuiltins,
                ...googleGenAiExternals,
                'better-sqlite3',
                'bufferutil',
                'utf-8-validate',
                'electron',
                // Externalize large CJS-compatible main-process dependencies
                // NOTE: ESM-only packages (@mariozechner/pi-coding-agent, pi-ai, electron-store, uuid)
                // must stay bundled — CJS require() can't load them
                '@anthropic-ai/sdk',
                '@larksuiteoapi/node-sdk',
                'openai',
                ...mcpExternals,
                ...otelExternals,
                'electron-updater',
                'chokidar',
                'archiver',
                'ngrok',
                'ws',
                'glob',
                'dotenv',
                '@slack/bolt',
                '@slack/web-api',
              ],
              output: {
                // Ensure consistent interop for CJS/ESM
                interop: 'auto',
              },
            },
          },
        },
      },
      {
        // The run_code child, built as its OWN bundle.
        //
        // This must not be merged into the main bundle. The child contains the
        // only `new Function` in the codebase, and a merged bundle would put an
        // eval path back inside the main process - exactly what the
        // "never evaluates model-written code in main" guarantee forbids.
        // tests/eval-isolation.test.ts asserts the main entry graph cannot reach
        // this module, so a future merge attempt fails there too.
        entry: 'src/main/agent/run-code-child-main.ts',
        vite: {
          build: {
            outDir: 'dist-electron/run-code-child',
            emptyOutDir: true,
            rollupOptions: {
              output: {
                entryFileNames: 'index.js',
                format: 'cjs',
              },
              // esbuild is required at RUNTIME by the child to transpile, and it
              // is a native binary, so it stays external and is resolved from
              // node_modules at execution time. Inlining its CJS internals
              // breaks at runtime.
              external: [...nodeBuiltins, 'electron', 'esbuild'],
            },
          },
        },
      },
      {
        entry: 'src/preload/index.ts',
        onstart(args) {
          args.reload();
        },
        vite: {
          build: {
            outDir: 'dist-electron/preload',
            emptyOutDir: true,
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
  ],
  define: {
    __BUILD_SHA__: JSON.stringify(buildStamp.sha),
    __BUILD_TIME__: JSON.stringify(buildStamp.time),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    watch: {
      ignored: ignoredWatchPaths,
    },
  },
  build: {
    sourcemap: process.env.NODE_ENV !== 'production',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
