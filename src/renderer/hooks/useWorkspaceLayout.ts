import { useEffect } from 'react';
import { useAppStore } from '../store';
import {
  loadWorkspace,
  restoreWorkspace,
  scheduleWorkspaceSave,
  type WorkspaceLayoutSetters,
  type WorkspaceLayoutState,
} from '../utils/workspace-persist';

/** The store fields that make up the persisted workspace layout. */
function currentLayout(state: ReturnType<typeof useAppStore.getState>): WorkspaceLayoutState {
  return {
    activeSessionId: state.activeSessionId,
    sidebarCollapsed: state.sidebarCollapsed,
    contextPanelCollapsed: state.contextPanelCollapsed,
    modelRoutingVisible: state.modelRoutingVisible,
    controlCenterVisible: state.controlCenterVisible,
    memoryPanelVisible: state.memoryPanelVisible,
    planPanelVisible: state.planPanelVisible,
    delegatedTasksVisible: state.delegatedTasksVisible,
    documentPanelVisible: state.documentPanelVisible,
    diffPanelVisible: state.diffPanelVisible,
  };
}

/**
 * Persist the workspace layout across restarts.
 *
 * Mounted once in `App`. Layout changes are written back (debounced) so a
 * restart reopens the panel that was on screen — the "Lot 2" of the session
 * restore spec. Restoration is deliberately *not* done here: the layout is only
 * valid for a known session, so it is applied from the `session.list` handler
 * once the main process has reported which session it resumed.
 */
export function useWorkspaceLayoutPersistence(): void {
  useEffect(() => {
    // Saving on every write would persist unrelated state (messages, tool
    // output, typing indicators); `currentLayout` reads only layout fields and
    // the write is debounced inside the persistence module.
    const unsubscribe = useAppStore.subscribe((state) => {
      scheduleWorkspaceSave(currentLayout(state));
    });

    return unsubscribe;
  }, []);
}

/**
 * Re-apply the persisted layout for the session that was just restored.
 *
 * Called from the `session.list` handler so it runs exactly once per launch
 * and only after the session id is known. Returns whether a layout was applied.
 */
export function applyPersistedWorkspaceLayout(sessionId: string | null): boolean {
  const state = useAppStore.getState();
  const setters: WorkspaceLayoutSetters = {
    setModelRoutingVisible: state.setModelRoutingVisible,
    setControlCenterVisible: state.setControlCenterVisible,
    setMemoryPanelVisible: state.setMemoryPanelVisible,
    setPlanPanelVisible: state.setPlanPanelVisible,
    setDelegatedTasksVisible: state.setDelegatedTasksVisible,
    setDocumentPanelVisible: state.setDocumentPanelVisible,
    setDiffPanelVisible: state.setDiffPanelVisible,
    setSidebarCollapsed: state.setSidebarCollapsed,
    setContextPanelCollapsed: state.setContextPanelCollapsed,
  };

  return restoreWorkspace(loadWorkspace(), { activeSessionId: sessionId }, setters);
}
