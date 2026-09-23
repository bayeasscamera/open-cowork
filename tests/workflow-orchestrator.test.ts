import { describe, it, expect } from 'vitest';
import {
  CheckpointManager,
  type FileSnapshotBackend,
} from '../src/main/agent/checkpoint-manager';
import { AuditLog } from '../src/main/agent/audit-log';
import { createDefaultPermissionPolicy } from '../src/main/agent/permission-policy';
import { WorkflowOrchestrator } from '../src/main/agent/workflow-orchestrator';
import { createAtomicTask, createTaskContract } from '../src/shared/task-contract';

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

const criterion = { id: 'c1', description: 'tests pass', verification: 'npm test', required: true };
const evidence = { kind: 'test' as const, description: 'tests', command: 'npm test', required: true };

function makeOrchestrator() {
  const backend = new MemoryBackend();
  const audit = new AuditLog();
  const checkpoints = new CheckpointManager({ backend, audit });
  const states: string[] = [];
  const orchestrator = new WorkflowOrchestrator({
    policy: createDefaultPermissionPolicy('/ws'),
    checkpoints,
    audit,
    onStateChange: (state) => states.push(state.phase),
  });
  return { backend, audit, checkpoints, orchestrator, states };
}

function executeContract() {
  return createTaskContract({
    objective: 'Ship it',
    allowedFiles: ['src/a.ts'],
    acceptanceCriteria: [criterion],
    expectedEvidence: [evidence],
    budget: { maxTokens: 100 },
  });
}

function wideContract() {
  return createTaskContract({
    objective: 'Ship it',
    allowedFiles: ['src/**'],
    acceptanceCriteria: [criterion],
    expectedEvidence: [evidence],
    budget: { maxTokens: 100 },
  });
}

function executeTask(overrides: Record<string, unknown> = {}) {
  return createAtomicTask({
    id: 't1',
    title: 'Implement',
    writeScope: ['src/a.ts'],
    exitCriteria: [criterion],
    requiredEvidence: [evidence],
    budget: { maxTokens: 100 },
    requestedCapabilities: ['read', 'write'],
    ...overrides,
  });
}

describe('workflow-orchestrator', () => {
  it('runs the full Plan -> Act -> Verify happy path', async () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.loadContract(executeContract(), [executeTask()]);

    const request = orchestrator.requestApproval();
    expect(request.blockers).toEqual([]);
    expect(orchestrator.approve({ approved: true }).approved).toBe(true);
    expect(orchestrator.startExecution()).toEqual({ started: true, reasons: [] });

    const checkpoint = await orchestrator.startTask('t1');
    expect(checkpoint.taskId).toBe('t1');

    await orchestrator.completeTask('t1', [
      { kind: 'test', description: 'npm test', command: 'npm test', exitCode: 0, output: 'ok' },
    ]);
    expect(orchestrator.getState().phase).toBe('verifying');

    const verified = orchestrator.verify();
    expect(verified.ok).toBe(true);
    expect(verified.missing).toEqual([]);
    expect(verified.report?.ok).toBe(true);
    expect(verified.report?.tasks).toEqual([
      expect.objectContaining({ taskId: 't1', ok: true, issues: [] }),
    ]);
    expect(orchestrator.getState().phase).toBe('completed');
  });

  it('refuses to execute before approval', () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.loadContract(executeContract(), [executeTask()]);

    const result = orchestrator.startExecution();
    expect(result.started).toBe(false);
    expect(result.reasons).toContain('Plan has not been approved yet.');
    expect(orchestrator.getState().phase).toBe('failed');
  });

  it('refuses to execute in explore mode', () => {
    const { orchestrator } = makeOrchestrator();
    const contract = createTaskContract({
      objective: 'Audit only',
      mode: 'explore',
      acceptanceCriteria: [criterion],
      expectedEvidence: [evidence],
      budget: { maxTokens: 10 },
    });
    orchestrator.loadContract(contract, [
      createAtomicTask({
        id: 't1',
        title: 'Audit',
        exitCriteria: [criterion],
        requiredEvidence: [evidence],
        requestedCapabilities: ['read'],
      }),
    ]);

    expect(orchestrator.getState().phase).toBe('exploring');
    const result = orchestrator.startExecution();
    expect(result.started).toBe(false);
    expect(result.reasons.some((reason) => reason.includes('does not allow writes'))).toBe(true);
  });

  it('fails verification when required evidence is missing', async () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.loadContract(executeContract(), [executeTask()]);
    orchestrator.requestApproval();
    orchestrator.approve({ approved: true });
    orchestrator.startExecution();
    await orchestrator.startTask('t1');
    await orchestrator.completeTask('t1');

    const verified = orchestrator.verify();
    expect(verified.ok).toBe(false);
    expect(verified.missing).toContain('t1: missing test evidence');
  });

  it('stops the workflow when a task is rejected', async () => {
    const { orchestrator, backend } = makeOrchestrator();
    backend.files.set('src/a.ts', 'old');
    orchestrator.loadContract(executeContract(), [executeTask()]);
    orchestrator.requestApproval();
    orchestrator.approve({ approved: true });
    orchestrator.startExecution();
    await orchestrator.startTask('t1');
    backend.files.set('src/a.ts', 'new');

    const state = await orchestrator.rejectTask('t1', 'bad idea');
    expect(state.phase).toBe('failed');
    expect(state.blockers[0]).toContain('bad idea');
    expect(backend.files.get('src/a.ts')).toBe('old');
  });

  it('rolls the whole plan back on restorePlan', async () => {
    const { orchestrator, backend } = makeOrchestrator();
    backend.files.set('src/a.ts', 'old');
    orchestrator.loadContract(executeContract(), [executeTask()]);
    orchestrator.requestApproval();
    orchestrator.approve({ approved: true });
    orchestrator.startExecution();
    await orchestrator.startTask('t1');
    backend.files.set('src/a.ts', 'new');

    const state = await orchestrator.restorePlan();
    expect(state.phase).toBe('cancelled');
    expect(backend.files.get('src/a.ts')).toBe('old');
  });

  it('leaves execute mode when the mode changes mid-run', async () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.loadContract(executeContract(), [executeTask()]);
    orchestrator.requestApproval();
    orchestrator.approve({ approved: true });
    orchestrator.startExecution();

    const state = orchestrator.setMode('plan');
    expect(state.phase).toBe('planning');
    expect(state.blockers[0]).toContain('mode switched');
  });

  it('rejects unknown tasks and unmet dependencies', async () => {
    const { orchestrator } = makeOrchestrator();
    const dependent = executeTask({ id: 't2', title: 'Second', dependsOn: ['t1'] });
    orchestrator.loadContract(executeContract(), [executeTask(), dependent]);
    orchestrator.requestApproval();
    orchestrator.approve({ approved: true });
    orchestrator.startExecution();

    await expect(orchestrator.startTask('ghost')).rejects.toThrow('Unknown task: ghost');
    await expect(orchestrator.startTask('t2')).rejects.toThrow('unmet dependencies');
    expect(orchestrator.getState().readyTaskIds).toEqual(['t1']);
  });

  it('exposes execution groups in state', () => {
    const { orchestrator } = makeOrchestrator();
    const dependent = executeTask({ id: 't2', title: 'Second', dependsOn: ['t1'] });
    orchestrator.loadContract(executeContract(), [executeTask(), dependent]);
    const state = orchestrator.getState();
    expect(state.groups).toHaveLength(2);
  });

  it('serialises two ready writers that share a file', async () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.loadContract(wideContract(), [
      executeTask({ id: 't1', title: 'First' }),
      executeTask({ id: 't2', title: 'Second' }),
    ]);
    orchestrator.requestApproval();
    orchestrator.approve({ approved: true });
    orchestrator.startExecution();

    const run = await orchestrator.startReadyTasks();
    expect(run.started.map((checkpoint) => checkpoint.taskId)).toEqual(['t1']);
    expect(run.skipped).toEqual(['t2']);
    expect(run.reasons[0]).toContain('overlaps task "t1"');
    expect(run.reasons[0]).toContain('src/a.ts');
  });

  it('starts two ready writers whose scopes are disjoint', async () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.loadContract(wideContract(), [
      executeTask({ id: 't1', title: 'First', writeScope: ['src/a.ts'] }),
      executeTask({ id: 't2', title: 'Second', writeScope: ['src/b.ts'] }),
    ]);
    orchestrator.requestApproval();
    orchestrator.approve({ approved: true });
    orchestrator.startExecution();

    const run = await orchestrator.startReadyTasks();
    expect(run.started.map((checkpoint) => checkpoint.taskId)).toEqual(['t1', 't2']);
    expect(run.skipped).toEqual([]);
  });

  it('reports write conflicts and conflict-free groups in the state', () => {
    const { orchestrator } = makeOrchestrator();
    orchestrator.loadContract(wideContract(), [
      executeTask({ id: 't1', title: 'First' }),
      executeTask({ id: 't2', title: 'Second' }),
    ]);

    const state = orchestrator.getState();
    expect(state.writeConflicts).toEqual([{ a: 't1', b: 't2', paths: ['src/a.ts'] }]);
    expect(state.groups.map((group) => group.map((task) => task.id))).toEqual([['t1'], ['t2']]);
  });

  it('emits a state change for every transition', async () => {
    const { orchestrator, states } = makeOrchestrator();
    orchestrator.loadContract(executeContract(), [executeTask()]);
    orchestrator.requestApproval();
    orchestrator.approve({ approved: true });
    orchestrator.startExecution();
    expect(states).toContain('awaiting-approval');
    expect(states).toContain('executing');
  });
});
