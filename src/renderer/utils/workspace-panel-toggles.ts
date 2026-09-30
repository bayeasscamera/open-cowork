import { useAppStore } from '../store';
import {
  WORKSPACE_INSPECTOR_PANEL_IDS,
  WORKSPACE_PANELS,
  WORKSPACE_VIEW_PANEL_IDS,
  isWorkspaceViewPanelId,
  type WorkspaceInspectorPanelId,
  type WorkspacePanelId,
  type WorkspaceViewPanelId,
} from '../../shared/workspace-panels';

/**
 * Shared toggle logic for workspace panels, used by the PanelDock buttons,
 * the ⌘/Ctrl+1..7 shortcuts and the macOS app menu (via the `panel.toggle`
 * server event). Keeping it here guarantees every entry point behaves
 * identically: opening a full-page view closes its siblings, and only a
 * single side inspector is ever mounted.
 */

/**
 * A panel's app-menu accelerator and the renderer keydown handler can both
 * react to the same ⌘/Ctrl+<n> press (platforms dispatch menu key equivalents
 * differently), and key auto-repeat re-fires `keydown` while a combo is held.
 * Collapse those duplicate signals so one press can never open AND close the
 * same panel. Well below the fastest deliberate double action (~200ms).
 */
const DUPLICATE_TOGGLE_WINDOW_MS = 200;
const lastToggleAt = new Map<WorkspacePanelId, number>();

function claimToggleSlot(id: WorkspacePanelId, now: number): boolean {
  const previous = lastToggleAt.get(id) ?? 0;
  if (now - previous < DUPLICATE_TOGGLE_WINDOW_MS) return false;
  lastToggleAt.set(id, now);
  return true;
}

export function toggleViewPanel(id: WorkspaceViewPanelId): void {
  const state = useAppStore.getState();
  const current: Record<WorkspaceViewPanelId, boolean> = {
    modelRouting: state.modelRoutingVisible,
    controlCenter: state.controlCenterVisible,
    memory: state.memoryPanelVisible,
    plan: state.planPanelVisible,
  };
  const setVisible: Record<WorkspaceViewPanelId, (visible: boolean) => void> = {
    modelRouting: state.setModelRoutingVisible,
    controlCenter: state.setControlCenterVisible,
    memory: state.setMemoryPanelVisible,
    plan: state.setPlanPanelVisible,
  };
  const open = !current[id];
  for (const panelId of WORKSPACE_VIEW_PANEL_IDS) {
    setVisible[panelId](open && panelId === id);
  }
}

/** Force an inspector open (or closed) while closing its siblings. */
export function setInspectorOpen(id: WorkspaceInspectorPanelId, open: boolean): void {
  const state = useAppStore.getState();
  const setVisible: Record<WorkspaceInspectorPanelId, (visible: boolean) => void> = {
    delegatedTasks: state.setDelegatedTasksVisible,
    document: state.setDocumentPanelVisible,
    diff: state.setDiffPanelVisible,
  };
  for (const panelId of WORKSPACE_INSPECTOR_PANEL_IDS) {
    setVisible[panelId](open && panelId === id);
  }
}

export function toggleInspectorPanel(id: WorkspaceInspectorPanelId): void {
  const state = useAppStore.getState();
  const current: Record<WorkspaceInspectorPanelId, boolean> = {
    delegatedTasks: state.delegatedTasksVisible,
    document: state.documentPanelVisible,
    diff: state.diffPanelVisible,
  };
  setInspectorOpen(id, !current[id]);
}

/**
 * Single entry point for every panel toggle: dock buttons, ⌘/Ctrl+1..7 and
 * the `panel.toggle` app-menu event. Session-scoped panels are ignored while
 * no session is active, and duplicate signals for the same panel inside
 * {@link DUPLICATE_TOGGLE_WINDOW_MS} are collapsed.
 *
 * Returns `true` when the toggle actually ran.
 */
export function toggleWorkspacePanel(id: WorkspacePanelId): boolean {
  const panel = WORKSPACE_PANELS.find((candidate) => candidate.id === id);
  if (!panel) return false;
  const state = useAppStore.getState();
  if (panel.requiresSession && !state.activeSessionId) return false;
  if (!claimToggleSlot(id, Date.now())) return false;
  if (isWorkspaceViewPanelId(id)) {
    toggleViewPanel(id);
  } else {
    toggleInspectorPanel(id);
  }
  return true;
}
