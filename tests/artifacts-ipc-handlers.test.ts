import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
}));

vi.mock('../src/main/utils/logger', () => ({
  logError: vi.fn(),
}));

vi.mock('../src/main/utils/recent-workspace-files', () => ({
  listRecentWorkspaceFiles: vi.fn(),
}));

import { registerArtifactsIpcHandlers } from '../src/main/ipc/artifacts-handlers';
import { listRecentWorkspaceFiles } from '../src/main/utils/recent-workspace-files';

type Handler = (...args: unknown[]) => unknown;

function registeredHandler(channel: string): Handler {
  const call = mocks.handle.mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`handler not registered: ${channel}`);
  return call[1] as Handler;
}

const OVER_5MB = 5 * 1024 * 1024 + 1;

describe('artifacts IPC handlers', () => {
  let workspace: string;
  let outside: string;
  let workingDir: string | null;

  beforeEach(() => {
    mocks.handle.mockReset();
    vi.mocked(listRecentWorkspaceFiles).mockReset();
    workspace = mkdtempSync(join(tmpdir(), 'cowork-artifacts-'));
    outside = mkdtempSync(join(tmpdir(), 'cowork-outside-'));
    workingDir = workspace;
    registerArtifactsIpcHandlers({ getWorkingDir: () => workingDir });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('registers both artifact channels', () => {
    expect(mocks.handle.mock.calls.map(([name]) => name)).toEqual([
      'artifacts.listRecentFiles',
      'artifacts.readFile',
    ]);
  });

  describe('artifacts.listRecentFiles', () => {
    it('returns an empty list for relative cwd without touching the util', async () => {
      const handler = registeredHandler('artifacts.listRecentFiles');
      await expect(
        (handler as (event: unknown, cwd: string, sinceMs: number, limit: number) => unknown)(
          undefined,
          'relative/path',
          1000,
          50
        )
      ).resolves.toEqual([]);
      expect(listRecentWorkspaceFiles).not.toHaveBeenCalled();
    });

    it('delegates absolute cwd to the recent-files util with its arguments', async () => {
      vi.mocked(listRecentWorkspaceFiles).mockReturnValue([{ path: 'a.ts', mtime: 1 }]);
      const handler = registeredHandler('artifacts.listRecentFiles');
      const result = await (
        handler as (event: unknown, cwd: string, sinceMs: number, limit: number) => unknown
      )(undefined, workspace, 5000, 20);
      expect(listRecentWorkspaceFiles).toHaveBeenCalledWith(workspace, 5000, 20);
      expect(result).toEqual([{ path: 'a.ts', mtime: 1 }]);
    });
  });

  describe('artifacts.readFile', () => {
    it('reads files inside the active workspace', async () => {
      const path = join(workspace, 'note.md');
      writeFileSync(path, 'hello artifacts');
      const handler = registeredHandler('artifacts.readFile');
      await expect(
        (handler as (event: unknown, filePath: string) => unknown)(undefined, path)
      ).resolves.toBe('hello artifacts');
    });

    it('rejects paths outside the active workspace', async () => {
      const path = join(outside, 'secret.md');
      writeFileSync(path, 'outside');
      const handler = registeredHandler('artifacts.readFile');
      await expect(
        (handler as (event: unknown, filePath: string) => unknown)(undefined, path)
      ).rejects.toThrow('Access denied: path is outside the workspace');
    });

    it('rejects in-workspace symlinks that point outside the workspace', async () => {
      const target = join(outside, 'escape.md');
      writeFileSync(target, 'outside');
      const link = join(workspace, 'innocent.md');
      symlinkSync(target, link);
      const handler = registeredHandler('artifacts.readFile');
      await expect(
        (handler as (event: unknown, filePath: string) => unknown)(undefined, link)
      ).rejects.toThrow('Access denied: path is outside the workspace');
    });

    it('rejects missing files', async () => {
      const handler = registeredHandler('artifacts.readFile');
      await expect(
        (handler as (event: unknown, filePath: string) => unknown)(
          undefined,
          join(workspace, 'missing.md')
        )
      ).rejects.toThrow('File not found');
    });

    it('truncates files larger than 5MB before returning them', async () => {
      const path = join(workspace, 'big.log');
      writeFileSync(path, Buffer.alloc(OVER_5MB, 97));
      const handler = registeredHandler('artifacts.readFile');
      const result = (await (
        handler as (event: unknown, filePath: string) => Promise<unknown>
      )(undefined, path)) as string;
      expect(result.endsWith('\n\n[Content truncated: file exceeds 5MB]')).toBe(true);
      expect(result.length).toBe(100000 + '\n\n[Content truncated: file exceeds 5MB]'.length);
    });

    it('reads any path when no workspace is active', async () => {
      // Preserved behavior: without an active workspace there is nothing to
      // confine reads to, so the handler does not enforce containment.
      workingDir = null;
      const path = join(outside, 'free.md');
      writeFileSync(path, 'unconfined');
      const handler = registeredHandler('artifacts.readFile');
      await expect(
        (handler as (event: unknown, filePath: string) => unknown)(undefined, path)
      ).resolves.toBe('unconfined');
    });
  });
});