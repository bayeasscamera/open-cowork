/**
 * The emergency stop and its global shortcut.
 *
 * The security property being pinned: the stop works from the MAIN process with
 * no dependency on the agent loop or the renderer, so it still fires when the
 * agent is stuck. It also must not CLAIM a shortcut it failed to bind.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const registered = new Map<string, () => void>();
let registerResult = true;

vi.mock('electron', () => ({
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      if (!registerResult) return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister: (accelerator: string) => {
      registered.delete(accelerator);
    },
    unregisterAll: () => registered.clear(),
  },
}));

import {
  EMERGENCY_STOP_ACCELERATOR,
  getRegisteredEmergencyStopAccelerator,
  registerEmergencyStopShortcut,
  triggerEmergencyStop,
  unregisterEmergencyStopShortcut,
} from '../src/main/machine-access/emergency-stop';
import { getEmergencyStop } from '../src/main/machine-access/machine-control';

describe('emergency stop', () => {
  beforeEach(() => {
    registered.clear();
    registerResult = true;
  });
  afterEach(() => {
    unregisterEmergencyStopShortcut();
  });

  it('registers a global accelerator that does not type a character', () => {
    const bound = registerEmergencyStopShortcut();
    expect(bound).toBe(EMERGENCY_STOP_ACCELERATOR);
    expect(EMERGENCY_STOP_ACCELERATOR).toContain('Shift');
    expect(getRegisteredEmergencyStopAccelerator()).toBe(EMERGENCY_STOP_ACCELERATOR);
  });

  it('reports honestly when the accelerator is already taken', () => {
    registerResult = false;
    // The UI must learn the shortcut is NOT armed rather than advertising it.
    expect(registerEmergencyStopShortcut()).toBeNull();
    expect(getRegisteredEmergencyStopAccelerator()).toBeNull();
  });

  it('the registered callback really fires the stop', () => {
    let notified: { controllers: number; processes: number } | null = null;
    registerEmergencyStopShortcut((result) => {
      notified = result;
    });
    expect(registered.has(EMERGENCY_STOP_ACCELERATOR)).toBe(true);
    registered.get(EMERGENCY_STOP_ACCELERATOR)?.();
    expect(notified).toEqual({ controllers: 0, processes: 0 });
  });

  it('stops controllers and process groups even mid-flight', () => {
    // Register against the SHARED singleton the gate and GUI batches use — that
    // shared instance is the property that makes one stop stop everything.
    const stop = getEmergencyStop();
    const a = new AbortController();
    const b = new AbortController();
    stop.register(a);
    stop.register(b);
    stop.registerProcess(31337);

    const result = triggerEmergencyStop();
    expect(result).toEqual({ controllers: 2, processes: 1 });
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(stop.isActive).toBe(true);
    stop.resume();
  });

  it('unregisters cleanly at shutdown', () => {
    registerEmergencyStopShortcut();
    expect(registered.size).toBe(1);
    unregisterEmergencyStopShortcut();
    expect(registered.size).toBe(0);
    expect(getRegisteredEmergencyStopAccelerator()).toBeNull();
  });

  it('is idempotent: unregistering twice is harmless', () => {
    registerEmergencyStopShortcut();
    unregisterEmergencyStopShortcut();
    expect(() => unregisterEmergencyStopShortcut()).not.toThrow();
  });
});