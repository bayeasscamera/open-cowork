import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexPath = resolve(__dirname, '../src/main/index.ts');
const mcpPath = resolve(__dirname, '../src/main/mcp/mcp-manager.ts');

function source(file: string): string {
  return readFileSync(file, 'utf8');
}

function block(text: string, pattern: RegExp, label: string): string {
  const match = text.match(pattern)?.[0];
  if (!match) {
    throw new Error(`Could not locate ${label} in source`);
  }
  return match;
}

describe('shutdown quit flow', () => {
  it('before-quit sets isCleaningUp before the dev-mode early return', () => {
    // Regression: the dev branch used to return without setting the flag, so
    // the window 'close' interceptor kept preventDefault()'ing and app.quit()
    // could never complete — the app hid instead of exiting.
    const beforeQuit = block(
      source(indexPath),
      /app\.on\('before-quit'[\s\S]*?\n\}\);/,
      "app.on('before-quit') handler"
    );
    const flagIndex = beforeQuit.indexOf('isCleaningUp = true');
    const devIndex = beforeQuit.indexOf('VITE_DEV_SERVER_URL');

    expect(flagIndex).toBeGreaterThan(-1);
    expect(devIndex).toBeGreaterThan(-1);
    // Flag must be set BEFORE any early return, dev or packaged.
    expect(flagIndex).toBeLessThan(devIndex);
    // Packaged path must still defer the exit until cleanup completes.
    expect(beforeQuit).toContain('event.preventDefault()');
  });

  it('window-all-closed does not trigger a second quit during cleanup', () => {
    // Regression: a second app.quit() while before-quit cleanup was in
    // flight let Electron terminate mid-cleanup and orphan MCP/VM children.
    const windowAllClosed = block(
      source(indexPath),
      /app\.on\('window-all-closed'[\s\S]*?\n\}\);/,
      "app.on('window-all-closed') handler"
    );
    expect(windowAllClosed).toContain('if (isCleaningUp) return');
    const guardIndex = windowAllClosed.indexOf('if (isCleaningUp) return');
    const quitIndex = windowAllClosed.indexOf('app.quit()');
    expect(quitIndex).toBeGreaterThan(guardIndex);
  });

  it('window close interceptor remains gated by the cleanup flag', () => {
    const closeBlock = block(
      source(indexPath),
      /mainWindow\.on\('close'[\s\S]*?\n  \}\);/,
      "mainWindow 'close' interceptor"
    );
    expect(closeBlock).toContain('if (!isCleaningUp)');
    expect(closeBlock).toContain('event.preventDefault()');
    expect(closeBlock).toContain('app.quit()');
  });

  it('cleanup steps run in parallel with per-step timeouts capped at 5000ms', () => {
    const cleanup = block(
      source(indexPath),
      /async function cleanupSandboxResources[\s\S]*?\n\}/,
      'cleanupSandboxResources()'
    );
    expect(cleanup).toContain('Promise.all(cleanupTasks)');
    const timeouts = [...cleanup.matchAll(/withTimeout\([\s\S]*?,\s*(\d+),\s*'/g)].map((m) =>
      Number(m[1])
    );
    expect(timeouts.length).toBeGreaterThanOrEqual(5);
    for (const ms of timeouts) {
      expect(ms).toBeLessThanOrEqual(5000);
    }
  });

  it('quit failsafe covers the slowest cleanup pipeline instead of cutting it short', () => {
    const beforeQuit = block(
      source(indexPath),
      /app\.on\('before-quit'[\s\S]*?\n\}\);/,
      "app.on('before-quit') handler"
    );
    const failsafe = Number(
      block(beforeQuit, /failsafeTimer = setTimeout\(\(\) => \{[\s\S]*?\}, (\d+)\);/, 'failsafe timer')
        .match(/, (\d+)\);$/)?.[1]
    );
    // The sandbox pipeline can take ~7s (session sync-back + adapter
    // shutdown); the old 3s failsafe hard-killed the process before MCP
    // shutdown ever ran, orphaning stdio child processes.
    expect(failsafe).toBeGreaterThanOrEqual(7000);
    expect(failsafe).toBeLessThanOrEqual(15000);
  });

  it('MCP shutdown terminates the detached debug Chrome it spawned', () => {
    const mcpSource = source(mcpPath);
    const shutdown = block(
      mcpSource,
      /async shutdown\(\): Promise<void> \{[\s\S]*?\n  \}/,
      'MCPManager.shutdown()'
    );
    expect(shutdown).toContain('debugChromeProcess');
    expect(shutdown).toContain("kill('SIGTERM')");
    // The handle must be captured right after spawn.
    const spawnBlock = block(
      mcpSource,
      /const chromeProcess = spawn\([\s\S]*?\n      \}/,
      'debug Chrome spawn'
    );
    expect(spawnBlock).toContain('detached: true');
    expect(mcpSource).toContain('this.debugChromeProcess = chromeProcess;');
  });
});
