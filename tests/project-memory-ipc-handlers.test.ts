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

import { registerProjectMemoryIpcHandlers } from '../src/main/ipc/project-memory-handlers';
import { ProjectMemoryStore } from '../src/main/memory/project-memory-store';
import type { MemoryInjection, ProjectMemoryItem, ProjectMemoryOverview } from '../src/shared/project-memory-types';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error('no handler for ' + channel);
  return handler({}, ...args);
};

describe('project-memory-ipc-handlers', () => {
  let store: ProjectMemoryStore;
  let onChanged: ReturnType<typeof vi.fn>;

  const register = () =>
    registerProjectMemoryIpcHandlers({
      resolve: (sessionId) => (sessionId === 's1' ? { store, workspaceKey: '/ws' } : null),
      onChanged,
    });

  beforeEach(() => {
    mocks.handlers.clear();
    store = new ProjectMemoryStore({ idFactory: (() => {
      let counter = 0;
      return () => 'id-' + ++counter;
    })() });
    onChanged = vi.fn();
    register();
  });

  it('registers the full project memory channel surface', () => {
    expect(Array.from(mocks.handlers.keys()).sort()).toEqual([
      'projectMemory.clear',
      'projectMemory.list',
      'projectMemory.overview',
      'projectMemory.preview',
      'projectMemory.purgeExpired',
      'projectMemory.remove',
      'projectMemory.seedFromAudit',
      'projectMemory.upsert',
    ]);
  });

  it('refuses an unknown session', async () => {
    await expect(invoke('projectMemory.overview', 'nope')).rejects.toThrow(
      'No workspace is available for session "nope"'
    );
  });

  it('upserts, lists and summarizes memory for the resolved workspace', async () => {
    const item = (await invoke('projectMemory.upsert', 's1', {
      layer: 'rules',
      statement: '  Never use any.  ',
      provenance: { source: 'doc', reference: 'AGENTS.md' },
      tags: ['TypeScript', 42],
      confidence: 0.9,
    })) as ProjectMemoryItem;

    expect(item.statement).toBe('Never use any.');
    expect(item.workspaceKey).toBe('/ws');
    expect(item.tags).toEqual(['typescript']);
    expect(item.confidence).toBe(0.9);

    const listed = (await invoke('projectMemory.list', 's1')) as ProjectMemoryItem[];
    expect(listed.map((entry) => entry.id)).toEqual([item.id]);

    const overview = (await invoke('projectMemory.overview', 's1')) as ProjectMemoryOverview;
    expect(overview.layers.rules).toBe(1);

    expect(onChanged).toHaveBeenCalledWith('/ws');
  });

  it('rejects malformed layers, statements and provenance', async () => {
    await expect(
      invoke('projectMemory.upsert', 's1', {
        layer: 'nope',
        statement: 'x',
        provenance: { source: 'doc', reference: 'a' },
      })
    ).rejects.toThrow('Unknown memory layer');

    await expect(
      invoke('projectMemory.upsert', 's1', {
        layer: 'rules',
        statement: '   ',
        provenance: { source: 'doc', reference: 'a' },
      })
    ).rejects.toThrow('Memory statement must be a non-empty string.');

    await expect(
      invoke('projectMemory.upsert', 's1', {
        layer: 'rules',
        statement: 'ok',
        provenance: { source: 'made-up', reference: 'a' },
      })
    ).rejects.toThrow('Unknown memory source');

    await expect(
      invoke('projectMemory.upsert', 's1', {
        layer: 'rules',
        statement: 'ok',
        provenance: { source: 'doc', reference: '' },
      })
    ).rejects.toThrow('Memory provenance requires a reference.');

    await expect(invoke('projectMemory.list', 's1', 'nope')).rejects.toThrow('Unknown memory layer');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('removes, clears and purges, reporting what was dropped', async () => {
    const first = (await invoke('projectMemory.upsert', 's1', {
      layer: 'rules',
      statement: 'keep me',
      provenance: { source: 'doc', reference: 'a' },
    })) as ProjectMemoryItem;
    const volatile = (await invoke('projectMemory.upsert', 's1', {
      layer: 'task-state',
      statement: 'gone',
      provenance: { source: 'session', reference: 's1' },
      ttlMs: 0,
    })) as ProjectMemoryItem;

    expect(await invoke('projectMemory.remove', 's1', 'missing')).toEqual({ removed: false });

    const purged = (await invoke('projectMemory.purgeExpired', 's1')) as { removed: string[] };
    expect(purged.removed).toEqual([volatile.id]);

    expect(await invoke('projectMemory.remove', 's1', first.id)).toEqual({ removed: true });
    expect(await invoke('projectMemory.clear', 's1')).toEqual({ removed: 0 });
  });

  it('previews the injection that would be sent for a task', async () => {
    await invoke('projectMemory.upsert', 's1', {
      layer: 'rules',
      statement: 'Never use any in TypeScript',
      provenance: { source: 'doc', reference: 'AGENTS.md', locator: 'Code standards' },
    });

    const injection = (await invoke('projectMemory.preview', 's1', 'typescript strictness', 5)) as MemoryInjection;
    expect(injection.text).toContain('<project_memory workspace="/ws">');
    expect(injection.text).toContain('[doc:AGENTS.md#Code standards]');
    expect(injection.considered).toBe(1);
  });

  it('seeds the errors layer from forbidden or rejected audit entries only', async () => {
    const added = (await invoke('projectMemory.seedFromAudit', 's1', [
      { action: 'shell', justification: 'rm -rf /', authorization: 'forbidden', taskId: 't1' },
      { action: 'git', justification: 'push rejected', authorization: 'rejected' },
      { action: 'read', justification: 'fine', authorization: 'allowed' },
      { action: 'write', justification: '   ', authorization: 'forbidden' },
      'not-an-entry',
    ])) as { added: number };

    expect(added.added).toBe(2);
    const errors = (await invoke('projectMemory.list', 's1', 'errors')) as ProjectMemoryItem[];
    expect(errors.map((entry) => entry.statement).sort()).toEqual([
      'git: push rejected',
      'shell: rm -rf /',
    ]);
    expect(errors.find((entry) => entry.statement.startsWith('shell'))?.provenance).toEqual({
      source: 'session',
      reference: 's1',
      locator: 't1',
    });
  });

  it('tolerates a non-array seed payload', async () => {
    expect(await invoke('projectMemory.seedFromAudit', 's1', null)).toEqual({ added: 0 });
    expect(onChanged).not.toHaveBeenCalled();
  });
});
