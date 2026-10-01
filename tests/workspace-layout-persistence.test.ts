import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import {
  captureWorkspace,
  clearWorkspace,
  flushWorkspaceSave,
  loadWorkspace,
  restoreWorkspace,
  saveWorkspace,
  scheduleWorkspaceSave,
  type WorkspaceLayoutSetters,
  type WorkspaceLayoutState,
} from '../src/renderer/utils/workspace-persist';
import { useAppStore } from '../src/renderer/store';

/**
 * Workspace layout persistence — the "Lot 2" of the session-restore spec.
 *
 * The goal is that a restart reopens the app on the panel the user was
 * looking at. The invariants that keep this from becoming a nuisance matter as
 * much as the feature itself: a corrupt snapshot must never block startup, and
 * a session-scoped panel must never be restored against a different session or
 * with no session at all.
 */

function layout(overrides: Partial<WorkspaceLayoutState> = {}): WorkspaceLayoutState {
  return {
    activeSessionId: null,
    sidebarCollapsed: false,
    contextPanelCollapsed: false,
    modelRoutingVisible: false,
    controlCenterVisible: false,
    memoryPanelVisible: false,
    planPanelVisible: false,
    delegatedTasksVisible: false,
    documentPanelVisible: false,
    diffPanelVisible: false,
    ...overrides,
  };
}

/** Records which setters were called, so assertions read as UI effects. */
function recordSetters() {
  const calls: string[] = [];
  const setters = new Proxy({} as WorkspaceLayoutSetters, {
    get: (_target, prop: string) => (...args: unknown[]) => {
      calls.push(`${prop}(${String(args[0])})`);
    },
  });
  return { calls, setters };
}

const STORE_KEY = 'open-cowork.workspace.v1';

/**
 * Minimal in-memory `localStorage`. The suite runs in vitest's `node`
 * environment (no jsdom is installed in this project), but this module is
 * renderer code whose entire contract is "tolerate storage being present,
 * absent or throwing" — so a real Storage double is the honest fixture.
 */
class MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

let storage: MemoryStorage = new MemoryStorage();

function installStorage(): void {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage,
  });
}

function uninstallStorage(): void {
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'localStorage');
}

describe('workspace layout persistence', () => {
  beforeEach(() => {
    installStorage();
  });

  afterEach(() => {
    flushWorkspaceSave();
    vi.useRealTimers();
    uninstallStorage();
  });

  describe('round trip', () => {
    it('restores the panels that were open', () => {
      saveWorkspace(
        captureWorkspace(layout({ activeSessionId: 's1', diffPanelVisible: true, sidebarCollapsed: true }))
      );

      const snapshot = loadWorkspace();

      expect(snapshot?.panels.diff).toBe(true);
      expect(snapshot?.sidebarCollapsed).toBe(true);
      expect(snapshot?.activeSessionId).toBe('s1');
    });

    it('records every panel id it knows about', () => {
      const snapshot = captureWorkspace(layout());
      // Guards against a panel silently dropping out of the persisted layout.
      expect(Object.keys(snapshot.panels).sort()).toEqual([
        'controlCenter',
        'delegatedTasks',
        'diff',
        'document',
        'memory',
        'modelRouting',
        'plan',
      ]);
    });

    it('never stores conversation content or a filesystem path', () => {
      const serialized = JSON.stringify(captureWorkspace(layout({ activeSessionId: 's1' })));
      // The layout may carry an opaque session id, nothing else.
      expect(serialized).not.toMatch(/message|prompt|content|path|cwd|key|token/i);
    });
  });

  describe('corrupt or hostile input', () => {
    it('returns null for a non-JSON payload instead of throwing', () => {
      localStorage.setItem(STORE_KEY, 'not json at all');
      expect(loadWorkspace()).toBeNull();
    });

    it('returns null for a snapshot written by a future version', () => {
      localStorage.setItem(STORE_KEY, JSON.stringify({ version: 99, panels: { diff: true } }));
      // Semantics may have changed; guessing is worse than falling back to
      // the default layout.
      expect(loadWorkspace()).toBeNull();
    });

    it('returns null for a non-object payload', () => {
      localStorage.setItem(STORE_KEY, '"a string"');
      expect(loadWorkspace()).toBeNull();
      localStorage.setItem(STORE_KEY, 'null');
      expect(loadWorkspace()).toBeNull();
    });

    it('drops unknown panel ids and wrong-typed flags', () => {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          version: 1,
          activeSessionId: 's1',
          panels: { diff: true, notAPanel: true, memory: 'yes' },
          sidebarCollapsed: 'true',
        })
      );

      const snapshot = loadWorkspace();

      expect(snapshot?.panels.diff).toBe(true);
      expect(snapshot?.panels).not.toHaveProperty('notAPanel');
      // Wrong type falls back to closed rather than being coerced.
      expect(snapshot?.panels.memory).toBeUndefined();
      expect(snapshot?.sidebarCollapsed).toBe(false);
    });

    it('survives localStorage being unavailable', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new Error('storage blocked');
        },
      });

      // None of these may throw: losing the layout is acceptable, failing to
      // start the app is not.
      expect(loadWorkspace()).toBeNull();
      expect(() => saveWorkspace(captureWorkspace(layout()))).not.toThrow();
      expect(() => clearWorkspace()).not.toThrow();
    });

    it('survives localStorage throwing on write (quota exceeded)', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          getItem: () => null,
          setItem: () => {
            throw new Error('QuotaExceededError');
          },
          removeItem: () => undefined,
        },
      });

      expect(() => saveWorkspace(captureWorkspace(layout()))).not.toThrow();
    });
  });

  describe('debounced writes', () => {
    it('coalesces rapid changes into a single write', () => {
      vi.useFakeTimers();
      scheduleWorkspaceSave(layout({ diffPanelVisible: true }));
      scheduleWorkspaceSave(layout({ diffPanelVisible: false }));
      scheduleWorkspaceSave(layout({ diffPanelVisible: true }));
      expect(localStorage.getItem(STORE_KEY)).toBeNull();

      vi.advanceTimersByTime(400);

      expect(loadWorkspace()?.panels.diff).toBe(true);
    });
  });

  describe('restore invariants', () => {
    it('restores panel visibility for the same session', () => {
      const { calls, setters } = recordSetters();
      const snapshot = captureWorkspace(
        layout({ activeSessionId: 's1', diffPanelVisible: true, memoryPanelVisible: false })
      );

      restoreWorkspace(snapshot, { activeSessionId: 's1' }, setters);

      expect(calls).toContain('setDiffPanelVisible(true)');
      expect(calls).toContain('setMemoryPanelVisible(false)');
    });

    it('never restores a panel against a different session', () => {
      const { calls, setters } = recordSetters();
      const snapshot = captureWorkspace(layout({ activeSessionId: 's1', diffPanelVisible: true }));

      // The user last worked in s2; s1's diff panel is meaningless here.
      restoreWorkspace(snapshot, { activeSessionId: 's2' }, setters);

      expect(calls).not.toContain('setDiffPanelVisible(true)');
    });

    it('never opens a session-scoped panel when no session is active', () => {
      const { calls, setters } = recordSetters();
      const snapshot = captureWorkspace(
        layout({ activeSessionId: null, delegatedTasksVisible: true, diffPanelVisible: true })
      );

      restoreWorkspace(snapshot, { activeSessionId: null }, setters);

      expect(calls).toContain('setDelegatedTasksVisible(true)');
      // The session-scoped panel stays shut on the dashboard.
      expect(calls).not.toContain('setDiffPanelVisible(true)');
    });

    it('restores global chrome even when the session differs', () => {
      const { calls, setters } = recordSetters();
      const snapshot = captureWorkspace(
        layout({ activeSessionId: 's1', sidebarCollapsed: true, diffPanelVisible: true })
      );

      restoreWorkspace(snapshot, { activeSessionId: 's2' }, setters);

      // The collapsed sidebar is not session-specific.
      expect(calls).toContain('setSidebarCollapsed(true)');
      expect(calls).not.toContain('setDiffPanelVisible(true)');
    });

    it('is a no-op when there is no snapshot', () => {
      const { calls, setters } = recordSetters();
      expect(restoreWorkspace(null, { activeSessionId: 's1' }, setters)).toBe(false);
      expect(calls).toEqual([]);
    });
  });

  describe('integration with the real store', () => {
    beforeEach(() => {
      useAppStore.setState(useAppStore.getInitialState());
    });

    it('captures the store layout and re-applies it through store setters', () => {
      useAppStore.setState({ activeSessionId: 's1' });
      togglePanel('diff');

      saveWorkspace(captureWorkspace(layoutFromStore()));
      // Simulate a restart: store back to defaults, snapshot still on disk.
      useAppStore.setState(useAppStore.getInitialState());
      useAppStore.setState({ activeSessionId: 's1' });

      const snapshot = loadWorkspace();
      const state = useAppStore.getState();
      restoreWorkspace(
        snapshot,
        { activeSessionId: 's1' },
        {
          setModelRoutingVisible: state.setModelRoutingVisible,
          setControlCenterVisible: state.setControlCenterVisible,
          setMemoryPanelVisible: state.setMemoryPanelVisible,
          setPlanPanelVisible: state.setPlanPanelVisible,
          setDelegatedTasksVisible: state.setDelegatedTasksVisible,
          setDocumentPanelVisible: state.setDocumentPanelVisible,
          setDiffPanelVisible: state.setDiffPanelVisible,
          setSidebarCollapsed: state.setSidebarCollapsed,
          setContextPanelCollapsed: state.setContextPanelCollapsed,
        }
      );

      expect(useAppStore.getState().diffPanelVisible).toBe(true);
    });
  });
});

function layoutFromStore(): WorkspaceLayoutState {
  const s = useAppStore.getState();
  return {
    activeSessionId: s.activeSessionId,
    sidebarCollapsed: s.sidebarCollapsed,
    contextPanelCollapsed: s.contextPanelCollapsed,
    modelRoutingVisible: s.modelRoutingVisible,
    controlCenterVisible: s.controlCenterVisible,
    memoryPanelVisible: s.memoryPanelVisible,
    planPanelVisible: s.planPanelVisible,
    delegatedTasksVisible: s.delegatedTasksVisible,
    documentPanelVisible: s.documentPanelVisible,
    diffPanelVisible: s.diffPanelVisible,
  };
}

function togglePanel(id: 'diff' | 'memory'): void {
  const s = useAppStore.getState();
  if (id === 'diff') s.setDiffPanelVisible(!s.diffPanelVisible);
  else s.setMemoryPanelVisible(!s.memoryPanelVisible);
}