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
import { createExecFileRunner, runTestCommand, type CommandRunner } from '../workspace/test-runner';

export interface ControlCenterServiceOptions {
  /** Resolve the workspace root for a session; null when unknown. */
  resolveWorkspaceRoot: (sessionId: string) => string | null;
  now?: () => number;
  idFactory?: () => string;
  gitFactory?: (workspaceRoot: string) => GitRunner;
  runner?: CommandRunner;
  activityLimit?: number;
  queueLimit?: number;
  notificationLimit?: number;
}

export class ControlCenterService {
  public readonly activity: ActivityTracker;
  public readonly queue: TaskQueue;
  public readonly notifications: NotificationCenter;

  private readonly options: ControlCenterServiceOptions;
  private readonly gitFactory: (workspaceRoot: string) => GitRunner;
  private readonly runner: CommandRunner;
  private readonly lastTests = new Map<string, TestRunResult>();

  constructor(options: ControlCenterServiceOptions) {
    this.options = options;
    this.gitFactory = options.gitFactory ?? createGitRunner;
    this.runner = options.runner ?? createExecFileRunner();
    this.activity = new ActivityTracker({
      now: options.now,
      idFactory: options.idFactory,
      limit: options.activityLimit,
    });
    this.queue = new TaskQueue({
      now: options.now,
      idFactory: options.idFactory,
      limit: options.queueLimit,
    });
    this.notifications = new NotificationCenter({
      now: options.now,
      idFactory: options.idFactory,
      limit: options.notificationLimit,
    });
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
