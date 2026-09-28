import type { TaskRunProgress, TaskRunResult, WorkflowState } from './workflow-types';

// Session types
export interface Session {
  id: string;
  title: string;
  claudeSessionId?: string;
  openaiThreadId?: string;
  status: SessionStatus;
  cwd?: string;
  mountedPaths: MountedPath[];
  allowedTools: string[];
  memoryEnabled: boolean;
  model?: string;
  isPinned?: boolean;
  /** Project this session belongs to, when linked. */
  projectId?: string;
  /**
   * SESSION-level settings override (highest precedence): a ConfigSet pinned
   * for this session only. null/undefined = inherit the project, then global.
   */
  configSetId?: string | null;
  /** Model pinned inside that set (null/undefined = the set's own model). */
  configModelId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * How a project turns a model response into the answer it presents.
 * - `single`    — one model produces the answer (default, legacy behavior).
 * - `two-stage` — a fast "draft" model produces a first pass, then a more
 *                  capable "refine" model reviews and polishes it. Only the
 *                  finalized text is presented; the draft stays available as a
 *                  collapsible detail and a session log entry.
 */
export type PipelineMode = 'single' | 'two-stage';

/**
 * A Project groups sessions around a shared working context: a workspace
 * folder, persistent instructions, reference files and an optional ConfigSet
 * (provider/model) override. Never hard-deleted — archived only.
 */
export interface Project {
  id: string;
  name: string;
  description: string | null;
  workdir: string;
  configSetId: string | null;
  /** Model pinned INSIDE the selected ConfigSet (null = the set's active model). */
  modelId: string | null;
  /** Answer pipeline for this project: single model (default) or draft→refine. */
  pipelineMode: PipelineMode;
  /** ConfigSet used for the fast draft pass (two-stage only). */
  draftConfigSetId: string | null;
  /** Model pinned inside the draft ConfigSet (null = the set's active model). */
  draftModelId: string | null;
  /** ConfigSet used for the refine pass (two-stage only; required to activate). */
  refineConfigSetId: string | null;
  /** Model pinned inside the refine ConfigSet (null = the set's active model). */
  refineModelId: string | null;
  instructions: string | null;
  archived: boolean;
  /** Absolute paths of attached reference files (read-only context at session start). */
  referenceFiles: string[];
  createdAt: number;
  updatedAt: number;
}

/** Real context-injection budget usage for a project (mirrors project-context.ts). */
export interface ProjectContextUsage {
  /** Chars of instructions injected (capped). */
  instructionsChars: number;
  /** Chars of reference-file content injected (sequential budget, capped). */
  filesChars: number;
  /** Total injection budget: instructions cap + files cap. */
  maxChars: number;
  /** How many of the attached files will actually be injected. */
  filesInjected: number;
  filesTotal: number;
}

/** Structured self-report produced by an autonomous delegated task. */
interface BackgroundTaskReport {
  summary: string;
  findings: string;
  assumptions: string;
  limits: string;
}

interface BackgroundTaskLogEntry {
  at: number;
  kind: 'launched' | 'tool' | 'completed' | 'failed' | 'cancelled';
  text: string;
}

/** One delegated background task, as surfaced to the UI. */
export interface BackgroundTask {
  id: string;
  sessionId: string;
  title: string;
  prompt: string;
  role: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  completedAt?: number;
  modelUsed?: string;
  /** Hierarchy depth: 1 = main agent's delegation, 2 = recursive child (hard cap). */
  depth: number;
  /** Cumulative token usage of THIS level plus its recursive children (rollup). */
  tokenUsage?: { input: number; output: number };
  report?: BackgroundTaskReport;
  error?: string;
  modifiedFiles?: string[];
  delivered: boolean;
  log: BackgroundTaskLogEntry[];
}

/** Settings dedicated to the async-delegation mode. */
export interface DelegationSettings {
  configSetId: string;
  modelId?: string;
  timeoutMs: number;
  maxConcurrent: number;
  notifyOnCompletion: boolean;
  /** Re-launch delegations that were still running when the app last quit. */
  resumeOnRestart: boolean;
  /** Run each delegation in its own detached process (survives app quit). */
  detachedExecution: boolean;
  /** Let detached delegations run every tool without confirmation. */
  detachedAutoApprove: boolean;
}

/** Swarm execution stats (main screen transparency section). */
export interface SwarmStats {
  totalSwarms: number;
  /** Swarms where EVERY task completed (no failure, no skip). */
  succeededSwarms: number;
  /** Swarms that finished 'done' but with failed/skipped tasks (partial-ok). */
  partialSwarms?: number;
  totalTasks: number;
  fallbackTasks: number;
  lastRunMs?: number;
  lastRunAt?: number;
  lastRunTokens?: { input: number; output: number };
  /** Swarms run with the OPT-IN cross-verification flag. */
  crossVerificationSwarms?: number;
  /** Extra model calls cross-verification actually spent (measured cost). */
  crossVerificationCalls?: number;
  /** Swarms run with the OPT-IN team mode (ask_teammate available). */
  teammateSwarms?: number;
  /** Model calls teammate questions actually spent (measured cost). */
  teammateCalls?: number;
}

/** Delegated task stats (main screen transparency section). */
export interface DelegationStats {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  fallbacks: number;
}

type SessionStatus = 'idle' | 'running' | 'completed' | 'error';

export interface MountedPath {
  virtual: string;
  real: string;
}

// Message types
export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: ContentBlock[];
  timestamp: number;
  api?: string;
  provider?: string;
  model?: string;
  tokenUsage?: TokenUsage;
  localStatus?: 'queued' | 'cancelled';
  executionTimeMs?: number;
  /**
   * True when this assistant message is a Cowork-generated terminal error
   * report (upstream 400/429/5xx, timeout, empty result...) rather than real
   * model output. Drives the distinct error card in the renderer and the
   * exclusion from cold-start history replay.
   */
  isError?: boolean;
  /** Machine-readable terminal error kind, see classifyTerminalError(). */
  errorCode?: string;
}

type MessageRole = 'user' | 'assistant' | 'system';

export type ContentBlock =
  | TextContent
  | ImageContent
  | FileAttachmentContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent;

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
  /**
   * Workspace-relative path once this image is persisted under the session's
   * .tmp folder. The chat model itself is text-only, so the path is what lets
   * the agent call the analyze_image tool on an image the user pasted.
   */
  relativePath?: string;
}

export interface FileAttachmentContent {
  type: 'file_attachment';
  filename: string;
  relativePath: string; // Path relative to session's .tmp folder
  size: number;
  mimeType?: string;
  inlineDataBase64?: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  displayName?: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
  images?: Array<{
    data: string; // base64 encoded image data
    mimeType: string; // e.g., 'image/png'
  }>;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

interface TokenUsage {
  input: number;
  output: number;
}

// Trace types for visualization
export interface TraceStep {
  id: string;
  type: TraceStepType;
  status: TraceStepStatus;
  title: string;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  isError?: boolean;
  timestamp: number;
  duration?: number;
  /**
   * Identifies the agent run (one user turn) that emitted the step. A session
   * accumulates steps for every turn it has served, so without this a report
   * or a lookup cannot tell which run a step belongs to — two runs can be
   * interleaved in the same session, and steps from a finished run can share a
   * title with a live one. Absent on rows written before the column existed.
   */
  runId?: string;
}

type TraceStepType = 'thinking' | 'text' | 'tool_call' | 'tool_result';
type TraceStepStatus = 'pending' | 'running' | 'completed' | 'error';

export type ScheduleRepeatUnit = 'minute' | 'hour' | 'day';
export type ScheduleWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface DailyScheduleConfig {
  kind: 'daily';
  times: string[];
}

interface WeeklyScheduleConfig {
  kind: 'weekly';
  weekdays: ScheduleWeekday[];
  times: string[];
}

export type ScheduleConfig = DailyScheduleConfig | WeeklyScheduleConfig;

export interface ScheduleTask {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  projectId?: string | null;
  runAt: number;
  nextRunAt: number | null;
  scheduleConfig: ScheduleConfig | null;
  repeatEvery: number | null;
  repeatUnit: ScheduleRepeatUnit | null;
  enabled: boolean;
  lastRunAt: number | null;
  lastRunSessionId: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleCreateInput {
  title?: string;
  prompt: string;
  cwd: string;
  projectId?: string | null;
  runAt: number;
  nextRunAt?: number | null;
  scheduleConfig?: ScheduleConfig | null;
  repeatEvery?: number | null;
  repeatUnit?: ScheduleRepeatUnit | null;
  enabled?: boolean;
}

export interface ScheduleUpdateInput {
  title?: string;
  prompt?: string;
  cwd?: string;
  projectId?: string | null;
  runAt?: number;
  nextRunAt?: number | null;
  scheduleConfig?: ScheduleConfig | null;
  repeatEvery?: number | null;
  repeatUnit?: ScheduleRepeatUnit | null;
  enabled?: boolean;
  lastRunAt?: number | null;
  lastRunSessionId?: string | null;
  lastError?: string | null;
}

// Skills types
export interface Skill {
  id: string;
  name: string;
  description?: string;
  type: SkillType;
  enabled: boolean;
  config?: Record<string, unknown>;
  createdAt: number;
}

type SkillType = 'builtin' | 'mcp' | 'custom';

export type PluginComponentKind = 'skills' | 'commands' | 'agents' | 'hooks' | 'mcp';

export interface PluginComponentCounts {
  skills: number;
  commands: number;
  agents: number;
  hooks: number;
  mcp: number;
}

export interface PluginComponentEnabledState {
  skills: boolean;
  commands: boolean;
  agents: boolean;
  hooks: boolean;
  mcp: boolean;
}

export interface PluginCatalogItemV2 {
  name: string;
  description?: string;
  version?: string;
  authorName?: string;
  installable: boolean;
  hasManifest: boolean;
  componentCounts: PluginComponentCounts;
  pluginId?: string;
  installCommand?: string;
  detailUrl?: string;
  catalogSource?: 'claude-marketplace';
}

export interface PluginCatalogItem extends PluginCatalogItemV2 {
  skillCount: number;
  hasSkills: boolean;
}

export interface InstalledPlugin {
  pluginId: string;
  name: string;
  description?: string;
  version?: string;
  authorName?: string;
  enabled: boolean;
  sourcePath: string;
  runtimePath: string;
  componentCounts: PluginComponentCounts;
  componentsEnabled: PluginComponentEnabledState;
  installedAt: number;
  updatedAt: number;
}

export interface PluginInstallResultV2 {
  plugin: InstalledPlugin;
  installedSkills: string[];
  warnings: string[];
}

export interface PluginToggleResult {
  success: boolean;
  plugin: InstalledPlugin;
}

export interface PluginInstallResult {
  pluginName: string;
  installedSkills: string[];
  skippedSkills: string[];
  errors: string[];
}

export interface SkillsStorageChangeEvent {
  path: string;
  reason: 'updated' | 'path_changed' | 'fallback' | 'watcher_error';
  message?: string;
}

// Memory types
export interface MemoryEntry {
  id: string;
  sessionId: string;
  content: string;
  metadata: MemoryMetadata;
  createdAt: number;
}

interface MemoryMetadata {
  source: string;
  timestamp: number;
  tags: string[];
}

export type MemorySearchScope = 'workspace' | 'global' | 'all';
export type MemorySearchKind = 'core' | 'experience_session' | 'experience_chunk' | 'raw_session';

export interface MemoryTranscriptTurn {
  role: string;
  content: string;
  messageId?: string;
  timestamp?: number;
}

export interface ChunkMemoryItem {
  id: string;
  sessionId: string;
  sourceWorkspace?: string | null;
  sourceWorkspaceLabel?: string;
  sourceSessionId: string;
  sourceSessionTitle?: string;
  sourceSessionDate?: string;
  summary: string;
  details: string;
  keywords: string[];
  sourceTurns: number[];
  rawText: string;
  sessionDate: string;
  createdAt: string;
  ingestedAt: string;
  embedding: number[];
}

export interface SessionMemoryItem {
  id: string;
  sessionId: string;
  sourceWorkspace?: string | null;
  sourceWorkspaceLabel?: string;
  sourceSessionId: string;
  sourceSessionTitle?: string;
  sourceSessionDate?: string;
  summary: string;
  keywords: string[];
  chunkIds: string[];
  rawSession: MemoryTranscriptTurn[];
  sessionDate: string;
  createdAt: string;
  ingestedAt: string;
  embedding: number[];
}

export interface MemoryDebugFileInfo {
  kind: 'core' | 'experience' | 'state' | 'artifacts';
  label: string;
  filePath: string;
  exists: boolean;
  sizeBytes: number;
  updatedAt: number | null;
  sessionCount?: number;
  chunkCount?: number;
}

export interface MemoryDebugFileContent {
  kind: MemoryDebugFileInfo['kind'];
  filePath: string;
  text: string;
  parsed: unknown | null;
  sizeBytes: number;
  updatedAt: number | null;
}

export interface MemoryInspectSessionResult {
  sourceWorkspace?: string | null;
  filePath: string;
  session: SessionMemoryItem;
  chunks: ChunkMemoryItem[];
}

export interface MemoryOverview {
  enabled: boolean;
  storageRoot: string;
  coreFilePath: string;
  experienceFilePath: string;
  stateFilePath: string;
  coreCount: number;
  experienceSessionCount: number;
  experienceChunkCount: number;
  sourceWorkspaceCount: number;
  failedSessionCount: number;
  latestIngestionAt: number | null;
  latestError: string | null;
  currentWorkspace?: {
    workspaceKey: string;
    experienceSessionCount: number;
    experienceChunkCount: number;
  };
  topSourceWorkspaces: Array<{
    workspaceKey: string;
    sessionCount: number;
    chunkCount: number;
  }>;
}

export interface MemorySearchResult {
  id: string;
  recordId: string;
  kind: MemorySearchKind;
  title: string;
  summary: string;
  contentPreview: string;
  workspaceKey?: string;
  sourceWorkspace?: string | null;
  sourceWorkspaceLabel?: string;
  sourceSessionId?: string;
  sourceSessionTitle?: string;
  sessionId?: string;
  sessionTitle?: string;
  category?: 'identity' | 'preferences' | 'skills' | 'interests';
  score: number;
  createdAt: number;
  updatedAt?: number;
  keywords?: string[];
  sourceFile?: string;
}

export interface MemoryReadResult extends MemorySearchResult {
  rawText?: string;
  details?: string;
  rawSession?: MemoryTranscriptTurn[];
  sourceTurns?: number[];
  chunkIds?: string[];
  sourceExcerpt?: string;
}

// Permission types
export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
}

export type PermissionResult = 'allow' | 'deny' | 'allow_always';

// Sudo password types
export interface SudoPasswordRequest {
  toolUseId: string;
  command: string;
  sessionId: string;
}

// AskUserQuestion display types - kept for rendering historical messages
interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

export interface PermissionRule {
  tool: string;
  pattern?: string;
  action: 'allow' | 'deny' | 'ask';
}

// IPC Event types
export type ClientEvent =
  | {
      type: 'session.start';
      payload: {
        title: string;
        prompt: string;
        cwd?: string;
        allowedTools?: string[];
        content?: ContentBlock[];
        memoryEnabled?: boolean;
        /** Start the session inside this project (uses its workdir/context). */
        projectId?: string;
      };
    }
  | {
      type: 'session.continue';
      payload: { sessionId: string; prompt: string; content?: ContentBlock[] };
    }
  | { type: 'session.stop'; payload: { sessionId: string } }
  | { type: 'session.delete'; payload: { sessionId: string } }
  | { type: 'session.batchDelete'; payload: { sessionIds: string[] } }
  | { type: 'session.rename'; payload: { sessionId: string; title: string } }
  | { type: 'session.togglePin'; payload: { sessionId: string; isPinned: boolean } }
  | { type: 'session.activate'; payload: { sessionId: string | null; cwd?: string } }
  | { type: 'session.list'; payload: Record<string, never> }
  | { type: 'session.getMessages'; payload: { sessionId: string } }
  | { type: 'session.getTraceSteps'; payload: { sessionId: string } }
  | {
      type: 'session.compact';
      payload: { sessionId: string; customInstructions?: string };
    }
  | { type: 'session.getContextUsage'; payload: { sessionId: string } }
  | {
      type: 'session.setConfigOverride';
      payload: { sessionId: string; configSetId: string | null; modelId: string | null };
    }
  | { type: 'permission.response'; payload: { toolUseId: string; result: PermissionResult } }
  | { type: 'sudo.password.response'; payload: { toolUseId: string; password: string | null } }
  | { type: 'settings.update'; payload: Record<string, unknown> }
  | {
      type: 'config.createSet';
      payload: { name: string; mode?: 'blank' | 'clone'; fromSetId?: string };
    }
  | { type: 'folder.select'; payload: Record<string, never> }
  | { type: 'workdir.get'; payload: Record<string, never> }
  | { type: 'workdir.set'; payload: { path: string; sessionId?: string } }
  | { type: 'workdir.select'; payload: { sessionId?: string; currentPath?: string } }
  | {
      type: 'projects.create';
      payload: {
        name: string;
        workdir: string;
        description?: string;
        configSetId?: string;
        modelId?: string;
        pipelineMode?: PipelineMode;
        draftConfigSetId?: string;
        draftModelId?: string;
        refineConfigSetId?: string;
        refineModelId?: string;
        instructions?: string;
      };
    }
  | { type: 'projects.list'; payload: { includeArchived?: boolean } }
  | { type: 'projects.get'; payload: { projectId: string } }
  | {
      type: 'projects.update';
      payload: {
        projectId: string;
        name?: string;
        description?: string | null;
        workdir?: string;
        configSetId?: string | null;
        modelId?: string | null;
        pipelineMode?: PipelineMode;
        draftConfigSetId?: string | null;
        draftModelId?: string | null;
        refineConfigSetId?: string | null;
        refineModelId?: string | null;
        instructions?: string | null;
      };
    }
  | { type: 'projects.archive'; payload: { projectId: string; archived: boolean } }
  | {
      /** Permanent delete — archived projects only; linked sessions are orphaned, never deleted. */
      type: 'projects.delete';
      payload: { projectId: string };
    }
  | {
      type: 'projects.attachFile';
      payload: { projectId: string; path: string };
    }
  | { type: 'projects.detachFile'; payload: { projectId: string; path: string } }
  | { type: 'projects.linkSession'; payload: { projectId: string; sessionId: string } }
  | { type: 'projects.unlinkSession'; payload: { sessionId: string } }
  | { type: 'backgroundTasks.list'; payload: { sessionId?: string } }
  | { type: 'backgroundTasks.get'; payload: { taskId: string } }
  | { type: 'backgroundTasks.cancel'; payload: { taskId: string } }
  | { type: 'backgroundTasks.retry'; payload: { taskId: string } }
  | { type: 'backgroundTasks.delete'; payload: { taskId: string } }
  | { type: 'backgroundTasks.getSettings'; payload: Record<string, never> }
  | { type: 'backgroundTasks.getStats'; payload: Record<string, never> }
  | { type: 'document.read'; payload: { cwd: string; path: string } }
  | {
      type: 'document.write';
      payload: {
        cwd: string;
        path: string;
        content: string;
        baseMtimeMs?: number;
        force?: boolean;
      };
    }
  | { type: 'document.list'; payload: { cwd: string } }
  | {
      type: 'backgroundTasks.setSettings';
      payload: {
        configSetId?: string;
        modelId?: string | null;
        timeoutMs?: number;
        maxConcurrent?: number;
        notifyOnCompletion?: boolean;
        resumeOnRestart?: boolean;
        detachedExecution?: boolean;
        detachedAutoApprove?: boolean;
      };
    };

// Sandbox setup types (app startup)
export type SandboxSetupPhase =
  | 'checking' // Checking WSL/Lima availability
  | 'creating' // Creating Lima instance (macOS only)
  | 'starting' // Starting Lima instance (macOS only)
  | 'installing_node' // Installing Node.js
  | 'installing_python' // Installing Python
  | 'installing_pip' // Installing pip
  | 'installing_deps' // Installing skill dependencies (markitdown, pypdf, etc.)
  | 'ready' // Ready to use
  | 'skipped' // No sandbox needed (native mode)
  | 'error'; // Setup failed

export interface SandboxSetupProgress {
  phase: SandboxSetupPhase;
  message: string;
  detail?: string;
  progress?: number; // 0-100
  error?: string;
}

// Sandbox sync types (per-session file sync)
export type SandboxSyncPhase =
  | 'starting_agent' // Starting WSL/Lima agent
  | 'syncing_files' // Syncing files to sandbox
  | 'syncing_skills' // Copying skills
  | 'ready' // Sync complete
  | 'error'; // Sync failed

export interface SandboxSyncStatus {
  sessionId: string;
  phase: SandboxSyncPhase;
  message: string;
  detail?: string;
  fileCount?: number;
  totalSize?: number;
}

export type ServerEvent =
  | { type: 'stream.message'; payload: { sessionId: string; message: Message } }
  | { type: 'stream.partial'; payload: { sessionId: string; delta: string } }
  | { type: 'stream.thinking'; payload: { sessionId: string; delta: string } }
  | {
      type: 'stream.executionTime';
      payload: { sessionId: string; messageId: string; executionTimeMs: number };
    }
  | {
      type: 'session.status';
      payload: { sessionId: string; status: SessionStatus; error?: string };
    }
  | { type: 'session.update'; payload: { sessionId: string; updates: Partial<Session> } }
  | {
      type: 'session.list';
      payload: { sessions: Session[]; lastActiveSessionId?: string; lastActiveCwd?: string };
    }
  | { type: 'permission.request'; payload: PermissionRequest }
  | { type: 'permission.dismiss'; payload: { toolUseId: string } }
  | { type: 'sudo.password.request'; payload: SudoPasswordRequest }
  | { type: 'sudo.password.dismiss'; payload: { toolUseId: string } }
  | { type: 'trace.step'; payload: { sessionId: string; step: TraceStep } }
  | {
      type: 'trace.update';
      payload: { sessionId: string; stepId: string; updates: Partial<TraceStep> };
    }
  | { type: 'folder.selected'; payload: { path: string } }
  | { type: 'config.status'; payload: { isConfigured: boolean; config: AppConfig } }
  | { type: 'sandbox.progress'; payload: SandboxSetupProgress }
  | { type: 'sandbox.sync'; payload: SandboxSyncStatus }
  | { type: 'skills.storageChanged'; payload: SkillsStorageChangeEvent }
  | { type: 'skills.proposalsChanged'; payload: { count: number } }
  | {
      type: 'plugins.runtimeApplied';
      payload: { sessionId: string; plugins: Array<{ name: string; path: string }> };
    }
  | { type: 'workdir.changed'; payload: { path: string } }
  | { type: 'session.contextInfo'; payload: { sessionId: string; contextWindow: number } }
  | {
      type: 'workflow.state';
      payload: { sessionId: string; state: WorkflowState };
    }
  | {
      type: 'workflow.taskResult';
      payload: { sessionId: string; result: TaskRunResult };
    }
  | {
      type: 'workflow.taskProgress';
      payload: { sessionId: string; progress: TaskRunProgress };
    }
  | {
      type: 'background.task';
      payload: {
        sessionId: string;
        taskId: string;
        title: string;
        status: 'running' | 'completed' | 'failed' | 'cancelled';
        summary?: string;
        error?: string;
        /** 'progress' = live tool step; 'status' = lifecycle transition. */
        eventKind?: 'progress' | 'status';
      };
    }
  | {
      type: 'compaction.result';
      payload: {
        sessionId: string;
        summary: string;
        tokensBefore: number;
        isManual?: boolean;
        readFiles: string[];
        modifiedFiles: string[];
      };
    }
  | {
      type: 'subagent.progress';
      payload: {
        parentSessionId: string;
        subagentId: string;
        event: 'started' | 'tool_start' | 'tool_end' | 'text_delta' | 'completed' | 'failed';
        task?: string;
        toolName?: string;
        isError?: boolean;
        text?: string;
        error?: string;
        durationMs?: number;
      };
    }
  | {
      type: 'navigate.to';
      payload: { page: 'welcome' | 'settings' | 'session'; tab?: string; sessionId?: string };
    }
  | { type: 'native-theme.changed'; payload: { shouldUseDarkColors: boolean } }
  | { type: 'new-session' }
  | { type: 'navigate'; payload: string }
  | { type: 'scheduled-task.error'; payload: { taskId: string; error: string } }
  | {
      type: 'error';
      payload: {
        message: string;
        code?: 'CONFIG_REQUIRED_ACTIVE_SET';
        action?: 'open_api_settings';
      };
    };

// Settings types
export interface Settings {
  theme: AppTheme;
  apiKey?: string;
  defaultTools: string[];
  permissionRules: PermissionRule[];
  autoApproveAll?: boolean;
  systemNotifications?: boolean;
  globalSkillsPath: string;
  memoryStrategy: 'auto' | 'manual' | 'rolling';
  maxContextTokens: number;
}

// Tool types
export type ToolName =
  | 'read'
  | 'write'
  | 'edit'
  | 'glob'
  | 'grep'
  | 'bash'
  | 'webFetch'
  | 'webSearch';

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
}

// Execution context
export interface ExecutionContext {
  sessionId: string;
  cwd: string;
  mountedPaths: MountedPath[];
  allowedTools: string[];
}

// App Config types
export type ProviderType = 'openrouter' | 'anthropic' | 'custom' | 'openai' | 'gemini' | 'ollama';
export type CustomProtocolType = 'anthropic' | 'openai' | 'gemini';
export type AppTheme = 'dark' | 'light' | 'system';
export type ProviderProfileKey =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'custom:anthropic'
  | 'custom:openai'
  | 'custom:gemini';
export type ConfigSetId = string;

export interface ProviderProfile {
  apiKey: string;
  baseUrl?: string;
  model: string;
  customModels?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface ApiConfigSet {
  id: ConfigSetId;
  name: string;
  isSystem?: boolean;
  provider: ProviderType;
  customProtocol: CustomProtocolType;
  activeProfileKey: ProviderProfileKey;
  profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>;
  enableThinking: boolean;
  updatedAt: string;
}

export interface CreateSetPayload {
  name: string;
  mode: 'blank' | 'clone';
  fromSetId?: string;
}

export interface MemoryModelRuntimeConfig {
  inheritFromActive: boolean;
  provider?: ProviderType;
  customProtocol?: CustomProtocolType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
}

export interface MemoryRuntimeConfig {
  llm: MemoryModelRuntimeConfig;
  embedding: MemoryModelRuntimeConfig;
  useEmbedding: boolean;
  maxNavSteps: number;
  ingestionConcurrency: number;
  storageRoot?: string;
  evalEnabled?: boolean;
  evalWorkspaces?: string[];
  evalMaxRounds?: number;
  evalArtifactsRoot?: string;
  promptIterationRounds?: number;
}

/**
 * Dedicated provider/model selection for image READ (vision) and GENERATION.
 * Kept separate from the text ConfigSets on purpose: image models are priced
 * per image and are often a different vendor than the chat model. Reuses the
 * existing ConfigSet + model picker, so a user duplicates nothing.
 */
export interface ImageGenerationConfig {
  /** ConfigSet used for image work. Empty = inherit the active ConfigSet. */
  configSetId: string;
  /** Exact model pinned inside that set (undefined = the set's active model). */
  modelId?: string;
  /**
   * Estimated cost per image (USD) at or above which generate_image refuses
   * once and asks for an explicit acknowledgement. Undefined = built-in default.
   */
  costConfirmThresholdUsd?: number;
  /**
   * Explicit provider for image work. When set together with `model`, image
   * read/generation runs on THIS provider with its own credentials, independent
   * of any text ConfigSet — so any provider (first-party or an OpenAI/Gemini/
   * Anthropic-compatible endpoint) can serve image models. Takes precedence
   * over `configSetId`.
   */
  provider?: ProviderType;
  /** Wire protocol when `provider` is 'custom' (or to force one explicitly). */
  customProtocol?: CustomProtocolType;
  /** API key for the explicit provider (empty = reuse the active key when the provider matches). */
  apiKey?: string;
  /** Base URL for the explicit provider (required for 'custom' and 'ollama'). */
  baseUrl?: string;
  /** Model id on the explicit provider (e.g. gpt-image-1.5, gemini-3-pro-image-preview). */
  model?: string;
}

export interface AppConfig {
  provider: ProviderType;
  apiKey: string;
  baseUrl?: string;
  customProtocol?: CustomProtocolType;
  model: string;
  contextWindow?: number;
  maxTokens?: number;
  activeProfileKey: ProviderProfileKey;
  profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>;
  activeConfigSetId: ConfigSetId;
  configSets: ApiConfigSet[];
  agentCliPath?: string;
  defaultWorkdir?: string;
  globalSkillsPath?: string;
  theme?: AppTheme;
  sandboxEnabled?: boolean;
  memoryEnabled?: boolean;
  /** Personalization: free-form instructions injected into agent system prompts. */
  coworkInstructions?: string;
  /** Optional native web_search provider keys (empty = DuckDuckGo fallback). */
  tavilyApiKey?: string;
  braveApiKey?: string;
  /** Menu-bar tray icon + Alt+Space global toggle (background quick access). */
  trayEnabled?: boolean;
  memoryRuntime?: MemoryRuntimeConfig;
  /** Image read/generation profile (dedicated ConfigSet, opt-in). */
  imageGeneration?: ImageGenerationConfig;
  enableThinking?: boolean;
  isConfigured: boolean;
  /** OpenJev "System One" routing hint (optional, off by default). */
  openjev?: { enabled: boolean; baseUrl: string };
}

interface ProviderPreset {
  name: string;
  baseUrl: string;
  models: { id: string; name: string }[];
  keyPlaceholder: string;
  keyHint: string;
}

export interface ProviderPresets {
  openrouter: ProviderPreset;
  anthropic: ProviderPreset;
  custom: ProviderPreset;
  openai: ProviderPreset;
  gemini: ProviderPreset;
  ollama: ProviderPreset;
}

export interface ProviderModelInfo {
  id: string;
  name: string;
}

export interface ApiTestInput {
  provider: AppConfig['provider'];
  apiKey: string;
  baseUrl?: string;
  customProtocol?: AppConfig['customProtocol'];
  model?: string;
  useLiveRequest?: boolean;
  verificationLevel?: DiagnosticVerificationLevel;
}

export interface ApiTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  errorType?:
    | 'missing_key'
    | 'missing_base_url'
    | 'unauthorized'
    | 'not_found'
    | 'rate_limited'
    | 'server_error'
    | 'network_error'
    | 'ollama_not_running'
    | 'ollama_loading'
    | 'unknown';
  details?: string;
}

// API Diagnostics types
export type DiagnosticStepName = 'dns' | 'tcp' | 'tls' | 'auth' | 'model';
export type DiagnosticStepStatus = 'pending' | 'running' | 'ok' | 'fail' | 'skip';
export type DiagnosticVerificationLevel = 'fast' | 'deep';
type DiagnosticAdvisoryCode = 'not_deep_verified' | 'model_loading' | 'manual_model';

export interface DiagnosticStep {
  name: DiagnosticStepName;
  status: DiagnosticStepStatus;
  latencyMs?: number;
  error?: string;
  fix?: string;
}

export interface DiagnosticResult {
  steps: DiagnosticStep[];
  overallOk: boolean;
  /** Which step failed first (null if all ok) */
  failedAt?: DiagnosticStepName;
  totalLatencyMs: number;
  verificationLevel?: DiagnosticVerificationLevel;
  advisoryCode?: DiagnosticAdvisoryCode;
  advisoryText?: string;
  /** Present when the run was skipped (e.g. 'concurrent_run') */
  skippedReason?: string;
}

export interface DiagnosticInput {
  provider: AppConfig['provider'];
  apiKey: string;
  baseUrl?: string;
  customProtocol?: AppConfig['customProtocol'];
  model?: string;
  verificationLevel?: DiagnosticVerificationLevel;
}

export interface LocalServiceInfo {
  type: 'ollama';
  baseUrl: string;
  models?: string[];
}

type LocalOllamaDiscoveryStatus = 'unavailable' | 'service_available' | 'models_available';

export interface LocalOllamaDiscoveryResult {
  available: boolean;
  baseUrl: string;
  models?: string[];
  status: LocalOllamaDiscoveryStatus;
}

// MCP types
export interface MCPServerInfo {
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  tools?: MCPToolInfo[];
}

export interface MCPToolInfo {
  name: string;
  description: string;
  serverId: string;
  serverName: string;
}
