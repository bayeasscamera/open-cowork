import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../src/renderer/store';
import {
  setInspectorOpen,
  toggleInspectorPanel,
  toggleViewPanel,
  toggleWorkspacePanel,
} from '../src/renderer/utils/workspace-panel-toggles';
import type { WorkspacePanelId } from '../src/shared/workspace-panels';

/**
 * The shared toggles back the dock buttons, the ⌘/Ctrl+1..7 shortcuts and the
 * app-menu `panel.toggle` event. Every entry point must behave identically:
 * one view at a time, one inspector at a time, session gating, and no
 * double-toggle from duplicate key/menu signals.
 */
describe('workspace panel toggles', () => {
  let clock = 1_000_000;

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    // Each test gets its own time slice so the duplicate-press window from
    // one test can never leak into the next.
    clock += 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('toggleViewPanel', () => {
    it('opens one full-page view and closes its siblings', () => {
      toggleViewPanel('memory');
      const state = useAppStore.getState();
      expect(state.memoryPanelVisible).toBe(true);
      expect(state.modelRoutingVisible).toBe(false);
      expect(state.controlCenterVisible).toBe(false);
      expect(state.planPanelVisible).toBe(false);
    });

    it('closes the view again on the second toggle', () => {
      toggleViewPanel('memory');
      toggleViewPanel('memory');
      expect(useAppStore.getState().memoryPanelVisible).toBe(false);
    });
  });

  describe('toggleInspectorPanel / setInspectorOpen', () => {
    it('mounts a single side inspector at a time', () => {
      setInspectorOpen('delegatedTasks', true);
      expect(useAppStore.getState().delegatedTasksVisible).toBe(true);

      setInspectorOpen('document', true);
      const state = useAppStore.getState();
      expect(state.documentPanelVisible).toBe(true);
      expect(state.delegatedTasksVisible).toBe(false);
      expect(state.diffPanelVisible).toBe(false);
    });

    it('toggles an inspector and closes its siblings', () => {
      setInspectorOpen('document', true);
      toggleInspectorPanel('diff');
      const state = useAppStore.getState();
      expect(state.diffPanelVisible).toBe(true);
      expect(state.documentPanelVisible).toBe(false);
    });
  });

  describe('toggleWorkspacePanel', () => {
    it('ignores session-scoped panels while no session is active', () => {
      expect(toggleWorkspacePanel('memory')).toBe(false);
      expect(toggleWorkspacePanel('diff')).toBe(false);
      const state = useAppStore.getState();
      expect(state.memoryPanelVisible).toBe(false);
      expect(state.diffPanelVisible).toBe(false);
    });

    it('toggles session-scoped panels once a session is active', () => {
      useAppStore.getState().setActiveSession('session-1');
      expect(toggleWorkspacePanel('memory')).toBe(true);
      expect(useAppStore.getState().memoryPanelVisible).toBe(true);
    });

    it('toggles panels that do not require a session without one', () => {
      expect(toggleWorkspacePanel('modelRouting')).toBe(true);
      expect(useAppStore.getState().modelRoutingVisible).toBe(true);
    });

    it('collapses duplicate signals so one press never opens AND closes', () => {
      useAppStore.getState().setActiveSession('session-1');
      // A menu accelerator and the key handler can both fire for one press.
      expect(toggleWorkspacePanel('plan')).toBe(true);
      expect(toggleWorkspacePanel('plan')).toBe(false);
      expect(useAppStore.getState().planPanelVisible).toBe(true);

      // After the window, a real second press toggles again.
      clock += 250;
      expect(toggleWorkspacePanel('plan')).toBe(true);
      expect(useAppStore.getState().planPanelVisible).toBe(false);
    });

    it('ignores unknown ids instead of throwing', () => {
      // Malformed IPC payloads must never crash the renderer.
      expect(toggleWorkspacePanel('nope' as WorkspacePanelId)).toBe(false);
    });
  });
});
