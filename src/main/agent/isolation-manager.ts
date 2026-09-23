/**
 * @module main/agent/isolation-manager
 *
 * Cowork 4.0 — Phase 5.3: materialises isolation plans as real git worktrees.
 * Every command is injected through `GitRunner` so failures are observable and
 * the module is testable without a repository.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { IsolationPlan } from '../../shared/workflow-types';
import type { GitRunner } from './checkpoint-manager';
import type { AuditLog } from './audit-log';

export interface CreatedWorktree {
  plan: IsolationPlan;
  branch: string;
  created: boolean;
  error?: string;
}

export interface IsolationManagerOptions {
  git: GitRunner;
  audit?: AuditLog;
}

/** Branch name used for a task worktree. */
export function branchFor(taskId: string): string {
  return 'cowork/' + taskId.replace(/[^a-zA-Z0-9._-]/g, '-');
}

export class IsolationManager {
  private readonly git: GitRunner;
  private readonly audit: AuditLog | undefined;
  private readonly active = new Map<string, CreatedWorktree>();

  constructor(options: IsolationManagerOptions) {
    this.git = options.git;
    this.audit = options.audit;
  }

  /**
   * Create a detached-at-branch worktree for the plan. Never throws: a failure
   * is recorded on the result so the caller can fall back to the live workspace
   * or refuse to run the task.
   */
  public async create(plan: IsolationPlan): Promise<CreatedWorktree> {
    await fs
      .mkdir(path.dirname(plan.worktreePath), { recursive: true })
      .catch(() => {
        /* git creates the intermediate directory itself */
      });

    const branch = branchFor(plan.taskId);
    const result = await this.git.run([
      'worktree',
      'add',
      '-b',
      branch,
      plan.worktreePath,
      'HEAD',
    ]);

    if (result.exitCode !== 0) {
      const created: CreatedWorktree = {
        plan,
        branch,
        created: false,
        error: result.stderr.trim() || result.stdout.trim() || 'git worktree add failed',
      };
      this.audit?.append({
        action: 'isolation.create',
        justification: 'Worktree creation failed for task "' + plan.taskId + '".',
        authorization: 'forbidden',
        capability: 'git',
        files: [plan.worktreePath],
        taskId: plan.taskId,
      });
      return created;
    }

    const record: CreatedWorktree = { plan, branch, created: true };
    this.active.set(plan.taskId, record);
    this.audit?.append({
      action: 'isolation.create',
      justification: 'Ephemeral worktree created for task "' + plan.taskId + '".',
      authorization: 'approved',
      capability: 'git',
      files: [plan.worktreePath],
      taskId: plan.taskId,
    });
    return record;
  }

  /** Capture the diff produced inside a worktree (used as task evidence). */
  public async diff(taskId: string): Promise<string> {
    const record = this.active.get(taskId);
    if (!record) {
      return '';
    }
    const result = await this.git.run(['diff', '--stat', 'HEAD']);
    return result.exitCode === 0 ? result.stdout : '';
  }

  /** Remove a worktree and its branch. Best effort; never throws. */
  public async cleanup(taskId: string): Promise<{ removed: boolean; reason?: string }> {
    const record = this.active.get(taskId);
    if (!record) {
      return { removed: false, reason: 'no active worktree for task ' + taskId };
    }

    const remove = await this.git.run(['worktree', 'remove', '--force', record.plan.worktreePath]);
    await this.git.run(['branch', '-D', record.branch]).catch(() => null);
    await fs.rm(record.plan.worktreePath, { recursive: true, force: true }).catch(() => {
      /* already gone */
    });

    this.active.delete(taskId);
    const removed = remove.exitCode === 0;
    this.audit?.append({
      action: 'isolation.cleanup',
      justification: removed
        ? 'Ephemeral worktree removed for task "' + taskId + '".'
        : 'Worktree removal reported a failure; path deleted anyway.',
      authorization: 'auto',
      capability: 'git',
      files: [record.plan.worktreePath],
      taskId,
    });
    return removed ? { removed } : { removed, reason: remove.stderr.trim() };
  }

  /** Remove every worktree this manager created. */
  public async cleanupAll(): Promise<string[]> {
    const cleaned: string[] = [];
    for (const taskId of Array.from(this.active.keys())) {
      const result = await this.cleanup(taskId);
      if (result.removed) {
        cleaned.push(taskId);
      }
    }
    return cleaned;
  }

  public activeTaskIds(): string[] {
    return Array.from(this.active.keys());
  }

  public isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }
}
