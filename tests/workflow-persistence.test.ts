import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLog } from '../src/main/agent/audit-log';
import { CheckpointManager, type FileSnapshotBackend } from '../src/main/agent/checkpoint-manager';
import { createDefaultPermissionPolicy } from '../src/main/agent/permission-policy';
import { TaskQueue } from '../src/main/agent/task-queue';
import { WorkflowOrchestrator } from '../src/main/agent/workflow-orchestrator';
import { WorkflowRegistry } from '../src/main/agent/workflow-registry';
import {
  WORKFLOW_SNAPSHOT_VERSION,
  WorkflowPersistence,
  safeFileName,
} from '../src/main/agent/workflow-persistence';
import { MetricsHistory } from '../src/main/agent/metrics-harness';
import { createAtomicTask, createTaskContract } from '../src/shared/task-contract';
import type { AtomicTask } from '../src/shared/task-contract';
import type { DetachedTask } from '../src/shared/control-center-types';

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

function makeTask(id = 't1'): AtomicTask {
  return createAtomicTask({
    id,
    title: 'Implement ' + id,
    writeScope: ['src/a.ts'],
    exitCriteria: [criterion],
    requiredEvidence: [evidence],
    budget: { maxTokens: 100 },
    requestedCapabilities: ['read', 'write'],
  });
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-persistence-'));
});

afterEach(async () => {
  // Slate timers may still write into the directory after the test returns.
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

function buildApprovedRegistry(persistence: WorkflowPersistence) {
  const registry = new WorkflowRegistry({
    resolveWorkspaceRoot: () => '/ws',
    persistence,
    persistDebounceMs: 1,
  });
  const entry = registry.getOrCreate('session-1');
  if (!entry) {
    throw new Error('registry did not create an entry');
  }
  entry.orchestrator.loadContract(
    createTaskContract({
      objective: 'Ship it',
      allowedFiles: ['src/a.ts'],
      acceptanceCriteria: [criterion],
      expectedEvidence: [evidence],
      budget: { maxTokens: 100 },
    }),
    [makeTask()]
  );
  entry.orchestrator.requestApproval();
  entry.orchestrator.approve({ approved: true });
  return { registry, entry };
}

describe('WorkflowPersistence', () => {
  it('writes and reads a session snapshot', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir, now: () => 42 });
    await persistence.saveSession({
      version: WORKFLOW_SNAPSHOT_VERSION,
      sessionId: 'session-1',
      workspaceRoot: '/ws',
      savedAt: 0,
      workflow: {
        phase: 'planning',
        mode: 'execute',
        contractId: 'contract-1',
        objective: 'Ship it',
        tasks: [makeTask()],
        completedTaskIds: [],
        blockers: [],
      },
      checkpoints: { sequence: 0, entries: [], dropped: 0 },
      memory: [],
    });

    const loaded = persistence.loadSession('session-1');
    expect(loaded?.workspaceRoot).toBe('/ws');
    expect(loaded?.savedAt).toBe(42);
    expect(loaded?.workflow.objective).toBe('Ship it');
  });

  it('keeps the previous snapshot intact when a write fails', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir, now: () => 42 });
    const snapshot = {
      version: WORKFLOW_SNAPSHOT_VERSION,
      sessionId: 'session-atomic',
      workspaceRoot: '/ws',
      savedAt: 0,
      workflow: {
        phase: 'planning' as const,
        mode: 'execute' as const,
        contractId: 'contract-1',
        objective: 'Ship it',
        tasks: [makeTask()],
        completedTaskIds: [],
        blockers: [],
      },
      checkpoints: { sequence: 0, entries: [], dropped: 0 },
      memory: [],
    };
    await persistence.saveSession(snapshot);
    const target = persistence.sessionPath('session-atomic');
    const before = await fs.readFile(target, 'utf8');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await persistence.saveSession({ ...snapshot, memory: [circular] as never });

    // The failed write must not truncate the previous good snapshot...
    expect(await fs.readFile(target, 'utf8')).toBe(before);
    expect(persistence.loadSession('session-atomic')?.workflow.objective).toBe('Ship it');
    // ...and must not leave its temp file behind.
    const entries = await fs.readdir(path.dirname(target));
    expect(entries.filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('ignores a corrupt or version-mismatched file instead of throwing', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir });
    await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
    await fs.writeFile(persistence.sessionPath('broken'), '{ not json', 'utf8');
    expect(persistence.loadSession('broken')).toBeNull();

    await fs.writeFile(
      persistence.sessionPath('old'),
      JSON.stringify({ version: 0, sessionId: 'old', workspaceRoot: '/ws' }),
      'utf8'
    );
    expect(persistence.loadSession('old')).toBeNull();
  });

  it('round-trips the detached-task queue', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir });
    const task: DetachedTask = {
      id: 'task-1',
      title: 'Refactor',
      prompt: 'Refactor the parser',
      status: 'queued',
      createdAt: 1,
      updatedAt: 2,
    };
    await persistence.saveQueue([task]);
    expect(persistence.loadQueue()).toEqual([task]);
  });

  it('sanitises the session id used as a file name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFileName('')).toBe('session');
    expect(safeFileName('a'.repeat(300)).length).toBe(120);
  });

  it('keeps the metrics history and the routing snapshot apart', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir });
    await persistence.saveMetrics([{ version: 'v1' }]);
    await persistence.saveRouting({ state: { enabled: true }, benchmarks: [] });

    expect(persistence.loadMetrics()).toEqual([{ version: 'v1' }]);
    expect(persistence.loadRouting()).toEqual({
      state: { enabled: true },
      benchmarks: [],
    });
  });
});

describe('WorkflowRegistry persistence', () => {
  it('restores a plan, its checkpoints and its memory after a restart', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir });

    // --- first run -------------------------------------------------------
    const first = buildApprovedRegistry(persistence);
    await first.entry.orchestrator.startExecution();
    await first.entry.orchestrator.startTask('t1');
    await first.entry.orchestrator.completeTask('t1', [
      { kind: 'test', description: 'npm test', command: 'npm test', exitCode: 0, output: 'ok' },
    ]);
    const workspaceKey = first.registry.workspaceKey('session-1') ?? '';
    expect(workspaceKey.length).toBeGreaterThan(0);
    first.entry.memory.upsert({
      workspaceKey,
      layer: 'decisions',
      statement: 'The parser lives in src/main/agent/parser.ts.',
      provenance: { source: 'session', reference: 'session-1' },
    });
    expect(first.entry.memory.size()).toBe(1);
    await first.registry.persist('session-1');

    // --- restart ---------------------------------------------------------
    const snapshotFile = persistence.sessionPath('session-1');
    const onDisk = JSON.parse(await fs.readFile(snapshotFile, 'utf8')) as {
      workflow?: { contract?: { objective?: string } | null };
      memory?: unknown[];
    };
    expect(onDisk.workflow?.contract?.objective).toBe('Ship it');
    expect(onDisk.memory).toHaveLength(1);

    const restoreDetails: Array<{ restored: boolean; memories: number; tasks: number }> = [];
    const second = new WorkflowRegistry({
      resolveWorkspaceRoot: () => '/ws',
      persistence,
      // No pending debounce may overwrite the file between the two phases.
      persistDebounceMs: 100_000,
      onRestore: (_sessionId, detail) => restoreDetails.push(detail),
    });
    const entry = second.getOrCreate('session-1');
    expect(entry).not.toBeNull();
    // A snapshot with a memory entry is loaded, and that entry is restored.
    expect(restoreDetails.at(-1)?.restored).toBe(true);
    expect(restoreDetails.at(-1)?.tasks).toBe(1);

    const state = entry?.orchestrator.getState();
    expect(state?.objective).toBe('Ship it');
    expect(state?.completedTaskIds).toEqual(['t1']);
    expect(state?.phase).toBe('planning');
    expect(state?.blockers.join(' ')).toContain('interrupted by a restart');

    const checkpoint = entry?.checkpoints.forTask('t1');
    expect(checkpoint?.evidence.map((item) => item.command)).toContain('npm test');
    expect(entry?.memory.size()).toBe(1);
    expect(entry?.memory.serialize().map((item) => item.statement)).toEqual([
      'The parser lives in src/main/agent/parser.ts.',
    ]);
    expect(entry?.memory.serialize()[0].workspaceKey).toBe(workspaceKey);
    expect(entry?.workspaceRoot).toBe('/ws');
  });

  it('never restores a plan against a different workspace', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir });
    const first = buildApprovedRegistry(persistence);
    await first.entry.orchestrator.startExecution();
    await first.registry.persist('session-1');

    const moved = new WorkflowRegistry({
      resolveWorkspaceRoot: () => '/somewhere-else',
      persistence,
    });
    const entry = moved.getOrCreate('session-1');
    expect(entry?.orchestrator.getState().phase).not.toBe('executing');
    expect(entry?.orchestrator.getState().tasks).toEqual([]);
  });

  it('persists the queue through the provider on persistAll', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir });
    const queue = new TaskQueue();
    const enqueued = queue.enqueue({
      sessionId: 'session-1',
      kind: 'custom',
      label: 'Queued refactor',
      resumeToken: 'resume-1',
    });
    const registry = new WorkflowRegistry({
      resolveWorkspaceRoot: () => '/ws',
      persistence,
      queueProvider: () => queue,
    });
    registry.getOrCreate('session-1');

    await registry.persistAll();
    const reloaded = new WorkflowPersistence({ baseDir: dir }).loadQueue();
    expect(reloaded.map((task) => task.id)).toEqual([enqueued.id]);
    expect(reloaded[0].label).toBe('Queued refactor');
    expect(reloaded[0].status).toBe('queued');
  });

  it('tolerates a snapshot written by an older release', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir });
    const first = buildApprovedRegistry(persistence);
    await first.entry.orchestrator.startExecution();
    await first.registry.persist('session-1');

    // Simulate a snapshot whose memory entries carry an unknown layer.
    const file = persistence.sessionPath('session-1');
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { memory: unknown[] };
    raw.memory = [{ id: 'x', workspaceKey: '/ws', statement: 's', layer: 'future-layer' }];
    await fs.writeFile(file, JSON.stringify(raw), 'utf8');

    const second = new WorkflowRegistry({ resolveWorkspaceRoot: () => '/ws', persistence });
    const entry = second.getOrCreate('session-1');
    expect(entry?.memory.size()).toBe(0);
    // The plan itself is still restored.
    expect(entry?.orchestrator.getState().tasks).toHaveLength(1);
  });

  it('removes the persisted file when a session is dropped', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir });
    const { registry } = buildApprovedRegistry(persistence);
    await registry.persist('session-1');
    expect(await fs.access(persistence.sessionPath('session-1')).then(() => true)).toBe(true);

    registry.remove('session-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await fs
        .access(persistence.sessionPath('session-1'))
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });
});

describe('MetricsHistory persistence', () => {
  it('survives a restart and still compares two versions', async () => {
    const persistence = new WorkflowPersistence({ baseDir: dir });
    const history = new MetricsHistory();
    history.record({
      version: '1.0.0',
      startedAt: 0,
      finishedAt: 10,
      records: [],
      summary: {
        runs: 1,
        successRate: 0.5,
        avgTurns: 10,
        avgCostUsd: 1,
        avgDurationMs: 1000,
        regressionRate: 0,
        humanInterventionRate: 0,
        avgEvidence: 1,
      },
    });
    history.record({
      version: '1.1.0',
      startedAt: 0,
      finishedAt: 10,
      records: [],
      summary: {
        runs: 1,
        successRate: 0.9,
        avgTurns: 8,
        avgCostUsd: 0.7,
        avgDurationMs: 800,
        regressionRate: 0,
        humanInterventionRate: 0,
        avgEvidence: 2,
      },
    });
    await persistence.saveMetrics(history.serialize());

    const restored = new MetricsHistory();
    expect(restored.restore(persistence.loadMetrics())).toBe(2);
    expect(restored.versions()).toEqual(['1.0.0', '1.1.0']);
    expect(restored.compareLatest()?.successRate).toBeCloseTo(0.4);
    expect(restored.compareLatest()?.noRegression).toBe(true);
  });
});

describe('WorkflowOrchestrator.serialize/restore', () => {
  it('round-trips a planning state verbatim', () => {
    const audit = new AuditLog();
    const checkpoints = new CheckpointManager({ backend: new MemoryBackend(), audit });
    const orchestrator = new WorkflowOrchestrator({
      policy: createDefaultPermissionPolicy('/ws'),
      checkpoints,
      audit,
    });
    orchestrator.loadContract(
      createTaskContract({
        objective: 'Ship it',
        allowedFiles: ['src/a.ts'],
        acceptanceCriteria: [criterion],
        expectedEvidence: [evidence],
        budget: { maxTokens: 100 },
      }),
      [makeTask()]
    );

    const snapshot = orchestrator.serialize();
    const clone = new WorkflowOrchestrator({
      policy: createDefaultPermissionPolicy('/ws'),
      checkpoints: new CheckpointManager({ backend: new MemoryBackend(), audit }),
      audit,
    });
    expect(clone.restore(snapshot)).toBe(true);
    expect(clone.getState().objective).toBe('Ship it');
    expect(clone.getState().tasks.map((task) => task.id)).toEqual(['t1']);
  });
});
