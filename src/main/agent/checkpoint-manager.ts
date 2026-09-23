/**
 * @module main/agent/checkpoint-manager
 *
 * Cowork 4.0 — Phase 2: a checkpoint is captured before every writing task so
 * the user can review a per-task diff, attach test/command evidence, then
 * accept, reject, restore a single task or roll the whole plan back.
 *
 * The manager is storage-agnostic: the file snapshot backend and the git runner
 * are injected, which keeps it unit-testable without touching a real repo.
 */

import { computeUnifiedDiff } from '../../shared/diff-preview';
import type { AtomicTask } from '../../shared/task-contract';
import type {
  CheckpointEvidence,
  NewCheckpointEvidence,
  TaskCheckpoint,
} from '../../shared/workflow-types';
import type { AuditLog } from './audit-log';

export type {
  CheckpointEvidence,
  CheckpointStatus,
  NewCheckpointEvidence,
  TaskCheckpoint,
} from '../../shared/workflow-types';

export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: string[]): Promise<GitRunResult>;
}

export interface FileSnapshotBackend {
  /** Capture content for each path; `null` means the file did not exist. */
  capture(paths: string[]): Promise<Map<string, string | null>>;
  /** Restore a snapshot; a `null` value deletes the file. */
  restore(snapshot: Map<string, string | null>): Promise<void>;
  /** Read a single path now; `null` when absent. */
  read(path: string): Promise<string | null>;
}

export interface CheckpointManagerOptions {
  backend: FileSnapshotBackend;
  git?: GitRunner;
  now?: () => number;
  audit?: AuditLog;
}

/** Format a single-file unified diff body. */
export function formatFileDiff(filePath: string, oldContent: string, newContent: string): string {
  const result = computeUnifiedDiff(filePath, oldContent, newContent);
  if (result.additions === 0 && result.deletions === 0) {
    return '';
  }
  const header = '--- a/' + filePath + '\n+++ b/' + filePath;
  const body = result.lines
    .filter((line) => line.type !== 'unchanged')
    .map((line) => (line.type === 'added' ? '+' : '-') + line.content)
    .join('\n');
  return header + '\n' + body;
}

export class CheckpointManager {
  private readonly backend: FileSnapshotBackend;
  private readonly git: GitRunner | undefined;
  private readonly now: () => number;
  private readonly audit: AuditLog | undefined;
  private readonly snapshots = new Map<string, Map<string, string | null>>();
  private readonly checkpoints = new Map<string, TaskCheckpoint>();
  private sequence = 0;

  constructor(options: CheckpointManagerOptions) {
    this.backend = options.backend;
    this.git = options.git;
    this.now = options.now ?? (() => Date.now());
    this.audit = options.audit;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return prefix + '-' + this.sequence.toString(36) + '-' + this.now().toString(36);
  }

  /**
   * Snapshot the task write scope before it runs. Read-only tasks get a
   * checkpoint too, so the plan timeline stays complete, but with no files.
   */
  public async createCheckpoint(
    task: Pick<AtomicTask, 'id' | 'title' | 'writeScope'>
  ): Promise<TaskCheckpoint> {
    const files = [...new Set(task.writeScope)];
    const snapshot = await this.backend.capture(files);
    const baseRevision = await this.readBaseRevision();

    const checkpoint: TaskCheckpoint = {
      id: this.nextId('ckpt'),
      taskId: task.id,
      title: task.title,
      createdAt: this.now(),
      status: 'pending',
      files,
      baseRevision,
      diff: '',
      additions: 0,
      deletions: 0,
      evidence: [],
    };

    this.snapshots.set(checkpoint.id, snapshot);
    this.checkpoints.set(checkpoint.id, checkpoint);
    await this.refreshDiff(checkpoint.id);

    this.audit?.append({
      action: 'checkpoint.create',
      justification: 'Snapshot captured before task "' + task.id + '".',
      authorization: 'auto',
      capability: 'write',
      files,
      taskId: task.id,
    });

    return this.requireCheckpoint(checkpoint.id);
  }

  private async readBaseRevision(): Promise<string | null> {
    if (!this.git) {
      return null;
    }
    try {
      const result = await this.git.run(['rev-parse', 'HEAD']);
      if (result.exitCode !== 0) {
        return null;
      }
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** Recompute the diff between the snapshot and the current files. */
  public async refreshDiff(checkpointId: string): Promise<TaskCheckpoint> {
    const checkpoint = this.requireCheckpoint(checkpointId);
    const snapshot = this.snapshots.get(checkpointId) ?? new Map();

    const parts: string[] = [];
    let additions = 0;
    let deletions = 0;

    for (const file of checkpoint.files) {
      const before = snapshot.get(file) ?? null;
      const after = await this.backend.read(file);
      if (before === null && after === null) {
        continue;
      }
      const diff = formatFileDiff(file, before ?? '', after ?? '');
      if (diff.length === 0) {
        continue;
      }
      parts.push(diff);
      const result = computeUnifiedDiff(file, before ?? '', after ?? '');
      additions += result.additions;
      deletions += result.deletions;
    }

    checkpoint.diff = parts.join('\n');
    checkpoint.additions = additions;
    checkpoint.deletions = deletions;
    return { ...checkpoint, evidence: [...checkpoint.evidence] };
  }

  /** Attach a proof (test run, command output, review) to the checkpoint. */
  public attachEvidence(checkpointId: string, evidence: NewCheckpointEvidence): CheckpointEvidence {
    const checkpoint = this.requireCheckpoint(checkpointId);
    const record: CheckpointEvidence = {
      ...evidence,
      id: this.nextId('evidence'),
      recordedAt: evidence.recordedAt ?? this.now(),
    };
    checkpoint.evidence.push(record);
    this.audit?.append({
      action: 'checkpoint.evidence',
      justification: evidence.description,
      authorization: 'auto',
      capability: evidence.kind === 'test' || evidence.kind === 'command' ? 'shell' : 'read',
      verification: evidence.output,
      evidenceIds: [record.id],
      taskId: checkpoint.taskId,
    });
    return record;
  }

  public list(): TaskCheckpoint[] {
    return Array.from(this.checkpoints.values()).map((checkpoint) => ({
      ...checkpoint,
      evidence: [...checkpoint.evidence],
    }));
  }

  public get(checkpointId: string): TaskCheckpoint | null {
    const checkpoint = this.checkpoints.get(checkpointId);
    return checkpoint ? { ...checkpoint, evidence: [...checkpoint.evidence] } : null;
  }

  public forTask(taskId: string): TaskCheckpoint | null {
    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.taskId === taskId) {
        return { ...checkpoint, evidence: [...checkpoint.evidence] };
      }
    }
    return null;
  }

  private requireCheckpoint(checkpointId: string): TaskCheckpoint {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error('Unknown checkpoint: ' + checkpointId);
    }
    return checkpoint;
  }

  private requireTaskCheckpoint(taskId: string): TaskCheckpoint {
    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.taskId === taskId) {
        return checkpoint;
      }
    }
    throw new Error('No checkpoint for task: ' + taskId);
  }

  /** Keep the task changes: mark accepted and refresh the recorded diff. */
  public async acceptTask(taskId: string): Promise<TaskCheckpoint> {
    const checkpoint = this.requireTaskCheckpoint(taskId);
    await this.refreshDiff(checkpoint.id);
    checkpoint.status = 'accepted';
    delete checkpoint.rejectionReason;
    this.audit?.append({
      action: 'task.accept',
      justification: 'Task "' + taskId + '" accepted by user.',
      authorization: 'approved',
      capability: 'write',
      files: checkpoint.files,
      diff: checkpoint.diff,
      taskId,
    });
    return this.get(checkpoint.id) as TaskCheckpoint;
  }

  /** Discard the task changes and restore the pre-task snapshot. */
  public async rejectTask(taskId: string, reason?: string): Promise<TaskCheckpoint> {
    const checkpoint = this.requireTaskCheckpoint(taskId);
    const snapshot = this.snapshots.get(checkpoint.id) ?? new Map();
    await this.backend.restore(snapshot);
    checkpoint.status = 'rejected';
    checkpoint.rejectionReason = reason?.trim() || 'Rejected by user.';
    await this.refreshDiff(checkpoint.id);
    this.audit?.append({
      action: 'task.reject',
      justification: checkpoint.rejectionReason,
      authorization: 'rejected',
      capability: 'write',
      files: checkpoint.files,
      diff: checkpoint.diff,
      taskId,
    });
    return this.get(checkpoint.id) as TaskCheckpoint;
  }

  /** Undo an accepted task by restoring its snapshot without rejecting it. */
  public async restoreTask(taskId: string): Promise<TaskCheckpoint> {
    const checkpoint = this.requireTaskCheckpoint(taskId);
    const snapshot = this.snapshots.get(checkpoint.id) ?? new Map();
    await this.backend.restore(snapshot);
    checkpoint.status = 'restored';
    await this.refreshDiff(checkpoint.id);
    this.audit?.append({
      action: 'task.restore',
      justification: 'Task "' + taskId + '" rolled back to its checkpoint.',
      authorization: 'approved',
      capability: 'write',
      files: checkpoint.files,
      taskId,
    });
    return this.get(checkpoint.id) as TaskCheckpoint;
  }

  /** Roll the whole plan back, newest task first, then oldest. */
  public async restorePlan(): Promise<{ restored: string[] }> {
    const ordered = Array.from(this.checkpoints.values()).sort(
      (a, b) => b.createdAt - a.createdAt
    );
    const restored: string[] = [];
    for (const checkpoint of ordered) {
      const snapshot = this.snapshots.get(checkpoint.id) ?? new Map();
      await this.backend.restore(snapshot);
      checkpoint.status = 'restored';
      await this.refreshDiff(checkpoint.id);
      restored.push(checkpoint.taskId);
    }
    this.audit?.append({
      action: 'plan.restore',
      justification: 'Whole plan rolled back to its checkpoints.',
      authorization: 'approved',
      capability: 'write',
      files: Array.from(new Set(ordered.flatMap((checkpoint) => checkpoint.files))),
    });
    return { restored };
  }

  /** Convenience: record the result of a verification command as evidence. */
  public attachCommandEvidence(
    checkpointId: string,
    command: string,
    exitCode: number,
    output: string
  ): CheckpointEvidence {
    return this.attachEvidence(checkpointId, {
      kind: exitCode === 0 ? 'test' : 'command',
      description: 'Ran "' + command + '" (exit ' + exitCode + ').',
      command,
      exitCode,
      output,
    });
  }
}
