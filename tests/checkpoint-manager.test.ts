import { describe, it, expect } from 'vitest';
import {
  CheckpointManager,
  formatFileDiff,
  type FileSnapshotBackend,
  type GitRunner,
} from '../src/main/agent/checkpoint-manager';
import { AuditLog } from '../src/main/agent/audit-log';

class MemoryBackend implements FileSnapshotBackend {
  public files = new Map<string, string>();

  async capture(paths: string[]): Promise<Map<string, string | null>> {
    const snapshot = new Map<string, string | null>();
    for (const file of paths) {
      snapshot.set(file, this.files.get(file) ?? null);
    }
    return snapshot;
  }

  async restore(snapshot: Map<string, string | null>): Promise<void> {
    for (const [file, content] of snapshot) {
      if (content === null) {
        this.files.delete(file);
      } else {
        this.files.set(file, content);
      }
    }
  }

  async read(file: string): Promise<string | null> {
    return this.files.get(file) ?? null;
  }
}

function makeManager(git?: GitRunner) {
  const backend = new MemoryBackend();
  const audit = new AuditLog();
  let tick = 0;
  const manager = new CheckpointManager({
    backend,
    git,
    audit,
    now: () => 1000 + tick++,
  });
  return { backend, audit, manager };
}

const task = (id: string, writeScope: string[]) => ({ id, title: 'Task ' + id, writeScope });

describe('checkpoint-manager', () => {
  it('captures a snapshot and reports the per-task diff', async () => {
    const { backend, manager } = makeManager();
    backend.files.set('src/a.ts', 'line1\nline2\n');

    const checkpoint = await manager.createCheckpoint(task('t1', ['src/a.ts']));
    backend.files.set('src/a.ts', 'line1\nline2 changed\nline3\n');

    const refreshed = await manager.refreshDiff(checkpoint.id);
    expect(refreshed.diff).toContain('--- a/src/a.ts');
    expect(refreshed.diff).toContain('-line2');
    expect(refreshed.diff).toContain('+line2 changed');
    expect(refreshed.additions).toBe(2);
    expect(refreshed.deletions).toBe(1);
  });

  it('accepts a task and keeps the changes', async () => {
    const { backend, manager } = makeManager();
    backend.files.set('src/a.ts', 'old');
    await manager.createCheckpoint(task('t1', ['src/a.ts']));
    backend.files.set('src/a.ts', 'new');

    const accepted = await manager.acceptTask('t1');
    expect(accepted.status).toBe('accepted');
    expect(backend.files.get('src/a.ts')).toBe('new');
  });

  it('rejects a task and restores the snapshot', async () => {
    const { backend, manager } = makeManager();
    backend.files.set('src/a.ts', 'old');
    await manager.createCheckpoint(task('t1', ['src/a.ts']));
    backend.files.set('src/a.ts', 'new');

    const rejected = await manager.rejectTask('t1', 'not good');
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('not good');
    expect(backend.files.get('src/a.ts')).toBe('old');
  });

  it('deletes files that did not exist before the task', async () => {
    const { backend, manager } = makeManager();
    await manager.createCheckpoint(task('t1', ['src/new.ts']));
    backend.files.set('src/new.ts', 'created');

    await manager.rejectTask('t1');
    expect(backend.files.has('src/new.ts')).toBe(false);
  });

  it('restores a single accepted task', async () => {
    const { backend, manager } = makeManager();
    backend.files.set('src/a.ts', 'old');
    await manager.createCheckpoint(task('t1', ['src/a.ts']));
    backend.files.set('src/a.ts', 'new');
    await manager.acceptTask('t1');

    const restored = await manager.restoreTask('t1');
    expect(restored.status).toBe('restored');
    expect(backend.files.get('src/a.ts')).toBe('old');
  });

  it('restores the whole plan', async () => {
    const { backend, manager } = makeManager();
    backend.files.set('src/a.ts', 'a0');
    backend.files.set('src/b.ts', 'b0');
    await manager.createCheckpoint(task('t1', ['src/a.ts']));
    await manager.createCheckpoint(task('t2', ['src/b.ts']));
    backend.files.set('src/a.ts', 'a1');
    backend.files.set('src/b.ts', 'b1');

    const result = await manager.restorePlan();
    expect(result.restored).toEqual(['t2', 't1']);
    expect(backend.files.get('src/a.ts')).toBe('a0');
    expect(backend.files.get('src/b.ts')).toBe('b0');
    expect(manager.list().every((checkpoint) => checkpoint.status === 'restored')).toBe(true);
  });

  it('records a git base revision when available', async () => {
    const git: GitRunner = {
      run: async () => ({ exitCode: 0, stdout: 'deadbeef\n', stderr: '' }),
    };
    const { manager } = makeManager(git);
    const checkpoint = await manager.createCheckpoint(task('t1', []));
    expect(checkpoint.baseRevision).toBe('deadbeef');
  });

  it('tolerates a failing git runner', async () => {
    const git: GitRunner = {
      run: async () => ({ exitCode: 128, stdout: '', stderr: 'not a repo' }),
    };
    const { manager } = makeManager(git);
    const checkpoint = await manager.createCheckpoint(task('t1', []));
    expect(checkpoint.baseRevision).toBeNull();
  });

  it('attaches evidence and classifies command results', async () => {
    const { manager } = makeManager();
    const checkpoint = await manager.createCheckpoint(task('t1', []));

    const test = manager.attachCommandEvidence(checkpoint.id, 'npm test', 0, 'all green');
    const failure = manager.attachCommandEvidence(checkpoint.id, 'npm run lint', 1, 'boom');

    expect(test.kind).toBe('test');
    expect(test.exitCode).toBe(0);
    expect(failure.kind).toBe('command');
    expect(manager.get(checkpoint.id)?.evidence).toHaveLength(2);
  });

  it('formats a file diff and returns empty for identical content', () => {
    expect(formatFileDiff('a.ts', 'same', 'same')).toBe('');
    const diff = formatFileDiff('a.ts', 'old', 'new');
    expect(diff).toContain('--- a/a.ts');
    expect(diff).toContain('+new');
  });

  it('throws for an unknown task', async () => {
    const { manager } = makeManager();
    await expect(manager.acceptTask('ghost')).rejects.toThrow('No checkpoint for task: ghost');
  });
});
