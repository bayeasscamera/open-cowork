/**
 * The machine-access runtime: one shared service, and native-mode only.
 *
 * The properties that matter are about IDENTITY: the IPC handlers and the tool
 * gate must reach the SAME instance (otherwise a grant revoked in Settings
 * would still be honoured by a tool call), and an isolated execution mode must
 * yield null rather than a working service.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const trashed: string[] = [];

vi.mock('electron', () => ({
  app: { getPath: () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-rt-'))) },
  shell: {
    trashItem: async (p: string) => {
      trashed.push(p);
      fs.renameSync(p, `${p}.trashed`);
    },
  },
}));

const dbStub = {
  prepare: () => ({ all: () => [], run: () => undefined }),
  exec: () => undefined,
};

vi.mock('../src/main/db/database', () => ({
  getDatabase: () => ({ raw: { prepare: () => ({ all: () => [], run: () => undefined }), exec: () => undefined } }),
}));

import { toolRegistry } from '../src/main/tools/registry';
import { invokeTool } from '../src/main/tools/invoke';
import {
  getMachineAccessService,
  peekMachineAccessService,
  isMachineAccessActive,
  setMachineAccessSandboxMode,
  setMachineAccessProject,
  getMachineAccessMode,
  resetMachineAccessRuntime,
} from '../src/main/machine-access/runtime';

describe('machine-access runtime', () => {
  let workspace: string;

  beforeEach(() => {
    resetMachineAccessRuntime();
    trashed.length = 0;
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-rt-ws-')));
    setMachineAccessSandboxMode('native');
  });

  it('returns the SAME instance for the same workspace and project', () => {
    const a = getMachineAccessService(workspace, 'p1');
    const b = getMachineAccessService(workspace, 'p1');
    expect(a).not.toBeNull();
    // Identity is the whole point: two instances would mean a revoked grant
    // still honoured by a tool call.
    expect(b).toBe(a);
    expect(peekMachineAccessService()).toBe(a);
    expect(isMachineAccessActive()).toBe(true);
  });

  it('creates a fresh instance when the workspace changes', () => {
    const a = getMachineAccessService(workspace, 'p1');
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-rt-ws2-')));
    const b = getMachineAccessService(other, 'p1');
    expect(b).not.toBe(a);
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('falls back to the current project when none is given', () => {
    setMachineAccessProject('p-current');
    const a = getMachineAccessService(workspace);
    expect(a?.projectId).toBe('p-current');
    // Same project through either route must be one instance.
    expect(getMachineAccessService(workspace, 'p-current')).toBe(a);
  });

  it('refuses every isolated execution mode', () => {
    for (const mode of ['wsl', 'lima', 'ssh', 'daytona']) {
      resetMachineAccessRuntime();
      setMachineAccessSandboxMode(mode);
      expect(getMachineAccessMode()).toBe(mode);
      // null, not a working service: callers must report "not available".
      expect(getMachineAccessService(workspace, 'p1')).toBeNull();
      expect(isMachineAccessActive()).toBe(false);
    }
  });

  it('drops an existing service when the mode becomes isolated', () => {
    const service = getMachineAccessService(workspace, 'p1');
    expect(service).not.toBeNull();
    setMachineAccessSandboxMode('lima');
    // A stale service must not survive a switch to an isolated mode.
    expect(peekMachineAccessService()).toBeNull();
    expect(getMachineAccessService(workspace, 'p1')).toBeNull();
  });

  it('allows native and none', () => {
    for (const mode of ['native', 'none']) {
      resetMachineAccessRuntime();
      setMachineAccessSandboxMode(mode);
      expect(getMachineAccessService(workspace, 'p1')).not.toBeNull();
    }
  });

  it('registers the machine tools on the shared registry', () => {
    toolRegistry.clear();
    getMachineAccessService(workspace, 'p1');
    const names = toolRegistry.names();
    for (const expected of ['fs_read', 'fs_write', 'fs_trash', 'fs_move']) {
      expect(names).toContain(expected);
    }
  });

  it('routes a real deletion through the SYSTEM TRASH, never a permanent unlink', async () => {
    // Clear first, then create: the service registers its tools on creation, so
    // clearing afterwards would leave an empty registry.
    toolRegistry.clear();
    const service = getMachineAccessService(workspace, 'p1');
    service?.addGrantFromUser({ path: workspace, access: 'read-write', scope: 'session' });

    const file = path.join(workspace, 'a.txt');
    fs.writeFileSync(file, 'payload');

    const result = await invokeTool(
      toolRegistry,
      'fs_trash',
      { path: file },
      { sessionId: 's', cwd: workspace },
      { decidePermission: () => ({ allowed: true }) }
    );
    expect(result.isError).toBeFalsy();
    // The Electron shell was the deletion path, exactly once.
    expect(trashed).toEqual([file]);
    expect(fs.existsSync(file)).toBe(false);
    // And the content survived, moved aside by the stand-in trash.
    expect(fs.readFileSync(`${file}.trashed`, 'utf-8')).toBe('payload');
  });
});