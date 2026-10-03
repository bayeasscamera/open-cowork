/**
 * @module main/machine-access/emergency-stop
 *
 * The emergency stop, registered in the MAIN process with a GLOBAL shortcut so
 * it works when the renderer is busy, when the agent loop is stuck, and when the
 * window is hidden — the same independence principle as the existing close
 * failsafe.
 *
 * It calls the same `EmergencyStop` the gate and the GUI batches register with,
 * so one action really does stop everything: GUI controllers, spawned command
 * process groups, and background jobs.
 */

import { globalShortcut } from 'electron';
import { getEmergencyStop } from './machine-control';
import { log, logError, logWarn } from '../utils/logger';

/**
 * `Cmd/Ctrl+Shift+.` — deliberately not a key that types a character, so it
 * cannot interfere with ordinary typing in another application.
 */
export const EMERGENCY_STOP_ACCELERATOR = 'CommandOrControl+Shift+.';

let registered: string | null = null;

/**
 * Register the global stop. Returns the accelerator actually bound, or null
 * when it was already taken by another application — the UI must then tell the
 * user the shortcut is unavailable rather than pretending it is armed.
 */
export function registerEmergencyStopShortcut(
  onStopped?: (result: { controllers: number; processes: number }) => void
): string | null {
  try {
    const ok = globalShortcut.register(EMERGENCY_STOP_ACCELERATOR, () => {
      const result = triggerEmergencyStop();
      log(
        `[EmergencyStop] Stopped ${result.controllers} controller(s) and ${result.processes} process group(s)`
      );
      onStopped?.(result);
    });
    if (!ok) {
      logWarn(
        `[EmergencyStop] ${EMERGENCY_STOP_ACCELERATOR} is already taken by another application; ` +
          'use the Stop button in Settings instead.'
      );
      return null;
    }
    registered = EMERGENCY_STOP_ACCELERATOR;
    log(`[EmergencyStop] Registered ${EMERGENCY_STOP_ACCELERATOR}`);
    return registered;
  } catch (error) {
    logError('[EmergencyStop] Failed to register the global stop shortcut:', error);
    return null;
  }
}

/** Fire the stop programmatically (the Settings button). */
export function triggerEmergencyStop(): { controllers: number; processes: number } {
  try {
    return getEmergencyStop().stop();
  } catch (error) {
    logError('[EmergencyStop] stop() failed:', error);
    return { controllers: 0, processes: 0 };
  }
}

export function unregisterEmergencyStopShortcut(): void {
  if (!registered) return;
  try {
    globalShortcut.unregister(registered);
  } catch (error) {
    logWarn('[EmergencyStop] Failed to unregister the shortcut:', error);
  }
  registered = null;
}

export function getRegisteredEmergencyStopAccelerator(): string | null {
  return registered;
}