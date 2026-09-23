import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AuditLog } from '../src/main/agent/audit-log';
import { CheckpointManager, type FileSnapshotBackend } from '../src/main/agent/checkpoint-manager';
import { createDefaultPermissionPolicy } from '../src/main/agent/permission-policy';
import {
  MutableRunControl,
  WorkflowExecutor,
  type WorkflowTaskContext,
} from '../src/main/agent/workflow-executor';
import { WorkflowOrchestrator } from '../src/main/agent/workflow-orchestrator';
import { WorkflowRegistry } from '../src/main/agent/workflow-registry';
import { createAtomicTask, createTaskContract } from '../src/shared/task-contract';
import type { AtomicTask } from '../src/shared/task-contract';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

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

const criterion = {
  id: 'c1',
  description: 'tests pass',
  verification: 'npm test',
  required: true,
};

const evidence = {
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
    exitCriteria: [criterion],
    requiredEvidence: [evidence],
    budget: { maxTokens: 100 },
    requestedCapabilities: ['read', 'write'],
    ...overrides,
  });
}

function makeContract() {
  return createTaskContract({
    objective: 'Ship it',
    allowedFiles: ['src/a.ts'],
    acceptanceCriteria: [criterion],
    expectedEvidence: [evidence],
    budget: { maxTokens: 100 },
  });
}

const okProof = async () => ({ exitCode: 0, output: 'all tests passed', timedOut: false });

const executorBase = (tasks: AtomicTask[]) => {
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
  return {
    orchestrator,
    policy: createDefaultPermissionPolicy('/ws'),
    workspaceRoot: '/ws',
    runProof: okProof,
  };
};

const twoTasks = () => [makeTask({ id: 't1' }), makeTask({ id: 't2' })];

describe('pause and resume', () => {
  it('pauses after the running task and never starts the next one', async () => {
    const control = new MutableRunControl();
    const ran: string[] = [];
    const runTask = vi.fn(async (context: WorkflowTaskContext) => {
      ran.push(context.task.id);
      control.requestPause();
      return { success: true, summary: 'Change applied and npm test is green.' };
    });

    const executor = new WorkflowExecutor({ ...executorBase(twoTasks()), runTask, control });
    const report = await executor.executePlan();

    expect(ran).toEqual(['t1']);
    expect(report.results).toHaveLength(1);
    expect(report.phase).toBe('paused');
    // A paused run must not be verified: that would claim the plan completed.
    expect(report.verification).toBeNull();
  });

  it('resumes where it stopped instead of replaying finished tasks', async () => {
    const control = new MutableRunControl();
    const ran: string[] = [];
    const runner = (pauseOnFirst: boolean) =>
      vi.fn(async (context: WorkflowTaskContext) => {
        ran.push(context.task.id);
        if (pauseOnFirst && context.task.id === 't1') {
          control.requestPause();
        }
        return { success: true, summary: 'Change applied and npm test is green.' };
      });

    const base = executorBase(twoTasks());
    const paused = await new WorkflowExecutor({
      ...base,
      runTask: runner(true),
      control,
    }).executePlan();
    expect(paused.phase).toBe('paused');

    const resumed = await new WorkflowExecutor({
      ...base,
      runTask: runner(false),
    }).executePlan();

    expect(ran).toEqual(['t1', 't2']);
    expect(resumed.phase).toBe('completed');
    expect(resumed.completedTaskIds).toEqual(['t1', 't2']);
  });

  it('leaves no blocker behind, so a resume is never refused', async () => {
    const control = new MutableRunControl();
    const runTask = vi.fn(async () => {
      control.requestPause();
      return { success: true, summary: 'Change applied and npm test is green.' };
    });

    const base = executorBase(twoTasks());
    await new WorkflowExecutor({ ...base, runTask, control }).executePlan();

    expect(base.orchestrator.getState().blockers).toEqual([]);
  });
});

describe('cancel', () => {
  it('aborts the task in flight and reports it as cancelled, not failed', async () => {
    const control = new MutableRunControl();
    let abortedWhenAsked = false;
    const runTask = vi.fn(async (context: WorkflowTaskContext) => {
      control.requestCancel();
      abortedWhenAsked = context.signal.aborted;
      return { success: false, summary: 'aborted', error: 'aborted' };
    });

    const executor = new WorkflowExecutor({ ...executorBase(twoTasks()), runTask, control });
    const report = await executor.executePlan();

    expect(abortedWhenAsked).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0].status).toBe('cancelled');
    expect(report.failedTaskIds).toEqual([]);
    expect(report.skippedTaskIds).toContain('t1');
    expect(report.phase).toBe('cancelled');
    expect(report.verification).toBeNull();
  });

  it('records why the run stopped', async () => {
    const control = new MutableRunControl();
    const base = executorBase(twoTasks());
    const runTask = vi.fn(async () => {
      control.requestCancel();
      return { success: false, summary: 'aborted' };
    });

    await new WorkflowExecutor({ ...base, runTask, control }).executePlan();

    expect(base.orchestrator.getState().blockers.length).toBeGreaterThan(0);
  });
});

describe('orchestrator pause and cancel', () => {
  it('ignores a pause when nothing is executing', () => {
    const { orchestrator } = executorBase(twoTasks());
    const before = orchestrator.getPhase();
    expect(orchestrator.pause().phase).toBe(before);
  });

  it('cancels from an active phase and stays cancelled', () => {
    const { orchestrator } = executorBase(twoTasks());
    const state = orchestrator.cancel('Stopped by the test.');
    expect(state.phase).toBe('cancelled');
    expect(state.blockers).toContain('Stopped by the test.');
    expect(orchestrator.cancel().phase).toBe('cancelled');
  });
});

describe('registry run control', () => {
  const buildApproved = () => {
    const registry = new WorkflowRegistry({ resolveWorkspaceRoot: () => '/ws' });
    const entry = registry.getOrCreate('s1');
    if (!entry) {
      throw new Error('registry did not create an entry');
    }
    entry.orchestrator.loadContract(makeContract(), twoTasks());
    entry.orchestrator.requestApproval();
    entry.orchestrator.approve({ approved: true });
    entry.orchestrator.startExecution();
    return { registry, entry };
  };

  it('flags the in-flight control instead of moving the phase', () => {
    const { registry, entry } = buildApproved();
    const control = registry.beginRun('s1');

    const state = registry.pauseRun('s1');

    expect(control.paused).toBe(true);
    // The phase only moves once the executor settles the run.
    expect(state?.phase).toBe('executing');
    expect(entry.orchestrator.getPhase()).toBe('executing');
  });

  it('moves the phase directly when no run is in flight', () => {
    const { registry } = buildApproved();
    expect(registry.pauseRun('s1')?.phase).toBe('paused');
    expect(registry.cancelRun('s1')?.phase).toBe('cancelled');
  });

  it('forgets a run once it is closed', () => {
    const { registry } = buildApproved();
    const control = registry.beginRun('s1');
    registry.endRun('s1');
    expect(registry.pauseRun('s1')?.phase).toBe('paused');
    expect(control.paused).toBe(false);
  });

  it('reports null for an unknown session', () => {
    const registry = new WorkflowRegistry({ resolveWorkspaceRoot: () => '/ws' });
    expect(registry.pauseRun('missing')).toBeNull();
    expect(registry.cancelRun('missing')).toBeNull();
  });
});

describe('run control plumbing', () => {
  const preload = read('src/preload/index.ts');
  const handlers = read('src/main/ipc/workflow-handlers.ts');
  const banner = read('src/renderer/components/WorkflowStatusBanner.tsx');

  it('declares both control channels in the preload bridge', () => {
    expect(preload).toContain("'workflow.pause'");
    expect(preload).toContain("'workflow.cancel'");
    expect(preload).toContain('pause: (sessionId: string)');
    expect(preload).toContain('cancel: (sessionId: string)');
  });

  it('registers both control channels and drives runs under a control', () => {
    expect(handlers).toContain("ipcMain.handle('workflow.pause'");
    expect(handlers).toContain("ipcMain.handle('workflow.cancel'");
    expect(handlers).toContain('runWithControl(sessionId');
    expect(handlers).toContain('registry.beginRun?.(sessionId)');
    expect(handlers).toContain('registry.endRun?.(sessionId)');
  });

  it('exposes pause, resume and cancel from the status banner', () => {
    expect(banner).toContain('.pause(sessionId)');
    expect(banner).toContain('.cancel(sessionId)');
    expect(banner).toContain('api.executePlan(sessionId)');
    expect(banner).toContain("t('workflowBanner.pause')");
    expect(banner).toContain("t('workflowBanner.resume')");
    expect(banner).toContain("t('workflowBanner.cancel')");
  });

  it('ships the control strings in every locale', () => {
    for (const locale of ['en', 'fr', 'zh']) {
      const json = JSON.parse(read('src/renderer/i18n/locales/' + locale + '.json')) as {
        workflowBanner?: Record<string, string>;
        planPanel?: {
          phase?: Record<string, string>;
          report?: { taskStatus?: Record<string, string> };
        };
      };
      expect(json.workflowBanner?.pause, locale).toBeDefined();
      expect(json.workflowBanner?.resume, locale).toBeDefined();
      expect(json.workflowBanner?.cancel, locale).toBeDefined();
      expect(json.planPanel?.phase?.paused, locale).toBeDefined();
      expect(json.planPanel?.report?.taskStatus?.cancelled, locale).toBeDefined();
    }
  });
});
