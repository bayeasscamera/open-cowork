import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
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

  it('window close quits for real with an independent hard failsafe', () => {
    const closeBlock = block(
      source(indexPath),
      /mainWindow\.on\('close'[\s\S]*?\n  \}\);/,
      "mainWindow 'close' interceptor"
    );
    // The close button no longer suspends quit: the window closes and
    // window-all-closed triggers app.quit() on the natural path.
    expect(closeBlock).toContain('if (!isCleaningUp)');
    expect(closeBlock).not.toContain('event.preventDefault()');
    // Independent hard failsafe: the process must die within 9s of a close
    // request even if the before-quit handler never runs.
    expect(closeBlock).toContain('process.exit(0)');
    expect(closeBlock).toContain('9000');
    expect(closeBlock).toContain('app.once(\'will-quit\', () => clearTimeout(hardKillTimer))');
  });

  it('global window toggle never binds plain Alt+Space', () => {
    const main = source(indexPath);
    expect(main).toContain("globalShortcut.register('CommandOrControl+Alt+Space', toggleWindow)");
    expect(main).not.toContain("globalShortcut.register('Alt+Space'");
  });

  it('trayEnabled defaults to false so close always quits for new installs', () => {
    const pkgDefaults = source(resolve(root, 'src/main/config/config-store.ts'));
    expect(pkgDefaults).toContain('trayEnabled: false');
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

  it('never creates a native FSEvents watcher for skills storage on macOS', () => {
    // Regression: a recursive chokidar watcher deadlocks libuv on macOS
    // (uv_fs_event_stop → uv__fsevents_close → uv_sem_wait). The freeze is
    // synchronous, so the 9s failsafe could never fire. Skipping close() only
    // moved the deadlock to Node's own handle cleanup at teardown
    // (node::FreeEnvironment → Environment::CleanupHandles → uv_close), which
    // is why process.exit(0) also never returned and Force Quit was required.
    // macOS must therefore use the signature poller, which owns no native
    // handle at all.
    const skills = source(resolve(root, 'src/main/skills/skills-manager.ts'));
    const startWatcher = block(
      skills,
      /private startStorageWatcher\(\): void \{[\s\S]*?\n  \}/,
      'startStorageWatcher()'
    );
    const darwinIndex = startWatcher.indexOf("process.platform === 'darwin'");
    const nativeIndex = startWatcher.indexOf('chokidar.watch(');
    expect(darwinIndex).toBeGreaterThan(-1);
    expect(nativeIndex).toBeGreaterThan(-1);
    // The darwin branch must return before any native watcher is created.
    expect(darwinIndex).toBeLessThan(nativeIndex);
    expect(startWatcher).toContain('this.startStoragePolling(storagePath)');

    const stopWatcher = block(
      skills,
      /private stopStorageWatcher\(\): void \{[\s\S]*?\n  \}/,
      'stopStorageWatcher()'
    );
    // The releaseOnly escape hatch is gone: nothing must ever skip the close
    // while a native handle can still exist.
    expect(stopWatcher).not.toContain('releaseOnly');
    expect(stopWatcher).toContain('clearInterval(this.storagePollingTimer)');

    const monitoring = block(
      skills,
      /stopStorageMonitoring\(\): void \{[\s\S]*?\n  \}/,
      'stopStorageMonitoring()'
    );
    expect(monitoring).not.toContain('releaseOnly');
    expect(monitoring).toContain('this.stopStorageWatcher()');

    const cleanup = block(
      source(indexPath),
      /async function cleanupSandboxResources[\s\S]*?\n\}/,
      'cleanupSandboxResources()'
    );
    expect(cleanup).toContain('stopStorageMonitoring()');
    expect(cleanup).not.toContain('releaseOnly');
  });

  it('arms an out-of-process watchdog before cleanup starts', () => {
    // A synchronous block cannot be interrupted by a JS timer, so the quit
    // path needs a watchdog running outside this process.
    const beforeQuit = block(
      source(indexPath),
      /app\.on\('before-quit'[\s\S]*?\n\}\);/,
      "app.on('before-quit') handler"
    );
    const armIndex = beforeQuit.indexOf('armHardExitWatchdog(');
    const cleanupIndex = beforeQuit.indexOf('await cleanupSandboxResources()');
    expect(armIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(-1);
    expect(armIndex).toBeLessThan(cleanupIndex);
    expect(beforeQuit).toContain('disarmWatchdog()');

    const watchdog = block(
      source(indexPath),
      /function armHardExitWatchdog\([\s\S]*?\n\}/,
      'armHardExitWatchdog()'
    );
    expect(watchdog).toContain('detached: true');
    expect(watchdog).toContain('kill -9');
  });

  it('terminates with process.exit(0) rather than app.exit(0)', () => {
    // Regression: once before-quit cancelled the quit with preventDefault(),
    // app.exit(0) returned without terminating. The shutdown log showed every
    // cleanup step completing and the watchdog being disarmed, yet the process
    // stayed alive and still needed Force Quit. process.exit() cannot be
    // swallowed by Electron's (already cancelled) quit sequence.
    const beforeQuit = block(
      source(indexPath),
      /app.on\('before-quit'[\s\S]*?\n\}\);/,
      "app.on('before-quit') handler"
    );
    // Strip line comments so the rationale above (which names app.exit) does
    // not defeat the assertion.
    const code = beforeQuit.replace(/\/\/[^\n]*/g, '');
    expect(code).toContain('process.exit(0)');
    expect(code).not.toContain('app.exit(0)');

    // After the clean-path disarm, a short-grace watchdog must be re-armed
    // BEFORE the exit call: Node's environment teardown can block forever
    // closing a native handle, and an in-process timer cannot fire during that
    // synchronous block. lastIndexOf because the 9s failsafe earlier in the
    // handler also disarms and calls process.exit(0).
    const disarmIndex = code.lastIndexOf('disarmWatchdog()');
    const rearmIndex = code.indexOf('armHardExitWatchdog(5000)');
    const exitIndex = code.lastIndexOf('process.exit(0)');
    expect(disarmIndex).toBeGreaterThan(-1);
    expect(rearmIndex).toBeGreaterThan(disarmIndex);
    expect(exitIndex).toBeGreaterThan(rearmIndex);
  });
});
