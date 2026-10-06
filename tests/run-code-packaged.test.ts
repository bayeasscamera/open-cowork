import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';

import {
  defaultAppRoots,
  resolveEsbuildBinary,
  resolveRunCodeChildScript,
} from '../src/main/agent/run-code-runtime';
import { runCode } from '../src/main/agent/run-code-host';
import { ToolRegistry } from '../src/main/tools/registry';
import { CODE_MODE_PRESET } from '../src/main/presets/builtin-presets';
import { seatbeltUsable } from './sandbox-capability';

/**
 * run_code in a PACKAGED app.
 *
 * This is the layer that cannot be verified any other way, and it is where two
 * independent mistakes lived until they were checked:
 *
 *   1. The child was inside the asar. A plain `node` process cannot read an asar
 *      archive - loading a script from one throws - so the child could never have
 *      loaded at all in a built app.
 *   2. esbuild was not shipped. The child needs it to transpile, and esbuild
 *      refuses to be bundled (it finds its native binary by a relative path from
 *      its own source), so shipping it was the only option.
 *
 * Both fail silently: the app builds, ships, and simply never runs code.
 *
 * These tests need `npx electron-builder --dir --mac` to have produced a real
 * app, and skip themselves when it has not - a gate that required a full package
 * build would be a bad thing to put in the normal test run. What they check is
 * the real layout on disk and a real child process, not a simulation.
 */

const REPO = process.cwd();
const RESOURCES = `${REPO}/release/mac-arm64/Open Cowork.app/Contents/Resources`;
const packaged = existsSync(RESOURCES);
const describePackaged = packaged ? describe : describe.skip;
// The runtime cases below also execute a real child under the sandbox, so they
// need a host that will apply a profile as well as a packaged build.
const describePackagedSandbox = packaged && seatbeltUsable ? describe : describe.skip;

describe('without a packaged build these skip rather than fail', () => {
  it('says so explicitly', () => {
    // If a future CI run has no build, a silent skip reads like a pass. This
    // keeps the distinction visible.
    expect(typeof packaged).toBe('boolean');
  });
});

describePackaged('the packaged app ships a usable child, outside the asar', () => {
  const child = resolveRunCodeChildScript(`${REPO}/src/main/agent`, RESOURCES);

  it('resolves the child inside Resources, not inside the asar', () => {
    expect(child).toBeTruthy();
    expect(child).toBe(`${RESOURCES}/run-code-child/index.js`);
    // The whole reason it is an extraResource.
    expect(child).not.toContain('app.asar');
  });

  it('resolves esbuild from app.asar.unpacked, not from a dev tree', () => {
    const esbuild = resolveEsbuildBinary(defaultAppRoots(`${REPO}/src/main/agent`, RESOURCES));
    expect(esbuild).toBeTruthy();
    // Packaged precedence matters: the sandbox grants exec of whichever binary
    // this returns, so it must be the shipped one.
    expect(esbuild).toContain('app.asar.unpacked');
    expect(esbuild).not.toContain('/src/');
  });
});

describePackagedSandbox('run_code works against the packaged runtime', () => {
  it('transpiles and runs TypeScript through the shipped child', async () => {
    const result = await runCode({
      sessionId: 'packaged',
      cwd: REPO,
      allowedTools: CODE_MODE_PRESET.tools.allow,
      registry: new ToolRegistry(),
      gate: { decidePermission: () => ({ allowed: true }) },
      // TypeScript on purpose: this is the assertion that proves esbuild ships.
      source: 'const v: number = 6 * 7; return `packaged answer ${v}`;',
    });
    expect(result.status).toBe('completed');
    expect(result.output).toContain('packaged answer 42');
  }, 120_000);

  it('still applies the memory cap to the packaged child', async () => {
    const result = await runCode({
      sessionId: 'packaged',
      cwd: REPO,
      allowedTools: CODE_MODE_PRESET.tools.allow,
      registry: new ToolRegistry(),
      gate: { decidePermission: () => ({ allowed: true }) },
      source: 'return 1;',
    });
    expect(result.heapLimitBytes).toBeGreaterThan(0);
    expect(result.heapLimitBytes).toBeLessThan(1024 * 1024 * 1024);
  }, 120_000);

  it('still refuses an escape from the packaged child', async () => {
    const result = await runCode({
      sessionId: 'packaged',
      cwd: REPO,
      allowedTools: CODE_MODE_PRESET.tools.allow,
      registry: new ToolRegistry(),
      gate: { decidePermission: () => ({ allowed: true }) },
      source: `
        const fs = await import('node:fs');
        try {
          fs.writeFileSync('/tmp/cowork-packaged-escape.txt', 'x');
          return 'ESCAPED';
        } catch (error) {
          return 'REFUSED';
        }
      `,
    });
    expect(result.output).toContain('REFUSED');
    expect(result.output).not.toContain('ESCAPED');
  }, 120_000);
});
