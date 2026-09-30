/**
 * Canonical descriptors for every workspace panel toggled from the PanelDock,
 * the ⌘/Ctrl+1..7 shortcuts and the macOS app menu.
 *
 * Kept in `shared/` so the main process (menu) and the renderer (dock) agree on
 * ids, i18n label keys and shortcut order without duplicating the mapping.
 */
export type WorkspaceViewPanelId = 'modelRouting' | 'controlCenter' | 'memory' | 'plan';
export type WorkspaceInspectorPanelId = 'delegatedTasks' | 'document' | 'diff';
export type WorkspacePanelId = WorkspaceViewPanelId | WorkspaceInspectorPanelId;

export interface WorkspacePanelDescriptor {
  id: WorkspacePanelId;
  /** `view` panels replace the chat surface, `inspector` panels dock on the right. */
  kind: 'view' | 'inspector';
  /** i18n key for the renderer panel label (tooltips). */
  labelKey: string;
  /** i18n key for the application-menu label (fuller names read better in a menu). */
  menuLabelKey: string;
  /**
   * English fallback for the application menu, used until the renderer pushes
   * the localized labels (`appMenu.sync`) and if it never does.
   */
  menuLabel: string;
  /** 1..7 — position in the dock, used for the ⌘/Ctrl+<n> shortcut. */
  shortcut: number;
  /** True when the panel is meaningless without an active session. */
  requiresSession: boolean;
}

export const WORKSPACE_PANELS: readonly WorkspacePanelDescriptor[] = [
  { id: 'modelRouting', kind: 'view', labelKey: 'modelRouting.short', menuLabelKey: 'modelRouting.title', menuLabel: 'Model routing', shortcut: 1, requiresSession: false },
  { id: 'controlCenter', kind: 'view', labelKey: 'controlCenter.short', menuLabelKey: 'controlCenter.title', menuLabel: 'Agent control center', shortcut: 2, requiresSession: true },
  { id: 'memory', kind: 'view', labelKey: 'memory.title', menuLabelKey: 'memory.title', menuLabel: 'Memory', shortcut: 3, requiresSession: true },
  { id: 'plan', kind: 'view', labelKey: 'planPanel.title', menuLabelKey: 'planPanel.title', menuLabel: 'Plan & approval', shortcut: 4, requiresSession: true },
  { id: 'delegatedTasks', kind: 'inspector', labelKey: 'delegatedTasks.title', menuLabelKey: 'delegatedTasks.title', menuLabel: 'Delegated tasks', shortcut: 5, requiresSession: false },
  { id: 'document', kind: 'inspector', labelKey: 'documentPanel.title', menuLabelKey: 'documentPanel.title', menuLabel: 'Document', shortcut: 6, requiresSession: false },
  { id: 'diff', kind: 'inspector', labelKey: 'diffPanel.title', menuLabelKey: 'diffPanel.title', menuLabel: 'Session diff', shortcut: 7, requiresSession: true },
];

export const WORKSPACE_VIEW_PANEL_IDS: readonly WorkspaceViewPanelId[] = WORKSPACE_PANELS.filter(
  (panel) => panel.kind === 'view'
).map((panel) => panel.id as WorkspaceViewPanelId);

export const WORKSPACE_INSPECTOR_PANEL_IDS: readonly WorkspaceInspectorPanelId[] = WORKSPACE_PANELS.filter(
  (panel) => panel.kind === 'inspector'
).map((panel) => panel.id as WorkspaceInspectorPanelId);

export function isWorkspaceViewPanelId(id: WorkspacePanelId): id is WorkspaceViewPanelId {
  return (WORKSPACE_VIEW_PANEL_IDS as readonly WorkspacePanelId[]).includes(id);
}

export function isWorkspaceInspectorPanelId(id: WorkspacePanelId): id is WorkspaceInspectorPanelId {
  return (WORKSPACE_INSPECTOR_PANEL_IDS as readonly WorkspacePanelId[]).includes(id);
}
