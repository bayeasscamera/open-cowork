import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, fn),
  },
}));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { registerWorkflowIpcHandlers, type WorkflowRegistryLike } from '../src/main/ipc/workflow-handlers';
import { AuditLog } from '../src/main/agent/audit-log';
import { CheckpointManager, type FileSnapshotBackend } from '../src/main/agent/checkpoint-manager';
import { createDefaultPermissionPolicy } from '../src/main/agent/permission-policy';
import { WorkflowOrchestrator } from '../src/main/agent/workflow-orchestrator';
import type { WorkflowEntry } from '../src/main/agent/workflow-registry';
import type { WorkflowState } from '../src/shared/workflow-types';

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

function buildEntry(sessionId: string): WorkflowEntry {
  const audit = new AuditLog();
  const checkpoints = new CheckpointManager({ backend: new MemoryBackend(), audit });
  const orchestrator = new WorkflowOrchestrator({
    policy: createDefaultPermissionPolicy('/ws'),
    checkpoints,
    audit,
  });
  return { sessionId, workspaceRoot: '/ws', audit, checkpoints, orchestrator };
}

const criterion = { id: 'c1', description: 'tests pass', verification: 'npm test', required: true };
const evidence = { kind: 'test' as const, description: 'tests', command: 'npm test', required: true };

const contractInput = {
  objective: 'Ship it',
  allowedFiles: ['src/a.ts'],
  acceptanceCriteria: [criterion],
  expectedEvidence: [evidence],
  budget: { maxTokens: 100 },
};

const taskInput = {
  id: 't1',
  title: 'Implement',
  writeScope: ['src/a.ts'],
  exitCriteria: [criterion],
  requiredEvidence: [evidence],
  requestedCapabilities: ['read', 'write'] as const,
};

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error('no handler for ' + channel);
  return handler({}, ...args);
};

describe('workflow-ipc-handlers', () => {
  let entry: WorkflowEntry | null;
  const registry: WorkflowRegistryLike = {
    get: () => entry,
    getOrCreate: () => entry,
  };

  beforeEach(() => {
    mocks.handlers.clear();
    entry = buildEntry('s1');
    registerWorkflowIpcHandlers({ registry });
  });

  it('registers the full workflow channel surface', () => {
    const channels = Array.from(mocks.handlers.keys()).sort();
    expect(channels).toContain('workflow.getState');
    expect(channels).toContain('workflow.loadContract');
    expect(channels).toContain('workflow.approve');
    expect(channels).toContain('workflow.startTask');
    expect(channels).toContain('workflow.exportAuditLog');
    expect(channels).toContain('workflow.acceptTask');
    expect(channels).toContain('workflow.restoreTask');
    expect(channels).toHaveLength(16);
  });

  it('returns null state when no workspace is available', async () => {
    entry = null;
    await expect(invoke('workflow.getState', 's1')).resolves.toBeNull();
    await expect(invoke('workflow.setMode', 's1', 'plan')).rejects.toThrow(
      'No workspace is available'
    );
  });

  it('runs the whole workflow through IPC', async () => {
    const loaded = (await invoke('workflow.loadContract', 's1', contractInput, [taskInput])) as WorkflowState;
    expect(loaded.phase).toBe('planning');
    expect(loaded.tasks).toHaveLength(1);

    const request = (await invoke('workflow.requestApproval', 's1')) as { blockers: string[] };
    expect(request.blockers).toEqual([]);

    const outcome = (await invoke('workflow.approve', 's1', { approved: true })) as {
      approved: boolean;
    };
    expect(outcome.approved).toBe(true);

    const started = (await invoke('workflow.startExecution', 's1')) as { started: boolean };
    expect(started.started).toBe(true);

    const checkpoint = (await invoke('workflow.startTask', 's1', 't1')) as { taskId: string };
    expect(checkpoint.taskId).toBe('t1');

    await invoke('workflow.completeTask', 's1', 't1', [
      { kind: 'test', description: 'npm test', exitCode: 0, output: 'ok' },
    ]);

    const verified = (await invoke('workflow.verify', 's1')) as { ok: boolean };
    expect(verified.ok).toBe(true);
  });

  it('rejects an invalid workflow mode', async () => {
    await expect(invoke('workflow.setMode', 's1', 'teleport')).rejects.toThrow(
      'Unknown workflow mode'
    );
  });

  it('coerces a malformed evidence payload to an empty list', async () => {
    await invoke('workflow.loadContract', 's1', contractInput, [taskInput]);
    await invoke('workflow.requestApproval', 's1');
    await invoke('workflow.approve', 's1', { approved: true });
    await invoke('workflow.startExecution', 's1');
    await invoke('workflow.startTask', 's1', 't1');

    const state = (await invoke('workflow.completeTask', 's1', 't1', 'nope')) as WorkflowState;
    expect(state.completedTaskIds).toEqual(['t1']);
  });

  it('plans adaptive roles from the loaded contract', async () => {
    await invoke('workflow.loadContract', 's1', contractInput, [taskInput]);
    const assignments = (await invoke('workflow.planRoles', 's1', {
      request: 'fix bug',
      needsWeb: true,
    })) as Array<{ role: string }>;

    expect(assignments.map((assignment) => assignment.role)).toContain('web-researcher');
  });

  it('refuses role planning before a contract is loaded', async () => {
    await expect(invoke('workflow.planRoles', 's1', { request: 'x' })).rejects.toThrow(
      'Load a contract before planning roles'
    );
  });

  it('exports the audit log as versioned JSON', async () => {
    await invoke('workflow.loadContract', 's1', contractInput, [taskInput]);
    const entries = (await invoke('workflow.getAuditLog', 's1')) as unknown[];
    expect(entries.length).toBeGreaterThan(0);

    const exported = (await invoke('workflow.exportAuditLog', 's1')) as string;
    const parsed = JSON.parse(exported) as { version: number; entries: unknown[] };
    expect(parsed.version).toBe(1);
    expect(parsed.entries.length).toBe(entries.length);
  });
});
