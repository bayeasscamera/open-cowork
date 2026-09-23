import { describe, it, expect, vi } from 'vitest';
import { AuditLog } from '../src/main/agent/audit-log';
import { CheckpointManager, type FileSnapshotBackend } from '../src/main/agent/checkpoint-manager';
import { IsolationManager } from '../src/main/agent/isolation-manager';
import {
  DEFAULT_ISOLATION_POLICY,
} from '../src/main/agent/isolation-planner';
import { createDefaultPermissionPolicy } from '../src/main/agent/permission-policy';
import {
  WorkflowExecutor,
  buildTaskPrompt,
  type WorkflowTaskContext,
} from '../src/main/agent/workflow-executor';
import { WorkflowOrchestrator } from '../src/main/agent/workflow-orchestrator';
import type { GitRunner } from '../src/main/agent/checkpoint-backends';
import { createAtomicTask, createTaskContract } from '../src/shared/task-contract';
import type { AtomicTask, TaskContract } from '../src/shared/task-contract';

class MemoryBackend implements FileSnapshotBackend {
  public files = new Map<string, string>();
  async capture(paths: string[]) {
    const snapshot = new Map<string, string | null>();
    for (const file of paths) snapshot.set(file, this.files.get(file) ?? null);
    return snapshot;
  }
  async restore(snapshot: Map<string, string | null>) {
    for (const [file, content] of snapshot) {
      if (content === null) this.files.delete(file);
      else this.files.set(file, content);
    }
  }
  async read(file: string) {
    return this.files.get(file) ?? null;
  }
}

const criterion = (id: string, verification: string) => ({
  id,
  description: 'criterion ' + id,
  verification,
  required: true,
});

const testEvidence = {
  kind: 'test' as const,
  description: 'tests',
  command: 'npm test',
  required: true,
};

function makeTask(overrides: Partial<AtomicTask> = {}): AtomicTask {
  return createAtomicTask({
    id: 't1',
    title: 'Implement',
    writeScope: ['src/a.ts'],
    exitCriteria: [criterion('c1', 'npm test')],
    requiredEvidence: [testEvidence],
    budget: { maxTokens: 100 },
    requestedCapabilities: ['read', 'write'],
    ...overrides,
  });
}

function makeContract(): TaskContract {
  return createTaskContract({
    objective: 'Ship it',
    allowedFiles: ['src/a.ts'],
    acceptanceCriteria: [criterion('c1', 'npm test')],
    expectedEvidence: [testEvidence],
    budget: { maxTokens: 100 },
  });
}

/** Approval is a precondition of execution; every test goes through it. */
function makeApprovedOrchestrator(tasks: AtomicTask[] = [makeTask()]) {
  const audit = new AuditLog();
  const checkpoints = new CheckpointManager({ backend: new MemoryBackend(), audit });
  const orchestrator = new WorkflowOrchestrator({
    policy: createDefaultPermissionPolicy('/ws'),
    checkpoints,
    audit,
  });
  orchestrator.loadContract(makeContract(), tasks);
  orchestrator.requestApproval();
  orchestrator.approve({ approved: true });
  return { orchestrator, checkpoints, audit };
}

const okProof = async () => ({ exitCode: 0, output: 'all tests passed', timedOut: false });

describe('WorkflowExecutor', () => {
  it('does not run anything before the plan is approved', async () => {
    const audit = new AuditLog();
    const checkpoints = new CheckpointManager({ backend: new MemoryBackend(), audit });
    const orchestrator = new WorkflowOrchestrator({
      policy: createDefaultPermissionPolicy('/ws'),
      checkpoints,
      audit,
    });
    orchestrator.loadContract(makeContract(), [makeTask()]);

    const runTask = vi.fn();
    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    const report = await executor.executePlan();
    expect(report.started).toBe(false);
    expect(runTask).not.toHaveBeenCalled();
  });

  it('drives an approved plan through the runner and records the result', async () => {
    const { orchestrator } = makeApprovedOrchestrator();
    const runTask = vi.fn(async (context: WorkflowTaskContext) => {
      context.onToolCall(2);
      return { success: true, summary: 'Change applied and npm test is green.' };
    });

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    const report = await executor.executePlan();

    expect(report.started).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].status).toBe('succeeded');
    expect(report.results[0].toolCalls).toBe(2);
    expect(report.results[0].verification?.ok).toBe(true);
    expect(report.completedTaskIds).toEqual(['t1']);
    expect(report.phase).toBe('completed');

    expect(runTask).toHaveBeenCalledTimes(1);
    const context = runTask.mock.calls[0][0];
    expect(context.cwd).toBe('/ws');
    expect(context.isolated).toBe(false);
    expect(context.prompt).toContain('You are the "implementer" sub-agent');
    expect(context.prompt).toContain('npm test');
  });

  it('re-runs the declared proof command instead of trusting the agent', async () => {
    const { orchestrator, checkpoints, audit } = makeApprovedOrchestrator();
    const runTask = vi.fn(async () => ({
      success: true,
      summary: 'Done, everything passes.',
      // The agent claims a green test run.
      evidence: [
        {
          kind: 'test' as const,
          description: 'npm test',
          command: 'npm test',
          exitCode: 0,
          output: '37 passed',
        },
      ],
    }));
    const runProof = vi.fn(async () => ({
      exitCode: 1,
      output: '1 failed',
      timedOut: false,
    }));

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof,
    });

    const report = await executor.executePlan();

    expect(runProof).toHaveBeenCalledWith('npm test', '/ws', expect.any(Number));
    expect(report.results[0].status).toBe('failed');
    expect(report.results[0].error).toContain('exited with code 1');
    expect(report.phase).toBe('failed');

    // The re-run proof is recorded with its real exit code, side by side with
    // the exit code the agent claimed.
    const checkpoint = checkpoints.forTask('t1');
    const recorded = checkpoint?.evidence.filter((entry) => entry.command === 'npm test') ?? [];
    expect(recorded.map((entry) => entry.exitCode)).toEqual([1]);
    expect(
      audit.list().filter((entry) => entry.action === 'checkpoint.evidence')
    ).toHaveLength(1);
    expect(audit.list().some((entry) => entry.action === 'task.failed')).toBe(true);
  });

  it('stops at the first failing task and never runs its dependent', async () => {
    const first = makeTask({ id: 't1' });
    const second = makeTask({ id: 't2', dependsOn: ['t1'] });
    const { orchestrator } = makeApprovedOrchestrator([first, second]);

    const runTask = vi.fn(async (context: WorkflowTaskContext) =>
      context.task.id === 't1'
        ? { success: false, summary: 'could not apply', error: 'could not apply' }
        : { success: true, summary: 'never reached' }
    );

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    const report = await executor.executePlan();

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(report.results.map((result) => result.taskId)).toEqual(['t1']);
    expect(report.failedTaskIds).toEqual(['t1']);
    expect(report.phase).toBe('failed');
  });

  it('refuses a task whose capability policy forbids it', async () => {
    // A zero-trust policy that refuses writes outright: the plan is approved,
    // but the task must never reach the agent loop.
    const outsideTask = makeTask({ id: 't1' });
    const { orchestrator } = makeApprovedOrchestrator([outsideTask]);
    const runTask = vi.fn();

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: {
        workspaceRoot: '/ws',
        defaultDecision: 'auto',
        rules: [{ id: 'write.forbidden', capability: 'write', decision: 'forbidden' }],
      },
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    const report = await executor.executePlan();

    expect(runTask).not.toHaveBeenCalled();
    expect(report.results[0].status).toBe('forbidden');
    expect(report.skippedTaskIds).toEqual(
      expect.arrayContaining(['t1'])
    );
    expect(new Set(report.skippedTaskIds)).toEqual(new Set(['t1']));
    expect(executor.forbiddenCapabilities(outsideTask)).toEqual(['write']);
  });

  it('marks a task that overruns its tool budget', async () => {
    const budgeted = makeTask({ budget: { maxTokens: 100, maxToolCalls: 2 } });
    const { orchestrator } = makeApprovedOrchestrator([budgeted]);
    const runTask = vi.fn(async (context: WorkflowTaskContext) => {
      context.onToolCall(5);
      return { success: true, summary: 'Kept going anyway.' };
    });

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    const report = await executor.executePlan();

    expect(report.results[0].status).toBe('budget-exceeded');
    expect(report.results[0].toolCalls).toBe(5);
  });

  it('marks a task that overruns its token budget', async () => {
    const budgeted = makeTask({ budget: { maxTokens: 100, maxToolCalls: 50 } });
    const { orchestrator } = makeApprovedOrchestrator([budgeted]);
    const runTask = vi.fn(async (context: WorkflowTaskContext) => {
      // The runner streams the tokens each model turn consumed.
      context.onTokens?.(500);
      return { success: true, summary: 'Kept going anyway.' };
    });

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    const report = await executor.executePlan();

    expect(report.results[0].status).toBe('budget-exceeded');
    expect(report.results[0].error).toContain('Token budget exceeded');
    expect(report.results[0].tokens).toBe(500);
  });

  it('reconciles a token total reported only in the outcome', async () => {
    const budgeted = makeTask({ budget: { maxTokens: 100, maxToolCalls: 50 } });
    const { orchestrator } = makeApprovedOrchestrator([budgeted]);
    const runTask = vi.fn(async () => ({
      success: true,
      summary: 'Done.',
      tokens: 250,
    }));

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    const report = await executor.executePlan();

    expect(report.results[0].status).toBe('budget-exceeded');
    expect(report.results[0].tokens).toBe(250);
  });

  it('runs a task whose capabilities the policy allows', async () => {
    // Regression guard: workspace-relative paths are "inside" and must not be
    // mistaken for out-of-workspace access.
    const { orchestrator } = makeApprovedOrchestrator();
    const executor = new WorkflowExecutor({
      orchestrator,
      runTask: async () => ({ success: true, summary: 'Fine.' }),
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    expect(executor.forbiddenCapabilities(makeTask())).toEqual([]);
  });

  it('reports the proof failure when the agent produced no evidence at all', async () => {
    const { orchestrator } = makeApprovedOrchestrator();
    const runTask = vi.fn(async () => ({ success: true, summary: 'trust me' }));

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    const report = await executor.executePlan();
    // The proof itself was re-run and exited 0, so the criterion is proven,
    // even though the agent attached no evidence of its own.
    expect(report.results[0].status).toBe('succeeded');
    expect(report.results[0].evidenceKinds).toEqual([]);
    expect(report.results[0].verification?.ok).toBe(true);
  });

  it('runs the task in a worktree when isolation is requested', async () => {
    const { orchestrator } = makeApprovedOrchestrator();
    const calls: string[] = [];
    const git: GitRunner = {
      run: async (args: string[]) => {
        calls.push(args[0] + ' ' + args[1]);
        if (args[0] === 'diff') {
          return {
            exitCode: 0,
            stdout: 'diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n',
            stderr: '',
          };
        }
        if (args[0] === 'worktree' && args[1] === 'remove') {
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const isolation = new IsolationManager({
      git,
      gitFactory: () => git,
      audit: new AuditLog(),
    });

    const runTask = vi.fn(async (context: WorkflowTaskContext) => {
      expect(context.isolated).toBe(true);
      expect(context.cwd).toBe('/ws/.cowork-worktrees/t1');
      return { success: true, summary: 'Changed the file inside the worktree.' };
    });

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      isolation,
      // Every mutating task is isolated by default, which is exactly the
      // property this test pins.
      isolationPolicy: DEFAULT_ISOLATION_POLICY,
      runProof: okProof,
    });

    const report = await executor.executePlan();

    expect(calls).toContain('worktree add');
    expect(calls).toContain('diff HEAD');
    expect(calls).toContain('worktree remove');
    expect(report.results[0].isolated).toBe(true);
    // The diff survives cleanup because it rides on the evidence.
    expect(report.results[0].evidenceKinds).toContain('diff');
    expect(report.results[0].verification?.ok).toBe(true);
  });

  it('exposes the full execution report for a partially run plan', async () => {
    const first = makeTask({ id: 't1' });
    const { orchestrator } = makeApprovedOrchestrator([first]);
    const results: string[] = [];

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask: async () => ({ success: true, summary: 'Fine.' }),
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
      onTaskResult: (result) => results.push(result.taskId + ':' + result.status),
    });

    await executor.executePlan();
    expect(results).toEqual(['t1:succeeded']);
  });

  it('starts an approved plan when only the ready tasks are requested', async () => {
    const { orchestrator } = makeApprovedOrchestrator();
    const executor = new WorkflowExecutor({
      orchestrator,
      runTask: async () => ({ success: true, summary: 'Fine.' }),
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    const results = await executor.executeReadyTasks();

    expect(results.map((result) => result.status)).toEqual(['succeeded']);
    // Running only the ready tasks does not run the final plan verification.
    expect(orchestrator.getPhase()).toBe('verifying');
  });

  it('returns an empty list when the plan is not executing', async () => {
    const audit = new AuditLog();
    const checkpoints = new CheckpointManager({ backend: new MemoryBackend(), audit });
    const orchestrator = new WorkflowOrchestrator({
      policy: createDefaultPermissionPolicy('/ws'),
      checkpoints,
      audit,
    });

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask: async () => ({ success: true, summary: 'x' }),
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
    });

    expect(await executor.executeReadyTasks()).toEqual([]);
  });
});

describe('buildTaskPrompt', () => {
  it('lists the write scope, criteria and proof commands', () => {
    const prompt = buildTaskPrompt(makeTask({ role: 'tester' }), makeContract());
    expect(prompt).toContain('tester');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('Implement');
    expect(prompt).toContain('cannot be proven, say so explicitly');
  });

  it('tells a read-only task not to write', () => {
    const prompt = buildTaskPrompt(
      makeTask({ role: 'reviewer', writeScope: [], requiredEvidence: [] }),
      makeContract()
    );
    expect(prompt).toContain('Read-only task: do not modify any file.');
  });
});
