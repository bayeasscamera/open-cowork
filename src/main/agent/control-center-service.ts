/**
 * @module main/agent/control-center-service
 *
 * Cowork 4.0 — Phase 6: composes the activity feed, the detached-task queue, the
 * notification center and the workspace probes behind one testable surface. The
 * IPC layer stays thin.
 */

import type {
  ControlCenterSnapshot,
  GitStatusSummary,
  RerunFailedTestsOutcome,
  TerminalSessionInfo,
  TerminalSnapshot,
  TestCommandId,
  TestRunResult,
  WorkspaceEntry,
  WorkspaceFileContent,
  WorkspaceTreeOptions,
} from '../../shared/control-center-types';
import { ActivityTracker } from './activity-tracker';
import { NotificationCenter } from './notification-center';
import { TaskQueue } from './task-queue';
import { createGitRunner } from './checkpoint-backends';
import type { GitRunner } from './checkpoint-manager';
import { readGitStatus } from '../workspace/git-status';
import { listWorkspaceTree, readWorkspaceFile } from '../workspace/workspace-explorer';
import {
  createExecFileRunner,
  resolveTestCommand,
  runTestCommand,
  type CommandRunner,
} from '../workspace/test-runner';
import { parseFailedTestFiles } from '../../shared/test-failures';
import { resolveWorkspaceFile } from '../utils/workspace-path';
import { TerminalManager, type TerminalManagerOptions } from '../workspace/terminal-manager';
import {
  createShellEditorOpener,
  openFileInEditor,
  type EditorOpener,
  type OpenInEditorResult,
} from '../utils/open-in-editor';

export interface ControlCenterServiceOptions {
  /** Resolve the workspace root for a session; null when unknown. */
  resolveWorkspaceRoot: (sessionId: string) => string | null;
  now?: () => number;
  idFactory?: () => string;
  gitFactory?: (workspaceRoot: string) => GitRunner;
  runner?: CommandRunner;
  /** Embedded terminal options (shell, spawn, limits). */
  terminal?: Pick<TerminalManagerOptions, 'shell' | 'spawn' | 'maxTerminals' | 'maxChunks' | 'isDirectory'>;
  /** Opens a workspace file in the user's editor; injected in tests. */
  editorOpener?: EditorOpener;
  activityLimit?: number;
  queueLimit?: number;
  notificationLimit?: number;
  /** Called after every queue mutation, so the queue can be persisted. */
  queueOnChange?: () => void;
}

export class ControlCenterService {
  public readonly activity: ActivityTracker;
  public readonly queue: TaskQueue;
  public readonly notifications: NotificationCenter;
  public readonly terminals: TerminalManager;

  private readonly options: ControlCenterServiceOptions;
  private readonly gitFactory: (workspaceRoot: string) => GitRunner;
  private readonly runner: CommandRunner;
  private readonly editorOpener: EditorOpener;
  private readonly lastTests = new Map<string, TestRunResult>();

  constructor(options: ControlCenterServiceOptions) {
    this.options = options;
    this.gitFactory = options.gitFactory ?? createGitRunner;
    this.runner = options.runner ?? createExecFileRunner();
    this.editorOpener = options.editorOpener ?? createShellEditorOpener();
    this.activity = new ActivityTracker({
      now: options.now,
      idFactory: options.idFactory,
      limit: options.activityLimit,
    });
    this.queue = new TaskQueue({
      now: options.now,
      idFactory: options.idFactory,
      limit: options.queueLimit,
      onChange: options.queueOnChange,
    });
    this.notifications = new NotificationCenter({
      now: options.now,
      idFactory: options.idFactory,
      limit: options.notificationLimit,
    });
    this.terminals = new TerminalManager({
      now: options.now,
      idFactory: options.idFactory,
      ...(options.terminal ?? {}),
    });
  }

  /**
   * Open an embedded terminal rooted at the session workspace. The renderer
   * never picks the working directory, so a terminal cannot escape the
   * workspace the session is bound to.
   */
  public openTerminal(sessionId: string, shell?: string): TerminalSnapshot {
    const root = this.workspaceRoot(sessionId);
    if (!root) {
      throw new Error('No workspace is available for session "' + sessionId + '".');
    }
    return this.terminals.open({ sessionId, cwd: root, ...(shell ? { shell } : {}) });
  }

  public terminalSnapshot(
    sessionId: string,
    terminalId: string,
    sinceSeq?: number
  ): TerminalSnapshot {
    return this.terminals.snapshot(sessionId, terminalId, sinceSeq);
  }

  public writeTerminal(sessionId: string, terminalId: string, data: string): void {
    this.terminals.write(sessionId, terminalId, data);
  }

  public closeTerminal(sessionId: string, terminalId: string): boolean {
    return this.terminals.close(sessionId, terminalId);
  }

  public clearTerminal(sessionId: string, terminalId: string): number {
    return this.terminals.clear(sessionId, terminalId);
  }

  public terminalsFor(sessionId: string): TerminalSessionInfo[] {
    return this.terminals.list(sessionId);
  }

  /** Kill every embedded terminal; called from the app shutdown path. */
  public closeAllTerminals(): number {
    return this.terminals.closeAll();
  }

  public workspaceRoot(sessionId: string): string | null {
    return this.options.resolveWorkspaceRoot(sessionId);
  }

  public async gitStatus(sessionId: string): Promise<GitStatusSummary | null> {
    const root = this.workspaceRoot(sessionId);
    if (!root) {
      return null;
    }
    return readGitStatus(this.gitFactory(root));
  }

  public async workspaceTree(
    sessionId: string,
    options: WorkspaceTreeOptions = {}
  ): Promise<WorkspaceEntry[]> {
    const root = this.workspaceRoot(sessionId);
    if (!root) {
      return [];
    }
    return listWorkspaceTree(root, options);
  }

  public async readFile(
    sessionId: string,
    relativePath: string,
    maxBytes?: number
  ): Promise<WorkspaceFileContent> {
    const root = this.workspaceRoot(sessionId);
    if (!root) {
      throw new Error('No workspace is available for session "' + sessionId + '".');
    }
    return readWorkspaceFile(root, relativePath, maxBytes);
  }

  public async runTests(sessionId: string, commandId: TestCommandId): Promise<TestRunResult> {
    const root = this.workspaceRoot(sessionId);
    if (!root) {
      throw new Error('No workspace is available for session "' + sessionId + '".');
    }
    const result = await runTestCommand({
      id: commandId,
      cwd: root,
      runner: this.runner,
      now: this.options.now,
      idFactory: this.options.idFactory,
    });
    this.lastTests.set(sessionId, result);
    return result;
  }

  public lastTestResult(sessionId: string): TestRunResult | null {
    return this.lastTests.get(sessionId) ?? null;
  }

  /**
   * Re-run only the test files that failed in the last run. The files come from
   * our own captured output, are validated to be real files inside the
   * workspace, and are only accepted by commands that support a narrowed run.
   */
  public async rerunFailedTests(sessionId: string): Promise<RerunFailedTestsOutcome> {
    const root = this.workspaceRoot(sessionId);
    if (!root) {
      return { ran: false, reason: 'no_workspace' };
    }
    const previous = this.lastTests.get(sessionId);
    if (!previous || previous.ok) {
      return { ran: false, reason: 'no_previous_run' };
    }
    const spec = resolveTestCommand(previous.commandId);
    if (!spec || spec.filterMode !== 'append') {
      return { ran: false, reason: 'unsupported_command' };
    }
    const files = parseFailedTestFiles(previous.stdout + '\n' + previous.stderr).filter(
      (file) => resolveWorkspaceFile(root, file) !== null
    );
    if (files.length === 0) {
      return { ran: false, reason: 'no_failed_files' };
    }
    const result = await runTestCommand({
      id: spec.id,
      cwd: root,
      runner: this.runner,
      filter: files,
      now: this.options.now,
      idFactory: this.options.idFactory,
    });
    this.lastTests.set(sessionId, result);
    return { ran: true, files, result };
  }

  /**
   * Open a file the session touched in the user's editor, optionally at a
   * line. The workspace root comes from the session, so the renderer cannot
   * point the editor at an arbitrary path.
   */
  public async openInEditor(
    sessionId: string,
    filePath: string,
    line?: number
  ): Promise<OpenInEditorResult> {
    const root = this.workspaceRoot(sessionId);
    if (!root) {
      return { success: false, error: 'no_workspace' };
    }
    return openFileInEditor({ root, path: filePath, line: line ?? null }, this.editorOpener);
  }

  public async snapshot(sessionId: string): Promise<ControlCenterSnapshot> {
    const workspaceRoot = this.workspaceRoot(sessionId);
    const now = this.options.now ?? (() => Date.now());
    const git = workspaceRoot ? await readGitStatus(this.gitFactory(workspaceRoot)) : null;
    return {
      sessionId,
      workspaceRoot,
      activity: this.activity.forSession(sessionId, 50),
      queue: this.queue.list(sessionId),
      notifications: this.notifications.list(sessionId),
      git,
      tests: this.lastTestResult(sessionId),
      generatedAt: now(),
    };
  }
}
