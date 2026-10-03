import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const index = read('src/main/index.ts');
const emergencyStop = read('src/main/machine-access/emergency-stop.ts');

/**
 * Regression guard for a defect that only appeared in the packaged app:
 * `globalShortcut.register` throws "cannot be used before the app is ready",
 * so registering the emergency stop at module load silently disarmed it. The
 * unit tests for the helper pass either way, because they mock `globalShortcut`
 * and call the function directly — the bug lived in the wiring, not the helper.
 */
describe('emergency stop registration wiring', () => {
  it('registers the stop after the app is ready', () => {
    // Position in the file is not the signal: the old top-level call sat at the
    // very end of the file, textually AFTER `.whenReady()`, yet still ran during
    // module evaluation and threw. The structural signal is nesting — inside the
    // bootstrap callback the call is indented, at module top level it is not.
    expect(index).toMatch(/^ {4,}registerEmergencyStopShortcut\(\(result\) =>/m);
    expect(index).not.toMatch(/^ {0,3}registerEmergencyStopShortcut\(/m);
  });

  it('registers exactly once, keeping the renderer notification', () => {
    const registrations = index.match(/registerEmergencyStopShortcut\(\(result\)/g) ?? [];
    expect(registrations).toHaveLength(1);
    expect(index).toContain(
      "sendToRenderer({ type: 'machine-access.emergency-stopped', payload: result })"
    );
  });

  it('still unregisters the stop during shutdown', () => {
    const unregisterIndex = index.indexOf('unregisterEmergencyStopShortcut();');
    expect(unregisterIndex).toBeGreaterThan(-1);
    // Releasing the global key alongside the catch-all release, after the
    // sandbox cleanup has been awaited.
    const cleanupCallIndex = index.indexOf('await cleanupSandboxResources();');
    const unregisterAllIndex = index.indexOf('globalShortcut.unregisterAll();');
    expect(cleanupCallIndex).toBeGreaterThan(-1);
    expect(unregisterIndex).toBeGreaterThan(cleanupCallIndex);
    expect(unregisterAllIndex).toBeGreaterThan(unregisterIndex);
  });

  it('keeps a non-typing accelerator that reports honestly when taken', () => {
    expect(emergencyStop).toContain("export const EMERGENCY_STOP_ACCELERATOR = 'CommandOrControl+Shift+.';");
    // A failed bind must return null rather than advertising a live shortcut.
    expect(emergencyStop).toContain('if (!ok) {');
  });
});