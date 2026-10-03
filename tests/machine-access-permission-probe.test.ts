import { describe, expect, it } from 'vitest';
import {
  probePermissionStates,
  macPermissionStates,
  type PermissionProbe,
} from '../src/main/machine-access/machine-control';

describe('real permission probing', () => {
  it('reports the real probe result and never upgrades unknown to granted', async () => {
    const probes: Array<Record<string, boolean | null>> = [
      { accessibility: true, 'screen-recording': true, automation: null },
      { accessibility: false, 'screen-recording': false, automation: null },
      { accessibility: null, 'screen-recording': null, automation: null },
    ];
    for (const table of probes) {
      const probe: PermissionProbe = async (p) => table[p] ?? null;
      const states = await probePermissionStates(probe);
      if (process.platform !== 'darwin') {
        expect(states).toEqual([]);
        continue;
      }
      for (const state of states) {
        const raw = table[state.permission] ?? null;
        expect(state.granted).toBe(raw === true);
        expect(state.known).toBe(raw !== null);
        // Automation has no macOS read-back: it must never claim granted.
        if (state.permission === 'automation') expect(state.granted).toBe(false);
      }
    }
  });

  it('an unprobeable permission is unknown, not missing', async () => {
    if (process.platform !== 'darwin') return;
    const states = await probePermissionStates(async () => null);
    const automation = states.find((s) => s.permission === 'automation');
    expect(automation?.known).toBe(false);
    expect(automation?.granted).toBe(false);
    // A link to the right settings pane is always offered.
    expect(automation?.settingsUrl).toBeTruthy();
  });

  it('static states carry an explanation for every permission', () => {
    for (const state of macPermissionStates()) {
      expect(state.explanation.length).toBeGreaterThan(10);
      expect(state.granted).toBe(false);
    }
  });
});
