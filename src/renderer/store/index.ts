import { create } from 'zustand';
import type {
  Session,
  Message,
  TraceStep,
  PermissionRequest,
  SudoPasswordRequest,
  Settings,
  AppConfig,
  SandboxSetupProgress,
  SandboxSyncStatus,
  SkillsStorageChangeEvent,
  Project,
} from '../types';
import type {
  TaskRunProgress,
  TaskRunResult,
  WorkflowState,
} from '../../shared/workflow-types';
import type {
  AutonomyLevel,
  FolderGrant,
  MachineAccessHistoryEntry,
  MachineAccessPermissionState,
} from '../types';
import { applySessionUpdate } from '../utils/session-update';

type GlobalNoticeType = 'info' | 'warning' | 'error' | 'success';

/** Dedicated full-width project pages (list or detail). */
type ProjectsPageState =
  | { view: 'list' }
  | { view: 'detail'; projectId: string };
export type GlobalNoticeAction = 'open_api_settings';

export interface GlobalNotice {
  id: string;
  message: string;
  messageKey?: string;
  messageValues?: Record<string, string | number>;
  type: GlobalNoticeType;
  actionLabel?: string;
  action?: GlobalNoticeAction;
}

export interface SessionExecutionClock {
  startAt: number | null;
  endAt: number | null;
}

export interface CompactionEvent {
  id: string;
  timestamp: number;
  tokensBefore: number;
  tokensAfter: number | null;
  summary: string;
  readFiles: string[];
  modifiedFiles: string[];
  type: 'auto' | 'manual';
}

// Unified per-session state that replaces 8 parallel xxxBySession Maps
export interface SessionState {
  messages: Message[];
  partialMessage: string;
  partialThinking: string;
  pendingTurns: string[];
  activeTurn: { stepId: string; userMessageId: string } | null;
  executionClock: SessionExecutionClock;
  traceSteps: TraceStep[];
  contextWindow: number;
  compactionHistory: CompactionEvent[];
}

const DEFAULT_SESSION_STATE: SessionState = {
  messages: [],
  partialMessage: '',
  partialThinking: '',
  pendingTurns: [],
  activeTurn: null,
  executionClock: { startAt: null, endAt: null },
  traceSteps: [],
  contextWindow: 0,
  compactionHistory: [],
};

// Helper to immutably update a single session's state within the record
function patchSession(
  states: Record<string, SessionState>,
  sessionId: string,
  updates: Partial<SessionState>
): Record<string, SessionState> {
  const current = states[sessionId] ?? DEFAULT_SESSION_STATE;
  return {
    ...states,
    [sessionId]: { ...current, ...updates },
  };
}

// Helper to get a session's state with safe defaults
function getSession(states: Record<string, SessionState>, sessionId: string): SessionState {
  return states[sessionId] ?? DEFAULT_SESSION_STATE;
}

/** Slice shape for controlled machine access. Mirrors the IPC contract. */
interface MachineAccessStoreState {
  /** False in WSL/Lima/SSH/Daytona: machine access is genuinely inactive. */
  nativeMode: boolean;
  grants: FolderGrant[];
  autonomy: AutonomyLevel;
  allowedApps: string[];
  permissions: MachineAccessPermissionState[];
  history: MachineAccessHistoryEntry[];
  backupQuotaBytes?: number;
}

const EMPTY_MACHINE_ACCESS: MachineAccessStoreState = {
  nativeMode: false,
  grants: [],
  autonomy: 'ask-always',
  allowedApps: [],
  permissions: [],
  history: [],
};

interface AppState {
  // Sessions
  sessions: Session[];
  activeSessionId: string | null;

  // Projects (grouped sessions with shared working context)
  projects: Project[];
  /** Project whose sessions are shown / that new sessions start in; null = all sessions. */
  activeProjectId: string | null;
  /** Projects editor modal: open flag + project being edited (null = creating). */
  showProjectsModal: boolean;
  projectsModalProjectId: string | null;
  /** Dedicated full-width pages: project list or a single project's detail. */
  projectsPage: ProjectsPageState | null;

  /** Background delegated tasks currently running (badge in the main view). */
  runningBackgroundTasks: Array<{ taskId: string; sessionId: string; title: string }>;
  /** Bumped on every background.task event so tracking views refetch. */
  delegationsVersion: number;
  /**
   * "Notify when a task finishes" delegation setting. Gates the completion
   * toast, the badge flash and the native notification alike.
   */
  notifyOnCompletion: boolean;
  /** Delegated-tasks tracking panel visibility. */
  delegatedTasksVisible: boolean;
  /** Dedicated full-width Sub-agents view (same level as the projects pages). */
  subAgentsVisible: boolean;
  /** Pending skill proposals awaiting human approval (sidebar badge). */
  pendingProposalCount: number;

  // Per-session state (messages, partials, turns, traces, etc.)
  sessionStates: Record<string, SessionState>;

  // Ephemeral viewport state, kept separate so scrolling does not rerender message consumers.
  sessionScrollPositions: Record<string, number>;

  // Workflow (Plan -> Act -> Verify) state per session, pushed from the main
  // process on every transition so the status banner stays live.
  workflowStates: Record<string, WorkflowState>;
  // Finished task results per session, keyed by task id so a retry replaces
  // the previous run instead of being summed twice.
  workflowTaskResults: Record<string, Record<string, TaskRunResult>>;
  // Throttled live budget updates for tasks that are still running.
  workflowTaskProgress: Record<string, Record<string, TaskRunProgress>>;

  // UI state
  isLoading: boolean;
  sidebarCollapsed: boolean;
  contextPanelCollapsed: boolean;
  diffPanelVisible: boolean;
  planPanelVisible: boolean;
  memoryPanelVisible: boolean;
  controlCenterVisible: boolean;
  modelRoutingVisible: boolean;
  documentPanelVisible: boolean;
  showSettings: boolean;
  settingsTab: string | null;

  // Machine access (controlled direct access to the machine). `null` until the
  // first load, so the UI can say "loading" instead of inventing empty state.
  machineAccess: MachineAccessStoreState;
  machineAccessLoading: boolean;
  machineAccessError: string | null;
  /** True right after an emergency stop, until work resumes. */
  machineAccessStopped: boolean;
  /** Workspace the machine-access panel operates on (batch ops need it). */
  machineAccessWorkspaceRoot: string;

  // Permission
  pendingPermission: PermissionRequest | null;

  // Sudo password
  pendingSudoPassword: SudoPasswordRequest | null;

  // Settings
  settings: Settings;

  // App Config (API settings)
  appConfig: AppConfig | null;
  isConfigured: boolean;
  showConfigModal: boolean;
  hasSeenInitialConfigStatus: boolean;
  globalNotice: GlobalNotice | null;

  // Working directory
  workingDir: string | null;

  // Sandbox setup
  sandboxSetupProgress: SandboxSetupProgress | null;
  isSandboxSetupComplete: boolean;

  // Sandbox sync (per-session)
  sandboxSyncStatus: SandboxSyncStatus | null;
  skillsStorageChangedAt: number;
  skillsStorageChangeEvent: SkillsStorageChangeEvent | null;

  // System theme (from OS native theme)
  systemDarkMode: boolean;

  // Actions
  setSessions: (sessions: Session[]) => void;
  addSession: (session: Session) => void;
  updateSession: (sessionId: string, updates: Partial<Session>) => void;
  removeSession: (sessionId: string) => void;
  removeSessions: (sessionIds: string[]) => void;
  setActiveSession: (sessionId: string | null) => void;
  setSessionScrollPosition: (sessionId: string, scrollTop: number) => void;

  // Projects actions
  setProjects: (projects: Project[]) => void;
  setActiveProjectId: (projectId: string | null) => void;
  openProjectsModal: (projectId: string | null) => void;
  closeProjectsModal: () => void;
  openProjectsList: () => void;
  openProjectDetail: (projectId: string) => void;
  closeProjectsPage: () => void;
  addRunningBackgroundTask: (task: { taskId: string; sessionId: string; title: string }) => void;
  removeRunningBackgroundTask: (taskId: string) => void;
  bumpDelegationsVersion: () => void;
  setNotifyOnCompletion: (enabled: boolean) => void;
  setDelegatedTasksVisible: (visible: boolean) => void;
  setSubAgentsVisible: (visible: boolean) => void;
  setPendingProposalCount: (count: number) => void;

  addMessage: (sessionId: string, message: Message) => void;
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  startExecutionClock: (sessionId: string, startAt: number) => void;
  finishExecutionClock: (sessionId: string, endAt?: number) => void;
  clearExecutionClock: (sessionId: string) => void;
  setMessages: (sessionId: string, messages: Message[]) => void;
  setPartialMessage: (sessionId: string, partial: string) => void;
  clearPartialMessage: (sessionId: string) => void;
  setPartialThinking: (sessionId: string, delta: string) => void;
  clearPartialThinking: (sessionId: string) => void;
  activateNextTurn: (sessionId: string, stepId: string) => void;
  updateActiveTurnStep: (sessionId: string, stepId: string) => void;
  clearActiveTurn: (sessionId: string, stepId?: string) => void;
  clearPendingTurns: (sessionId: string) => void;
  clearQueuedMessages: (sessionId: string) => void;
  cancelQueuedMessages: (sessionId: string) => void;

  addTraceStep: (sessionId: string, step: TraceStep) => void;
  updateTraceStep: (sessionId: string, stepId: string, updates: Partial<TraceStep>) => void;
  setTraceSteps: (sessionId: string, steps: TraceStep[]) => void;

  setLoading: (loading: boolean) => void;
  toggleSidebar: () => void;
  toggleContextPanel: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setContextPanelCollapsed: (collapsed: boolean) => void;
  setDiffPanelVisible: (visible: boolean) => void;
  setPlanPanelVisible: (visible: boolean) => void;
  setMemoryPanelVisible: (visible: boolean) => void;
  setControlCenterVisible: (visible: boolean) => void;
  setModelRoutingVisible: (visible: boolean) => void;
  setDocumentPanelVisible: (visible: boolean) => void;
  setShowSettings: (show: boolean) => void;
  setSettingsTab: (tab: string | null) => void;
  loadMachineAccess: (args?: { workspaceRoot?: string; projectId?: string }) => Promise<void>;
  addMachineAccessGrant: (args?: {
    access?: 'read' | 'read-write';
    scope?: 'session' | 'project' | 'permanent';
    expiresAt?: number;
  }) => Promise<void>;
  revokeMachineAccessGrant: (id: string) => Promise<void>;
  setMachineAccessAutonomy: (level: AutonomyLevel) => Promise<void>;
  addMachineAccessApp: (name: string) => Promise<void>;
  removeMachineAccessApp: (name: string) => Promise<void>;
  undoMachineAccessBatch: (batchId: string) => Promise<void>;
  machineAccessEmergencyStop: () => Promise<void>;
  setWorkflowState: (sessionId: string, state: WorkflowState) => void;
  setWorkflowTaskResult: (sessionId: string, result: TaskRunResult) => void;
  setWorkflowTaskProgress: (sessionId: string, progress: TaskRunProgress) => void;

  setPendingPermission: (permission: PermissionRequest | null) => void;

  setPendingSudoPassword: (request: SudoPasswordRequest | null) => void;

  setSettings: (updates: Partial<Settings>) => void;
  updateSettings: (updates: Partial<Settings>) => void;

  // Config actions
  setAppConfig: (config: AppConfig | null) => void;
  setIsConfigured: (configured: boolean) => void;
  setShowConfigModal: (show: boolean) => void;
  markInitialConfigStatusSeen: () => void;
  setGlobalNotice: (notice: GlobalNotice | null) => void;
  clearGlobalNotice: () => void;

  // Working directory actions
  setWorkingDir: (path: string | null) => void;

  // Sandbox setup actions
  setSandboxSetupProgress: (progress: SandboxSetupProgress | null) => void;
  setSandboxSetupComplete: (complete: boolean) => void;

  // Sandbox sync actions
  setSandboxSyncStatus: (status: SandboxSyncStatus | null) => void;
  setSkillsStorageChangedAt: (timestamp: number) => void;
  setSkillsStorageChangeEvent: (event: SkillsStorageChangeEvent | null) => void;

  // Context window actions
  setSessionContextWindow: (sessionId: string, contextWindow: number) => void;

  // Compaction history actions
  addCompactionEvent: (sessionId: string, event: CompactionEvent) => void;

  // System theme actions
  setSystemDarkMode: (dark: boolean) => void;
}

const defaultSettings: Settings = {
  theme: 'light',
  defaultTools: [
    'askuserquestion',
    'todowrite',
    'todoread',
    'webfetch',
    'websearch',
    'read',
    'write',
    'edit',
    'list_directory',
    'glob',
    'grep',
  ],
  permissionRules: [
    { tool: 'read', action: 'allow' },
    { tool: 'glob', action: 'allow' },
    { tool: 'grep', action: 'allow' },
    { tool: 'write', action: 'ask' },
    { tool: 'edit', action: 'ask' },
    { tool: 'bash', action: 'ask' },
  ],
  autoApproveAll: false,
  systemNotifications: true,
  globalSkillsPath: '',
  memoryStrategy: 'auto',
  maxContextTokens: 180000,
};

export const useAppStore = create<AppState>((set) => ({
  // Initial state
  sessions: [],
  activeSessionId: null,
  projects: [],
  activeProjectId: null,
  showProjectsModal: false,
  projectsModalProjectId: null,
  projectsPage: null,
  runningBackgroundTasks: [],
  delegationsVersion: 0,
  // Matches DEFAULT_DELEGATION_SETTINGS.notifyOnCompletion until the real
  // setting is hydrated from the main process.
  notifyOnCompletion: true,
  delegatedTasksVisible: false,
  subAgentsVisible: false,
  pendingProposalCount: 0,
  sessionStates: {},
  sessionScrollPositions: {},
  workflowStates: {},
  workflowTaskResults: {},
  workflowTaskProgress: {},
  isLoading: false,
  sidebarCollapsed: false,
  contextPanelCollapsed: false,
  diffPanelVisible: false,
  planPanelVisible: false,
  memoryPanelVisible: false,
  controlCenterVisible: false,
  modelRoutingVisible: false,
  documentPanelVisible: false,
  showSettings: false,
  settingsTab: null,
  machineAccess: EMPTY_MACHINE_ACCESS,
  machineAccessLoading: false,
  machineAccessError: null,
  machineAccessStopped: false,
  machineAccessWorkspaceRoot: '',
  pendingPermission: null,
  pendingSudoPassword: null,
  settings: defaultSettings,
  appConfig: null,
  isConfigured: false,
  showConfigModal: false,
  hasSeenInitialConfigStatus: false,
  globalNotice: null,
  workingDir: null,
  sandboxSetupProgress: null,
  isSandboxSetupComplete: false,
  sandboxSyncStatus: null,
  skillsStorageChangedAt: 0,
  skillsStorageChangeEvent: null,
  systemDarkMode: false,

  // Session actions
  setSessions: (sessions) => set({ sessions }),

  // Projects
  setProjects: (projects) => set({ projects }),
  setActiveProjectId: (projectId) => set({ activeProjectId: projectId }),
  openProjectsModal: (projectId) =>
    set({ showProjectsModal: true, projectsModalProjectId: projectId }),
  closeProjectsModal: () => set({ showProjectsModal: false, projectsModalProjectId: null }),
  openProjectsList: () => set({ projectsPage: { view: 'list' } }),
  openProjectDetail: (projectId) => set({ projectsPage: { view: 'detail', projectId } }),
  closeProjectsPage: () => set({ projectsPage: null }),
  addRunningBackgroundTask: (task) =>
    set((state) => ({
      runningBackgroundTasks: state.runningBackgroundTasks.some(
        (t) => t.taskId === task.taskId
      )
        ? state.runningBackgroundTasks
        : [...state.runningBackgroundTasks, task],
    })),
  removeRunningBackgroundTask: (taskId) =>
    set((state) => ({
      runningBackgroundTasks: state.runningBackgroundTasks.filter((t) => t.taskId !== taskId),
    })),
  bumpDelegationsVersion: () => set((state) => ({ delegationsVersion: state.delegationsVersion + 1 })),
  setNotifyOnCompletion: (enabled) => set({ notifyOnCompletion: enabled }),
  setDelegatedTasksVisible: (visible) => set({ delegatedTasksVisible: visible }),
  setSubAgentsVisible: (visible) => set({ subAgentsVisible: visible }),
  setPendingProposalCount: (count) => set({ pendingProposalCount: Math.max(0, count) }),

  addSession: (session) =>
    set((state) => ({
      sessions: [session, ...state.sessions],
      sessionStates: {
        ...state.sessionStates,
        [session.id]: { ...DEFAULT_SESSION_STATE },
      },
    })),

  updateSession: (sessionId, updates) =>
    set((state) => ({
      sessions: applySessionUpdate(state.sessions, sessionId, updates),
    })),

  removeSession: (sessionId) =>
    set((state) => {
      const { [sessionId]: _removed, ...restSessionStates } = state.sessionStates;
      const restScrollPositions = Object.fromEntries(
        Object.entries(state.sessionScrollPositions).filter(([id]) => id !== sessionId)
      );
      return {
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        sessionStates: restSessionStates,
        sessionScrollPositions: restScrollPositions,
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
      };
    }),

  removeSessions: (sessionIds) =>
    set((state) => {
      const idSet = new Set(sessionIds);
      const newSessionStates: Record<string, SessionState> = {};
      const newScrollPositions: Record<string, number> = {};
      for (const key of Object.keys(state.sessionStates)) {
        if (!idSet.has(key)) newSessionStates[key] = state.sessionStates[key];
      }
      for (const key of Object.keys(state.sessionScrollPositions)) {
        if (!idSet.has(key)) newScrollPositions[key] = state.sessionScrollPositions[key];
      }

      return {
        sessions: state.sessions.filter((s) => !idSet.has(s.id)),
        sessionStates: newSessionStates,
        sessionScrollPositions: newScrollPositions,
        activeSessionId:
          state.activeSessionId && idSet.has(state.activeSessionId) ? null : state.activeSessionId,
      };
    }),

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  setSessionScrollPosition: (sessionId, scrollTop) =>
    set((state) => ({
      sessionScrollPositions: {
        ...state.sessionScrollPositions,
        [sessionId]: scrollTop,
      },
    })),

  // Message actions
  addMessage: (sessionId, message) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      const messages = ss.messages;
      let updatedMessages = messages;
      let updatedPendingTurns = ss.pendingTurns;

      if (message.role === 'user') {
        updatedMessages = [...messages, message];
        updatedPendingTurns = [...ss.pendingTurns, message.id];
      } else {
        const activeTurn = ss.activeTurn;
        if (activeTurn?.userMessageId) {
          const anchorIndex = messages.findIndex((item) => item.id === activeTurn.userMessageId);
          if (anchorIndex >= 0) {
            let insertIndex = anchorIndex + 1;
            while (insertIndex < messages.length) {
              if (messages[insertIndex].role === 'user') break;
              insertIndex += 1;
            }
            updatedMessages = [
              ...messages.slice(0, insertIndex),
              message,
              ...messages.slice(insertIndex),
            ];
          } else {
            updatedMessages = [...messages, message];
          }
        } else {
          updatedMessages = [...messages, message];
        }
      }

      const shouldClearPartial = message.role === 'assistant';
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          messages: updatedMessages,
          pendingTurns: updatedPendingTurns,
          ...(shouldClearPartial ? { partialMessage: '', partialThinking: '' } : {}),
        }),
      };
    }),

  updateMessage: (sessionId, messageId, updates) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      const idx = ss.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {};
      const updatedMessages = ss.messages.map((m) =>
        m.id === messageId ? { ...m, ...updates } : m
      );
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, { messages: updatedMessages }),
      };
    }),

  startExecutionClock: (sessionId, startAt) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, {
        executionClock: { startAt, endAt: null },
      }),
    })),

  finishExecutionClock: (sessionId, endAt) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      if (ss.executionClock.startAt === null) return {};
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          executionClock: {
            startAt: ss.executionClock.startAt,
            endAt: endAt ?? Date.now(),
          },
        }),
      };
    }),

  clearExecutionClock: (sessionId) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, {
        executionClock: { startAt: null, endAt: null },
      }),
    })),

  setMessages: (sessionId, messages) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { messages }),
    })),

  setPartialMessage: (sessionId, partial) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          partialMessage: ss.partialMessage + partial,
        }),
      };
    }),

  clearPartialMessage: (sessionId) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { partialMessage: '' }),
    })),

  setPartialThinking: (sessionId, delta) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          partialThinking: ss.partialThinking + delta,
        }),
      };
    }),

  clearPartialThinking: (sessionId) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { partialThinking: '' }),
    })),

  activateNextTurn: (sessionId, stepId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      if (ss.pendingTurns.length === 0) {
        return {
          sessionStates: patchSession(state.sessionStates, sessionId, {
            activeTurn: null,
          }),
        };
      }

      const [nextMessageId, ...rest] = ss.pendingTurns;
      const updatedMessages = ss.messages.map((message) =>
        message.id === nextMessageId ? { ...message, localStatus: undefined } : message
      );

      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          messages: updatedMessages,
          pendingTurns: rest,
          activeTurn: { stepId, userMessageId: nextMessageId },
        }),
      };
    }),

  updateActiveTurnStep: (sessionId, stepId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      if (!ss.activeTurn || ss.activeTurn.stepId === stepId) return {};
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          activeTurn: { ...ss.activeTurn, stepId },
        }),
      };
    }),

  clearActiveTurn: (sessionId, stepId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      if (!ss.activeTurn) return {};
      if (stepId && ss.activeTurn.stepId !== stepId) return {};
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          activeTurn: null,
        }),
      };
    }),

  clearPendingTurns: (sessionId) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { pendingTurns: [] }),
    })),

  clearQueuedMessages: (sessionId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      let hasQueued = false;
      const updatedMessages = ss.messages.map((message) => {
        if (message.localStatus === 'queued') {
          hasQueued = true;
          return { ...message, localStatus: undefined };
        }
        return message;
      });
      // Also remove any queued message IDs from pendingTurns
      const queuedIds = new Set(
        ss.messages.filter((m) => m.localStatus === 'queued').map((m) => m.id)
      );
      const updatedPendingTurns = ss.pendingTurns.filter((id) => !queuedIds.has(id));
      if (!hasQueued) return {};
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          messages: updatedMessages,
          pendingTurns: updatedPendingTurns,
        }),
      };
    }),

  cancelQueuedMessages: (sessionId) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      let hasQueued = false;
      const updatedMessages = ss.messages.map((message) => {
        if (message.localStatus === 'queued') {
          hasQueued = true;
          return { ...message, localStatus: 'cancelled' as const };
        }
        return message;
      });
      if (!hasQueued) return {};
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          messages: updatedMessages,
        }),
      };
    }),

  // Trace actions
  addTraceStep: (sessionId, step) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          traceSteps: [...ss.traceSteps, step],
        }),
      };
    }),

  updateTraceStep: (sessionId, stepId, updates) =>
    set((state) => {
      const ss = getSession(state.sessionStates, sessionId);
      return {
        sessionStates: patchSession(state.sessionStates, sessionId, {
          traceSteps: ss.traceSteps.map((step) =>
            step.id === stepId ? { ...step, ...updates } : step
          ),
        }),
      };
    }),

  setTraceSteps: (sessionId, steps) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { traceSteps: steps }),
    })),

  // UI actions
  setLoading: (loading) => set({ isLoading: loading }),
  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  toggleContextPanel: () =>
    set((state) => ({ contextPanelCollapsed: !state.contextPanelCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setContextPanelCollapsed: (collapsed) => set({ contextPanelCollapsed: collapsed }),
  setDiffPanelVisible: (visible) => set({ diffPanelVisible: visible }),
  setPlanPanelVisible: (visible) => set({ planPanelVisible: visible }),
  setMemoryPanelVisible: (visible) => set({ memoryPanelVisible: visible }),
  setControlCenterVisible: (visible) => set({ controlCenterVisible: visible }),
  setModelRoutingVisible: (visible) => set({ modelRoutingVisible: visible }),
  setDocumentPanelVisible: (visible) => set({ documentPanelVisible: visible }),
  setShowSettings: (show) => set({ showSettings: show }),
  setSettingsTab: (tab) => set({ settingsTab: tab }),

  loadMachineAccess: async (args) => {
    set({ machineAccessLoading: true, machineAccessError: null });
    try {
      const state = await window.electronAPI.machineAccess.getState(args ?? {});
      set({
        machineAccess: {
          nativeMode: state.nativeMode,
          grants: state.grants ?? [],
          autonomy: state.autonomy ?? 'ask-always',
          allowedApps: state.allowedApps ?? [],
          permissions: state.permissions ?? [],
          history: state.history ?? [],
          backupQuotaBytes: state.backupQuotaBytes,
        },
        machineAccessLoading: false,
      });
    } catch (error) {
      set({
        machineAccessLoading: false,
        machineAccessError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  addMachineAccessGrant: async (args) => {
    // The path comes from the native picker in the main process; the renderer
    // never supplies one, so the model cannot grant itself a folder.
    const result = await window.electronAPI.machineAccess.pickFolder(args ?? {});
    if (result.granted) await useAppStore.getState().loadMachineAccess();
  },

  revokeMachineAccessGrant: async (id) => {
    await window.electronAPI.machineAccess.revokeGrant({ id });
    await useAppStore.getState().loadMachineAccess();
  },

  setMachineAccessAutonomy: async (level) => {
    const result = await window.electronAPI.machineAccess.setAutonomy({
      projectId: useAppStore.getState().activeProjectId ?? 'default',
      level,
    });
    set({ machineAccess: { ...useAppStore.getState().machineAccess, autonomy: level } });
    void result;
  },

  addMachineAccessApp: async (name) => {
    const result = await window.electronAPI.machineAccess.addApp({ name });
    set({ machineAccess: { ...useAppStore.getState().machineAccess, allowedApps: result.allowedApps } });
  },

  removeMachineAccessApp: async (name) => {
    const result = await window.electronAPI.machineAccess.removeApp({ name });
    set({ machineAccess: { ...useAppStore.getState().machineAccess, allowedApps: result.allowedApps } });
  },

  undoMachineAccessBatch: async (batchId) => {
    const { activeProjectId } = useAppStore.getState();
    await window.electronAPI.machineAccess.undoBatch({
      workspaceRoot: useAppStore.getState().machineAccessWorkspaceRoot,
      projectId: activeProjectId ?? 'default',
      batchId,
    });
    await useAppStore.getState().loadMachineAccess();
  },

  machineAccessEmergencyStop: async () => {
    await window.electronAPI.machineAccess.emergencyStop();
    set({ machineAccessStopped: true });
  },

  setWorkflowState: (sessionId, state) =>
    set((current) => {
      const previous = current.workflowStates[sessionId];
      // A different contract means a new plan: results and live progress from
      // the previous run must not be summed into the new one.
      const planChanged = previous !== undefined && previous.contractId !== state.contractId;
      return {
        workflowStates: { ...current.workflowStates, [sessionId]: state },
        workflowTaskResults: planChanged
          ? { ...current.workflowTaskResults, [sessionId]: {} }
          : current.workflowTaskResults,
        workflowTaskProgress: planChanged
          ? { ...current.workflowTaskProgress, [sessionId]: {} }
          : current.workflowTaskProgress,
      };
    }),
  setWorkflowTaskResult: (sessionId, result) =>
    set((current) => ({
      workflowTaskResults: {
        ...current.workflowTaskResults,
        [sessionId]: {
          ...(current.workflowTaskResults[sessionId] ?? {}),
          [result.taskId]: result,
        },
      },
    })),
  setWorkflowTaskProgress: (sessionId, progress) =>
    set((current) => ({
      workflowTaskProgress: {
        ...current.workflowTaskProgress,
        [sessionId]: {
          ...(current.workflowTaskProgress[sessionId] ?? {}),
          [progress.taskId]: progress,
        },
      },
    })),

  // Permission actions
  setPendingPermission: (permission) => set({ pendingPermission: permission }),

  // Sudo password actions
  setPendingSudoPassword: (request) => set({ pendingSudoPassword: request }),

  // Settings actions
  setSettings: (updates) =>
    set((state) => ({
      settings: { ...state.settings, ...updates },
    })),
  updateSettings: (updates) => {
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.send({
        type: 'settings.update',
        payload: updates as Record<string, unknown>,
      });
    }
    set((state) => ({
      settings: { ...state.settings, ...updates },
    }));
  },

  // Config actions
  setAppConfig: (config) => set({ appConfig: config }),
  setIsConfigured: (configured) => set({ isConfigured: configured }),
  setShowConfigModal: (show) => set({ showConfigModal: show }),
  markInitialConfigStatusSeen: () => set({ hasSeenInitialConfigStatus: true }),
  setGlobalNotice: (notice) => set({ globalNotice: notice }),
  clearGlobalNotice: () => set({ globalNotice: null }),

  // Working directory actions
  setWorkingDir: (path) => set({ workingDir: path }),

  // Sandbox setup actions
  setSandboxSetupProgress: (progress) => set({ sandboxSetupProgress: progress }),
  setSandboxSetupComplete: (complete) => set({ isSandboxSetupComplete: complete }),

  // Sandbox sync actions
  setSandboxSyncStatus: (status) => set({ sandboxSyncStatus: status }),
  setSkillsStorageChangedAt: (timestamp) => set({ skillsStorageChangedAt: timestamp }),
  setSkillsStorageChangeEvent: (event) => set({ skillsStorageChangeEvent: event }),

  // Context window actions
  setSessionContextWindow: (sessionId, contextWindow) =>
    set((state) => ({
      sessionStates: patchSession(state.sessionStates, sessionId, { contextWindow }),
    })),

  // Compaction history actions
  addCompactionEvent: (sessionId, event) =>
    set((state) => {
      const current = state.sessionStates[sessionId] ?? DEFAULT_SESSION_STATE;
      return {
        sessionStates: {
          ...state.sessionStates,
          [sessionId]: {
            ...current,
            compactionHistory: [...current.compactionHistory, event],
          },
        },
      };
    }),

  // System theme actions
  setSystemDarkMode: (dark) => set({ systemDarkMode: dark }),
}));

// Expose helpers for nav-server (CLI-driven UI navigation via executeJavaScript)
if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;

  w.__getNavStatus = () => {
    const s = useAppStore.getState();
    return {
      showSettings: !!s.showSettings,
      activeSessionId: s.activeSessionId || null,
      sessionCount: (s.sessions || []).length,
    };
  };

  w.__navigate = (page: string, tab?: string, sessionId?: string) => {
    const store = useAppStore.getState();
    if (page === 'welcome') {
      store.setShowSettings(false);
      store.setActiveSession(null);
    } else if (page === 'settings') {
      store.setSettingsTab(tab || 'api');
      store.setShowSettings(true);
    } else if (page === 'session') {
      if (!sessionId || typeof sessionId !== 'string') return false;
      const exists = store.sessions.some((s) => s.id === sessionId);
      if (!exists) return false;
      store.setShowSettings(false);
      store.setActiveSession(sessionId);
      // This bridge only flips the active session: without the loads below the
      // pane renders empty (verified live 2026-09-27). Mirror the Sidebar
      // click flow so scripted navigation shows real content.
      const state = useAppStore.getState().sessionStates[sessionId];
      const needsMessages = !state?.messages?.length;
      const needsSteps = !state?.traceSteps?.length;
      if (
        (needsMessages || needsSteps) &&
        typeof window !== 'undefined' &&
        window.electronAPI
      ) {
        if (needsMessages) {
          window.electronAPI
            .invoke<Message[]>({ type: 'session.getMessages', payload: { sessionId } })
            .then((messages) => {
              if (Array.isArray(messages) && messages.length > 0) {
                useAppStore.getState().setMessages(sessionId, messages);
              }
            })
            .catch((err: unknown) => {
              console.error('[__navigate] Failed to load session messages:', err);
            });
        }
        if (needsSteps) {
          window.electronAPI
            .invoke<TraceStep[]>({ type: 'session.getTraceSteps', payload: { sessionId } })
            .then((steps) => {
              useAppStore.getState().setTraceSteps(sessionId, Array.isArray(steps) ? steps : []);
            })
            .catch((err: unknown) => {
              console.error('[__navigate] Failed to load trace steps:', err);
            });
        }
      }
    }
    return true;
  };
}
