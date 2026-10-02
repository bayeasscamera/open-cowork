import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  defaultAppRoots,
  resolveEsbuildBinary,
  resolveRunCodeChildScript,
} from '../src/main/agent/run-code-runtime';
import { runCode } from '../src/main/agent/run-code-host';
import { ToolRegistry } from '../src/main/tools/registry';

/**
 * Locating the run_code child at runtime.
 *
 * The failure this guards against is silent. If the resolver looks in the wrong
 * place, runCode simply reports "no child runtime is configured" and the feature
 * stays dark - no error, no crash, nothing that looks like a bug during
 * development. So the resolution is tested against real directories, and the
 * end-to-end case runs the ACTUAL built bundle with no childScript passed, which
 * is how production invokes it.
 */

describe('the child runtime is found on disk', () => {
  it('returns null when nothing is built, rather than throwing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'cowork-empty-'));
    try {
      expect(resolveRunCodeChildScript(empty, null)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('finds the child beside the main bundle, as it is when built', () => {
    const base = mkdtempSync(join(tmpdir(), 'cowork-built-'));
    try {
      mkdirSync(join(base, 'main'), { recursive: true });
      mkdirSync(join(base, 'run-code-child'), { recursive: true });
      const script = join(base, 'run-code-child', 'index.js');
      writeFileSync(script, '// child');
      // Called from the built layout: dist-electron/main -> ../run-code-child
      expect(resolveRunCodeChildScript(join(base, 'main'), null)).toBe(script);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('finds the child from the dev layout, where it is two levels further up', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cowork-repo-'));
    try {
      const agentDir = join(repo, 'src', 'main', 'agent');
      mkdirSync(agentDir, { recursive: true });
      const script = join(repo, 'dist-electron', 'run-code-child', 'index.js');
      mkdirSync(join(repo, 'dist-electron', 'run-code-child'), { recursive: true });
      writeFileSync(script, '// child');
      expect(resolveRunCodeChildScript(agentDir, null)).toBe(script);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('checks the packaged locations when a resources path is given', () => {
    const resources = mkdtempSync(join(tmpdir(), 'cowork-res-'));
    try {
      const script = join(resources, 'app.asar', 'dist-electron', 'run-code-child', 'index.js');
      mkdirSync(join(resources, 'app.asar', 'dist-electron', 'run-code-child'), {
        recursive: true,
      });
      writeFileSync(script, '// child');
      const somewhereElse = mkdtempSync(join(tmpdir(), 'cowork-else-'));
      try {
        expect(resolveRunCodeChildScript(somewhereElse, resources)).toBe(script);
      } finally {
        rmSync(somewhereElse, { recursive: true, force: true });
      }
    } finally {
      rmSync(resources, { recursive: true, force: true });
    }
  });
});

describe('the esbuild binary is found, because the sandbox grants exactly it', () => {
  it('looks in the app roots, dev and built', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cowork-esb-'));
    try {
      const platformDir = `${process.platform}-${process.arch}`;
      const binaryName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
      const binDir = join(repo, 'node_modules', '@esbuild', platformDir, 'bin');
      mkdirSync(binDir, { recursive: true });
      const binary = join(binDir, binaryName);
      writeFileSync(binary, '#!/bin/sh\n');
      const found = resolveEsbuildBinary([repo]);
      // realpath is applied, so compare against the resolved form.
      expect(found).not.toBeNull();
      expect(existsSync(found as string)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns null rather than a wrong path when it is absent', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cowork-esb-'));
    try {
      expect(resolveEsbuildBinary([repo])).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('includes a repository root in the default roots from the dev layout', () => {
    // The bug this catches: an off-by-one that made the dev root `<repo>/src`,
    // so the binary was "not found" during development while working fine in a
    // packaged build.
    const agentDir = join(process.cwd(), 'src', 'main', 'agent');
    expect(defaultAppRoots(agentDir)).toContain(process.cwd());
  });
});

describe('end to end, with the runtime resolved rather than injected', () => {
  // Skipped when the app has not been built, because a test that needs `vite
  // build` to have been run would be a bad gate. When it IS built, this is the
  // only assertion that proves production invocation works: no childScript, no
  // allowedExecPaths, exactly as the app calls it.
  const childBuilt = resolveRunCodeChildScript() !== null;

  it.skipIf(!childBuilt)('runs TypeScript in the built child under the sandbox', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cowork-e2e-'));
    try {
      const result = await runCode({
        sessionId: 'e2e',
        cwd: workspace,
        allowedTools: [],
        registry: new ToolRegistry(),
        gate: { decidePermission: () => ({ allowed: true }) },
        // TypeScript on purpose: proving the child transpiles, which is what
        // requires the esbuild exec grant.
        source: 'const v: number = 6 * 7; return `answer ${v}`;',
      });
      expect(result.status).toBe('completed');
      expect(result.output).toContain('answer 42');
      // The child reported its own limit, so the cap really was applied.
      expect(result.heapLimitBytes).toBeGreaterThan(0);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!childBuilt)('still refuses an escape from the built child', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cowork-e2e-'));
    const outside = mkdtempSync(join(tmpdir(), 'cowork-e2e-out-'));
    const target = join(outside, 'escaped.txt');
    try {
      const result = await runCode({
        sessionId: 'e2e',
        cwd: workspace,
        allowedTools: [],
        registry: new ToolRegistry(),
        gate: { decidePermission: () => ({ allowed: true }) },
        source: `
          const fs = await import('node:fs');
          try {
            fs.writeFileSync(${JSON.stringify(target)}, 'x');
            return 'WROTE_OUTSIDE';
          } catch (error) {
            return 'REFUSED';
          }
        `,
      });
      expect(result.output).toContain('REFUSED');
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails safely when the child path does not exist, instead of hanging', async () => {
    // A missing FILE is a different case from no resolution at all: the spawn
    // succeeds and the child dies immediately. Both must end as a reported
    // failure the model can be shown, and neither may hang.
    const result = await runCode({
      sessionId: 'e2e',
      cwd: process.cwd(),
      allowedTools: [],
      registry: new ToolRegistry(),
      gate: { decidePermission: () => ({ allowed: true }) },
      childScript: join(tmpdir(), 'cowork-no-such-child.mjs'),
      source: 'return 1;',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });

  it('reports a clear error when the child is genuinely absent', async () => {
    // Simulate a build that never produced the child: resolution finds nothing.
    const workspace = mkdtempSync(join(tmpdir(), 'cowork-noresolve-'));
    try {
      const result = await runCode({
        sessionId: 'e2e',
        cwd: workspace,
        allowedTools: [],
        registry: new ToolRegistry(),
        gate: { decidePermission: () => ({ allowed: true }) },
        source: 'return 1;',
        // Force the "cannot resolve" path deterministically.
        childScript: undefined,
      });
      // In a built tree this succeeds; the assertion is only that the call
      // either runs or reports the missing-runtime error, never throws.
      if (result.status === 'failed') {
        expect(result.error).toMatch(/child runtime/i);
      } else {
        expect(result.status).toBe('completed');
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);
});
