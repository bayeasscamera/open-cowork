import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLog } from '../src/main/agent/audit-log';
import { CheckpointManager, type FileSnapshotBackend } from '../src/main/agent/checkpoint-manager';
import { createDefaultPermissionPolicy } from '../src/main/agent/permission-policy';
import {
  WorkflowExecutor,
  type WorkflowTaskContext,
} from '../src/main/agent/workflow-executor';
import { WorkflowOrchestrator } from '../src/main/agent/workflow-orchestrator';
import { WorkflowRegistry } from '../src/main/agent/workflow-registry';
import { createAtomicTask, createTaskContract } from '../src/shared/task-contract';
import type { AtomicTask } from '../src/shared/task-contract';
import type { TaskRunProgress, WorkflowState } from '../src/shared/workflow-types';
import { useAppStore } from '../src/renderer/store';

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

function workflowState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    phase: 'executing',
    mode: 'execute',
    contractId: 'contract-1',
    objective: 'Ship it',
    tasks: [],
    groups: [],
    completedTaskIds: [],
    readyTaskIds: [],
    approval: null,
    approvalOutcome: null,
    checkpoints: [],
    blockers: [],
    updatedAt: 1,
    ...overrides,
  };
}

describe('live task progress reporting', () => {
  it('reports throttled token and tool-call progress while a task runs', async () => {
    const { orchestrator } = makeApprovedOrchestrator();
    let clock = 1_000;
    const progress: TaskRunProgress[] = [];
    const runTask = vi.fn(async (context: WorkflowTaskContext) => {
      context.onToolCall(1);
      context.onTokens(20);
      clock += 500;
      context.onTokens(30);
      return { success: true, summary: 'Change applied and npm test is green.' };
    });

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
      now: () => clock,
      onTaskProgress: (entry) => progress.push(entry),
    });

    await executor.executePlan();

    // The first tool call reports immediately, the token burst inside the
    // throttle window is dropped, and the next one after the window reports.
    expect(progress).toHaveLength(2);
    expect(progress[0].taskId).toBe('t1');
    expect(progress[0].toolCalls).toBe(1);
    expect(progress[0].tokens).toBe(0);
    expect(progress[0].maxTokens).toBe(100);
    expect(progress[1].tokens).toBe(50);
    expect(progress[1].updatedAt).toBe(1_500);
  });

  it('reports the finished task through onTaskResult', async () => {
    const { orchestrator } = makeApprovedOrchestrator();
    const results: string[] = [];
    const runTask = vi.fn(async (context: WorkflowTaskContext) => {
      context.onTokens(42);
      return { success: true, summary: 'Change applied and npm test is green.' };
    });

    const executor = new WorkflowExecutor({
      orchestrator,
      runTask,
      policy: createDefaultPermissionPolicy('/ws'),
      workspaceRoot: '/ws',
      runProof: okProof,
      onTaskResult: (result) => results.push(result.status + ':' + String(result.tokens)),
    });

    await executor.executePlan();

    expect(results).toEqual(['succeeded:42']);
  });
});

describe('registry task hook composition', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-live-metrics-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('fires both the caller override and the registry-level hooks', async () => {
    const seen: string[] = [];
    const overridden: string[] = [];
    const registry = new WorkflowRegistry({
      resolveWorkspaceRoot: () => dir,
      onTaskResult: (_sessionId, result) => seen.push('registry-result:' + result.taskId),
      onTaskProgress: (_sessionId, progress) => seen.push('registry-progress:' + progress.taskId),
    });
    const entry = registry.getOrCreate('s1');
    expect(entry).not.toBeNull();
    entry?.orchestrator.loadContract(makeContract(), [makeTask()]);
    entry?.orchestrator.requestApproval();
    entry?.orchestrator.approve({ approved: true });

    const executor = registry.executorFor(
      's1',
      async (context: WorkflowTaskContext) => {
        context.onToolCall(1);
        return { success: true, summary: 'Change applied and npm test is green.' };
      },
      {
        runProof: okProof,
        onTaskResult: (result) => overridden.push(result.taskId),
      }
    );
    expect(executor).not.toBeNull();

    await executor?.executePlan();

    expect(overridden).toEqual(['t1']);
    expect(seen).toContain('registry-result:t1');
    expect(seen).toContain('registry-progress:t1');
  });
});

describe('live metrics store slices', () => {
  beforeEach(() => {
    useAppStore.setState({
      workflowStates: {},
      workflowTaskResults: {},
      workflowTaskProgress: {},
    });
  });

  it('keys finished results by task so a retry replaces the previous run', () => {
    const store = useAppStore.getState();
    const base = {
      role: 'implementer' as const,
      status: 'succeeded' as const,
      startedAt: 0,
      finishedAt: 1,
      durationMs: 1,
      attempts: 1,
      toolCalls: 1,
      summary: 'ok',
      isolated: false,
      evidenceKinds: ['test' as const],
    };
    store.setWorkflowTaskResult('s1', { ...base, taskId: 't1', tokens: 10, costUsd: 0.01 });
    store.setWorkflowTaskResult('s1', { ...base, taskId: 't1', tokens: 25, costUsd: 0.02 });

    const results = useAppStore.getState().workflowTaskResults.s1;
    expect(Object.keys(results)).toEqual(['t1']);
    expect(results.t1.tokens).toBe(25);
  });

  it('drops task progress when the plan changes', () => {
    const store = useAppStore.getState();
    store.setWorkflowState('s1', workflowState({ contractId: 'plan-a' }));
    store.setWorkflowTaskProgress('s1', {
      taskId: 't1',
      tokens: 5,
      toolCalls: 1,
      costUsd: 0,
      updatedAt: 1,
    });
    store.setWorkflowState('s1', workflowState({ contractId: 'plan-b' }));

    expect(useAppStore.getState().workflowTaskProgress.s1).toEqual({});
  });

  it('keeps task progress while the same plan keeps running', () => {
    const store = useAppStore.getState();
    store.setWorkflowState('s1', workflowState({ contractId: 'plan-a' }));
    store.setWorkflowTaskProgress('s1', {
      taskId: 't1',
      tokens: 5,
      toolCalls: 1,
      costUsd: 0,
      updatedAt: 1,
    });
    store.setWorkflowState('s1', workflowState({ contractId: 'plan-a', phase: 'verifying' }));

    expect(useAppStore.getState().workflowTaskProgress.s1.t1.tokens).toBe(5);
  });
});

describe('live metrics plumbing', () => {
  const serverTypes = read('src/shared/types.ts');
  const mainIndex = read('src/main/index.ts');
  const ipc = read('src/renderer/hooks/useIPC.ts');
  const banner = read('src/renderer/components/WorkflowStatusBanner.tsx');
  const storeSource = read('src/renderer/store/index.ts');

  it('declares both workflow metric events', () => {
    expect(serverTypes).toContain("type: 'workflow.taskResult'");
    expect(serverTypes).toContain("type: 'workflow.taskProgress'");
    expect(serverTypes).toContain('payload: { sessionId: string; result: TaskRunResult }');
    expect(serverTypes).toContain('payload: { sessionId: string; progress: TaskRunProgress }');
  });

  it('broadcasts task results and progress from the main process', () => {
    expect(mainIndex).toContain(
      "sendToRenderer({ type: 'workflow.taskResult', payload: { sessionId, result } })"
    );
    expect(mainIndex).toContain(
      "sendToRenderer({ type: 'workflow.taskProgress', payload: { sessionId, progress } })"
    );
  });

  it('routes both events into the store', () => {
    expect(ipc).toContain("case 'workflow.taskResult':");
    expect(ipc).toContain('store.setWorkflowTaskResult(event.payload.sessionId, event.payload.result)');
    expect(ipc).toContain("case 'workflow.taskProgress':");
    expect(ipc).toContain(
      'store.setWorkflowTaskProgress(event.payload.sessionId, event.payload.progress)'
    );
  });

  it('declares the metric slices in the store', () => {
    expect(storeSource).toContain(
      'workflowTaskResults: Record<string, Record<string, TaskRunResult>>;'
    );
    expect(storeSource).toContain(
      'workflowTaskProgress: Record<string, Record<string, TaskRunProgress>>;'
    );
  });

  it('sums finished results and in-flight progress in the banner', () => {
    expect(banner).toContain('tokens += result.tokens ?? 0;');
    expect(banner).toContain('if (results && results[entry.taskId]) {');
    expect(banner).toContain("t('workflowBanner.tokens', { tokens: formatTokens(totalTokens) })");
    expect(banner).toContain("'$' + totalCostUsd.toFixed(4)");
  });

  it('ships the token string in every locale', () => {
    for (const locale of ['en', 'fr', 'zh']) {
      const json = JSON.parse(read('src/renderer/i18n/locales/' + locale + '.json')) as {
        workflowBanner?: Record<string, string>;
      };
      expect(json.workflowBanner?.tokens, locale).toBe('{{tokens}} tokens');
    }
  });
});
