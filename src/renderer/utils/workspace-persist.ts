import { WORKSPACE_PANELS, type WorkspacePanelId } from '../../shared/workspace-panels';

/**
 * Persistence for the workspace layout — the "Lot 2" of the session-restore
 * spec, so a restart reopens the app on the panel you were looking at rather
 * than an empty dashboard.
 *
 * Scope is deliberately limited to layout booleans and a session id. No
 * conversation content, no working-directory path, no API key, no shell
 * command: `localStorage` is readable by any script in the renderer, so
 * nothing sensitive may go through it.
 *
 * The session itself is resumed by the main process (`lastActiveSessionId` in
 * the config store). This module only records *which* session the layout
 * belonged to, so the panels can be re-applied to the same session and never
 * to a different one.
 */

const STORAGE_KEY = 'open-cowork.workspace.v1';
const SNAPSHOT_VERSION = 1;
/** Matches the duplicate-toggle window; far below a deliberate second action. */
const SAVE_DEBOUNCE_MS = 300;

export interface WorkspaceSnapshot {
  version: number;
  /** Session the layout was captured against, or `null` on the dashboard. */
  activeSessionId: string | null;
  /** Panel visibility, keyed by {@link WorkspacePanelId}. */
  panels: Partial<Record<WorkspacePanelId, boolean>>;
  sidebarCollapsed: boolean;
  contextPanelCollapsed: boolean;
}

/** The subset of the store this module reads and writes. */
export interface WorkspaceLayoutState {
  activeSessionId: string | null;
  sidebarCollapsed: boolean;
  contextPanelCollapsed: boolean;
  modelRoutingVisible: boolean;
  controlCenterVisible: boolean;
  memoryPanelVisible: boolean;
  planPanelVisible: boolean;
  delegatedTasksVisible: boolean;
  documentPanelVisible: boolean;
  diffPanelVisible: boolean;
}

/** Read by `saveWorkspace`; returns the setters to apply a restored snapshot. */
export interface WorkspaceLayoutSetters {
  setModelRoutingVisible: (visible: boolean) => void;
  setControlCenterVisible: (visible: boolean) => void;
  setMemoryPanelVisible: (visible: boolean) => void;
  setPlanPanelVisible: (visible: boolean) => void;
  setDelegatedTasksVisible: (visible: boolean) => void;
  setDocumentPanelVisible: (visible: boolean) => void;
  setDiffPanelVisible: (visible: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setContextPanelCollapsed: (collapsed: boolean) => void;
}

/**
 * Panel id → the store state key it reads from, and the setter that writes it.
 * The state key is listed explicitly because it does not follow a naming
 * convention: `memory` lives in `memoryPanelVisible`, `plan` in
 * `planPanelVisible`, `document` in `documentPanelVisible`.
 */
const PANEL_STATE_KEYS: Record<WorkspacePanelId, keyof WorkspaceLayoutState> = {
  modelRouting: 'modelRoutingVisible',
  controlCenter: 'controlCenterVisible',
  memory: 'memoryPanelVisible',
  plan: 'planPanelVisible',
  delegatedTasks: 'delegatedTasksVisible',
  document: 'documentPanelVisible',
  diff: 'diffPanelVisible',
};

const PANEL_SETTERS: Record<WorkspacePanelId, keyof WorkspaceLayoutSetters> = {
  modelRouting: 'setModelRoutingVisible',
  controlCenter: 'setControlCenterVisible',
  memory: 'setMemoryPanelVisible',
  plan: 'setPlanPanelVisible',
  delegatedTasks: 'setDelegatedTasksVisible',
  document: 'setDocumentPanelVisible',
  diff: 'setDiffPanelVisible',
};

const ALL_PANEL_IDS = WORKSPACE_PANELS.map((panel) => panel.id);

/**
 * `localStorage` is absent in the headless CLI and throws in a sandboxed or
 * quota-exhausted context, so every access is guarded and degrades to a no-op.
 */
function getStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Accessing localStorage throws when cookies/storage are blocked.
    return null;
  }
}

function toBooleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function toSessionIdOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read the persisted layout.
 *
 * A corrupt payload, a snapshot from a future version, or an unparseable
 * value is ignored and reported as `null` — a bad snapshot must never make the
 * app fail to start.
 */
export function loadWorkspace(): WorkspaceSnapshot | null {
  const storage = getStorage();
  if (!storage) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const candidate = parsed as Record<string, unknown>;
  // A version bump means the layout semantics may have changed; restoring an
  // old layout against new code is not worth guessing at.
  if (candidate.version !== SNAPSHOT_VERSION) return null;

  const panels: Partial<Record<WorkspacePanelId, boolean>> = {};
  if (typeof candidate.panels === 'object' && candidate.panels !== null) {
    const rawPanels = candidate.panels as Record<string, unknown>;
    for (const id of ALL_PANEL_IDS) {
      const value = toBooleanOrUndefined(rawPanels[id]);
      if (value !== undefined) panels[id] = value;
    }
  }

  const sidebarCollapsed = toBooleanOrUndefined(candidate.sidebarCollapsed);
  const contextPanelCollapsed = toBooleanOrUndefined(candidate.contextPanelCollapsed);
  const activeSessionId = toSessionIdOrNull(candidate.activeSessionId);

  // Every field optional: a snapshot missing layout flags still restores the
  // session association, and vice versa. Only a non-object is a hard reject.
  return {
    version: SNAPSHOT_VERSION,
    activeSessionId: activeSessionId === undefined ? null : activeSessionId,
    panels,
    sidebarCollapsed: sidebarCollapsed === true,
    contextPanelCollapsed: contextPanelCollapsed === true,
  };
}

export function captureWorkspace(state: WorkspaceLayoutState): WorkspaceSnapshot {
  const panels: Partial<Record<WorkspacePanelId, boolean>> = {};
  for (const id of ALL_PANEL_IDS) {
    panels[id] = Boolean(state[PANEL_STATE_KEYS[id]]);
  }
  return {
    version: SNAPSHOT_VERSION,
    activeSessionId: state.activeSessionId,
    panels,
    sidebarCollapsed: state.sidebarCollapsed,
    contextPanelCollapsed: state.contextPanelCollapsed,
  };
}

export function saveWorkspace(snapshot: WorkspaceSnapshot): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota exceeded or storage disabled — losing layout is not fatal.
  }
}

export function clearWorkspace(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the next save will overwrite it.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Latest state, so a debounced save always writes the newest layout. */
let pending: WorkspaceSnapshot | null = null;

/**
 * Coalesce layout writes. Toggling a panel can fire several renders in a row;
 * writing on each one would hit `localStorage` needlessly.
 */
export function scheduleWorkspaceSave(state: WorkspaceLayoutState): void {
  pending = captureWorkspace(state);
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = pending;
    pending = null;
    if (snapshot) saveWorkspace(snapshot);
  }, SAVE_DEBOUNCE_MS);
}

/** Flush any pending debounced write immediately (used on teardown/tests). */
export function flushWorkspaceSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const snapshot = pending;
  pending = null;
  if (snapshot) saveWorkspace(snapshot);
}

/**
 * Reopen the app where it was left.
 *
 * Two questions, answered separately because they have different rules:
 *
 * 1. **Global chrome** (collapsed sidebar / context panel) is not tied to a
 *    session, so it restores whenever a snapshot exists.
 * 2. **Panel visibility** is session-scoped. It is applied only when the
 *    snapshot was captured against the exact session being resumed — a diff
 *    panel recorded for session A must never appear over session B. Within
 *    that match, a panel whose `requiresSession` flag is set is skipped when no
 *    session is active, mirroring the gate in `toggleWorkspacePanel`.
 *
 * Returns `true` when the layout was applied.
 */
export function restoreWorkspace(
  snapshot: WorkspaceSnapshot | null,
  state: Pick<WorkspaceLayoutState, 'activeSessionId'>,
  setters: WorkspaceLayoutSetters
): boolean {
  if (!snapshot) return false;

  setters.setSidebarCollapsed(snapshot.sidebarCollapsed);
  setters.setContextPanelCollapsed(snapshot.contextPanelCollapsed);

  const sameSession = snapshot.activeSessionId === state.activeSessionId;
  if (!sameSession) return true;

  for (const panel of WORKSPACE_PANELS) {
    const visible = snapshot.panels[panel.id];
    if (visible === undefined) continue;
    if (panel.requiresSession && state.activeSessionId === null) continue;
    setters[PANEL_SETTERS[panel.id]](visible);
  }

  return true;
}
