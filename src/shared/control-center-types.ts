/**
 * @module shared/control-center-types
 *
 * Cowork 4.0 — Phase 6: the "agent control center". These types cross the
 * preload bridge, so they must never import from `src/main`.
 */

export type ActivityStatus = 'running' | 'ok' | 'error' | 'cancelled';

export interface ActivityEvent {
  id: string;
  sessionId: string;
  /** Task the activity belongs to, when the workflow knows it. */
  taskId?: string;
  /** Tool or subsystem name, e.g. "read", "bash", "git". */
  tool: string;
  /** Short human-readable summary of what the tool did. */
  label: string;
  status: ActivityStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** Optional one-line detail (command, path, query…). */
  detail?: string;
  error?: string;
}

export interface ActivityEventInput {
  sessionId: string;
  tool: string;
  label: string;
  taskId?: string;
  detail?: string;
}

export interface WorkspaceEntry {
  name: string;
  /** Path relative to the workspace root, forward-slashed. */
  path: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
  modifiedAt?: number;
  children?: WorkspaceEntry[];
}

export interface WorkspaceTreeOptions {
  /** Levels below the root to walk; defaults to 3. */
  maxDepth?: number;
  /** Hard cap on visited entries; defaults to 400. */
  maxEntries?: number;
}

export interface WorkspaceFileContent {
  /** Path relative to the workspace root. */
  path: string;
  content: string;
  sizeBytes: number;
  truncated: boolean;
}

export interface GitFileChange {
  path: string;
  /** Index (staged) status letter, " " when unchanged. */
  indexStatus: string;
  /** Work-tree status letter, " " when unchanged. */
  workTreeStatus: string;
  staged: boolean;
}

export interface GitStatusSummary {
  available: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
  changes: GitFileChange[];
  error?: string;
}

export type TestCommandId =
  | 'npm-test'
  | 'npm-typecheck'
  | 'npm-lint'
  | 'vitest'
  | 'pytest'
  | 'go-test'
  | 'cargo-test';

export interface TestRunResult {
  id: string;
  command: string;
  cwd: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  ranAt: number;
}

export type TerminalStream = 'stdout' | 'stderr';

/** One piece of terminal output, numbered so the renderer can poll by cursor. */
export interface TerminalChunk {
  seq: number;
  stream: TerminalStream;
  text: string;
  at: number;
}

export interface TerminalSessionInfo {
  id: string;
  sessionId: string;
  cwd: string;
  shell: string;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
}

export interface TerminalSnapshot {
  session: TerminalSessionInfo;
  /** Chunks newer than the requested cursor, oldest first. */
  output: TerminalChunk[];
  /** True once the buffer started dropping the oldest output. */
  truncated: boolean;
  droppedChunks: number;
}

export type DetachedTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface DetachedTask {
  id: string;
  sessionId: string;
  /** Free-form kind, e.g. "subagent", "test-run", "custom". */
  kind: string;
  label: string;
  status: DetachedTaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Completion ratio in [0, 1]. */
  progress?: number;
  error?: string;
  /** Opaque payload persisted so a restarted app can resume the task. */
  resumeToken?: string;
}

export interface DetachedTaskInput {
  sessionId: string;
  kind: string;
  label: string;
  resumeToken?: string;
}

export type NotificationKind = 'approval' | 'blocker' | 'completion' | 'error';

export interface ApprovalNotification {
  id: string;
  sessionId: string;
  kind: NotificationKind;
  title: string;
  detail?: string;
  createdAt: number;
  acknowledged: boolean;
  taskId?: string;
}

export interface NotificationInput {
  sessionId: string;
  kind: NotificationKind;
  title: string;
  detail?: string;
  taskId?: string;
}

export interface ControlCenterSnapshot {
  sessionId: string;
  workspaceRoot: string | null;
  activity: ActivityEvent[];
  queue: DetachedTask[];
  notifications: ApprovalNotification[];
  git: GitStatusSummary | null;
  tests: TestRunResult | null;
  generatedAt: number;
}

export const DETACHED_TASK_STATUSES: readonly DetachedTaskStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'approval',
  'blocker',
  'completion',
  'error',
] as const;

export const ACTIVITY_STATUSES: readonly ActivityStatus[] = [
  'running',
  'ok',
  'error',
  'cancelled',
] as const;
