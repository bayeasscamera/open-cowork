/**
 * Wiring assertions for the machine-access IPC surface. The renderer test
 * environment is Node (no DOM), so this pins what types cannot prove: every
 * channel the preload exposes has a main-process handler, the handlers are
 * registered at boot, and there is deliberately NO channel that lets the model
 * grant itself access or answer an approval card.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const preload = read('src/preload/index.ts');
// Collapse whitespace so a multi-line ipcMain.handle('…', …) call still matches.
const handlers = read('src/main/ipc/machine-access-handlers.ts').replace(/\s+/g, ' ');
const main = read('src/main/index.ts');
const contract = read('src/shared/machine-access-contract.ts');

const CHANNELS = [
  'machineAccess.getState',
  'machineAccess.pickFolder',
  'machineAccess.revokeGrant',
  'machineAccess.setAutonomy',
  'machineAccess.addApp',
  'machineAccess.removeApp',
  'machineAccess.planBatch',
  'machineAccess.runBatch',
  'machineAccess.undoBatch',
  'machineAccess.previewProjectRename',
  'machineAccess.runProjectRename',
  'machineAccess.emergencyStop',
];

describe('machine-access IPC wiring', () => {
  it('every exposed channel has a main-process handler', () => {
    for (const channel of CHANNELS) {
      expect(preload).toContain(`ipcRenderer.invoke('${channel}'`);
      expect(handlers).toMatch(new RegExp(`ipcMain\\.handle\\(\\s*'${channel.replace('.', '\\.')}'`));
    }
  });

  it('exposes exactly these channels — no self-granting or self-approval channel', () => {
    const exposed = [...preload.matchAll(/ipcRenderer\.invoke\('(machineAccess\.[A-Za-z]+)'/g)].map(
      (m) => m[1]
    );
    expect(new Set(exposed)).toEqual(new Set(CHANNELS));
    // The model must not be able to create a grant by itself...
    expect(exposed).not.toContain('machineAccess.addGrant');
    expect(exposed).not.toContain('machineAccess.setGrant');
    // ...nor answer an approval card on the user's behalf.
    expect(exposed).not.toContain('machineAccess.resolveApproval');
    expect(exposed).not.toContain('machineAccess.approve');
  });

  it('folder grants only come from the native picker or a user confirm button', () => {
    expect(handlers).toContain("dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })");
    expect(handlers).toContain('addGrantFromUser');
    // The grant store is the only place that can create one, and only for the user.
    expect(handlers).toContain('getMachineAccessService');
    // The agent-facing API throws instead of creating a grant.
    expect(read('src/main/machine-access/grant-store.ts')).toContain(
      "if (origin !== 'user')"
    );
  });

  it('deletion goes through the system trash, never unlink or rm -rf', () => {
    // The ONLY deletion path is the system trash, wired in the runtime.
    const runtime = read('src/main/machine-access/runtime.ts').replace(/\s+/g, ' ');
    expect(runtime).toContain('shell.trashItem(filePath)');
    expect(handlers).not.toContain('unlinkSync');
    expect(handlers).not.toContain('rm -rf');
  });

  it('handlers are registered at boot and bound to the execution mode', () => {
    expect(main).toContain('registerMachineAccessIpcHandlers()');
    expect(main).toContain('setMachineAccessSandboxMode(getSandboxAdapter().mode)');
    // Machine access is native-mode only; the runtime owns that rule.
    const runtime = read('src/main/machine-access/runtime.ts').replace(/\s+/g, ' ');
    expect(runtime).toContain(
      "activeMode === 'wsl' || activeMode === 'lima' || activeMode === 'ssh' || activeMode === 'daytona'"
    );
    expect(runtime).toContain('return null;');
  });

  it('every handler is wrapped so a failure never crashes the main process', () => {
    const handlerCount = (handlers.match(/ipcMain\.handle\(/g) ?? []).length;
    expect(handlerCount).toBe(CHANNELS.length);
    const tryCount = (handlers.match(/try \{/g) ?? []).length;
    expect(tryCount).toBeGreaterThanOrEqual(handlerCount);
  });

  it('the renderer contract is declared once and shared by both sides', () => {
    expect(preload).toContain("from '../shared/machine-access-contract'");
    expect(contract).toContain('export interface MachineAccessState');
    expect(contract).toContain('nativeMode: boolean');
  });
});
