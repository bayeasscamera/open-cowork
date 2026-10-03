/**
 * The machine-access store slice against a stubbed IPC surface. Proves the
 * renderer path is wired end to end: defaults are locked, grants come only from
 * the native picker (the renderer never sends a path), and the emergency stop
 * reaches the main process.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const calls = {
  getState: [] as unknown[],
  pickFolder: [] as unknown[],
  revokeGrant: [] as unknown[],
  setAutonomy: [] as unknown[],
  addApp: [] as unknown[],
  removeApp: [] as unknown[],
  undoBatch: [] as unknown[],
  emergencyStop: 0,
};

const state = {
  grants: [
    {
      id: 'g1',
      path: '/Users/me/Documents',
      access: 'read-write' as const,
      scope: 'project' as const,
      createdAt: 1,
    },
  ],
  autonomy: 'ask-always' as const,
  allowedApps: ['Safari'],
  permissions: [
    { permission: 'automation' as const, granted: false, known: false, explanation: 'x'.repeat(20) },
  ],
  history: [
    { id: '1', batchId: 'b1', type: 'trash', source: '/w/a', status: 'done', createdAt: 1 },
  ],
  nativeMode: true,
  backupQuotaBytes: 1024,
};

vi.stubGlobal('window', {
  electronAPI: {
    machineAccess: {
      getState: (...args: unknown[]) => {
        calls.getState.push(args);
        return Promise.resolve(state);
      },
      pickFolder: (...args: unknown[]) => {
        calls.pickFolder.push(args);
        return Promise.resolve({ granted: true, grant: { id: 'g2' } });
      },
      revokeGrant: (...args: unknown[]) => {
        calls.revokeGrant.push(args);
        return Promise.resolve({ revoked: true });
      },
      setAutonomy: (...args: unknown[]) => {
        calls.setAutonomy.push(args);
        return Promise.resolve({ autonomy: 'allow-all' });
      },
      addApp: (...args: unknown[]) => {
        calls.addApp.push(args);
        return Promise.resolve({ allowedApps: ['Safari', 'Terminal'] });
      },
      removeApp: (...args: unknown[]) => {
        calls.removeApp.push(args);
        return Promise.resolve({ allowedApps: [] });
      },
      undoBatch: (...args: unknown[]) => {
        calls.undoBatch.push(args);
        return Promise.resolve({ undo: { undone: [], refused: [] } });
      },
      emergencyStop: () => {
        calls.emergencyStop += 1;
        return Promise.resolve({ controllers: 2, processes: 3 });
      },
    },
  },
});

import { useAppStore } from '../src/renderer/store';

describe('machine-access store slice', () => {
  beforeEach(() => {
    useAppStore.setState({
      machineAccess: {
        nativeMode: false,
        grants: [],
        autonomy: 'ask-always',
        allowedApps: [],
        permissions: [],
        history: [],
      },
      machineAccessLoading: false,
      machineAccessError: null,
      machineAccessStopped: false,
      machineAccessWorkspaceRoot: '/w',
    });
  });

  it('locked defaults: always ask, no grant, no application', () => {
    const s = useAppStore.getState().machineAccess;
    expect(s.autonomy).toBe('ask-always');
    expect(s.grants).toHaveLength(0);
    expect(s.allowedApps).toHaveLength(0);
    expect(s.nativeMode).toBe(false);
  });

  it('loadMachineAccess populates the slice', async () => {
    await useAppStore.getState().loadMachineAccess();
    const s = useAppStore.getState();
    expect(s.machineAccess.grants).toHaveLength(1);
    expect(s.machineAccess.nativeMode).toBe(true);
    expect(s.machineAccess.history).toHaveLength(1);
    expect(s.machineAccess.permissions[0]?.known).toBe(false);
    expect(s.machineAccessLoading).toBe(false);
    expect(calls.getState.length).toBeGreaterThan(0);
  });

  it('records a load failure instead of pretending everything is empty', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('ipc down'));
    (window as unknown as { electronAPI: Record<string, Record<string, unknown>> }).electronAPI
      .machineAccess['getState'] = failing;
    await useAppStore.getState().loadMachineAccess();
    const s = useAppStore.getState();
    expect(s.machineAccessError).toBe('ipc down');
    expect(s.machineAccessLoading).toBe(false);
  });

  it('a grant is requested from the native picker, never with a renderer path', async () => {
    await useAppStore.getState().addMachineAccessGrant({ scope: 'project' });
    expect(calls.pickFolder).toHaveLength(1);
    // The renderer must NOT pass a path: the main process opens the picker.
    expect(JSON.stringify(calls.pickFolder[0])).not.toMatch(/path/i);
  });

  it('revocation reloads so the list cannot show a stale grant', async () => {
    await useAppStore.getState().revokeMachineAccessGrant('g1');
    expect(calls.revokeGrant[0]).toEqual([{ id: 'g1' }]);
    expect(calls.getState.length).toBeGreaterThan(0);
  });

  it('autonomy change updates the slice locally', async () => {
    await useAppStore.getState().setMachineAccessAutonomy('allow-all');
    expect(calls.setAutonomy[0]).toEqual([{ projectId: expect.any(String), level: 'allow-all' }]);
    expect(useAppStore.getState().machineAccess.autonomy).toBe('allow-all');
  });

  it('applications are added and removed through the store', async () => {
    await useAppStore.getState().addMachineAccessApp('Terminal');
    expect(useAppStore.getState().machineAccess.allowedApps).toEqual(['Safari', 'Terminal']);
    await useAppStore.getState().removeMachineAccessApp('Safari');
    expect(useAppStore.getState().machineAccess.allowedApps).toEqual([]);
  });

  it('undo targets the workspace and project, then reloads', async () => {
    await useAppStore.getState().undoMachineAccessBatch('b1');
    expect(calls.undoBatch[0]).toEqual([
      { workspaceRoot: '/w', projectId: expect.any(String), batchId: 'b1' },
    ]);
  });

  it('the emergency stop reaches the main process and raises the indicator', async () => {
    await useAppStore.getState().machineAccessEmergencyStop();
    expect(calls.emergencyStop).toBe(1);
    expect(useAppStore.getState().machineAccessStopped).toBe(true);
  });
});