/**
 * @module main/machine-access/runtime
 *
 * The process-wide holder for the machine-access service.
 *
 * It exists so the IPC handlers, the tool gate and the agent hook all reach
 * the SAME service instance (same grants, same journal, same autonomy). Two
 * instances would mean a grant revoked in Settings while a tool still believed
 * it had access — the failure mode this module removes by construction.
 *
 * Machine access acts on the real machine, so it is native-mode only. A
 * non-native mode (WSL/Lima/SSH/Daytona) leaves the service null, and callers
 * must report machine access as inactive rather than implying it works.
 */

import { app, shell } from 'electron';
import { toolRegistry } from '../tools/registry';
import { getDatabase } from '../db/database';
import { MachineAccessService } from './machine-access-service';

let service: MachineAccessService | null = null;
let activeMode = 'none';
let currentProjectId = 'default';

export function setMachineAccessSandboxMode(mode: string): void {
  activeMode = mode;
  if (mode !== 'native' && mode !== 'none') {
    // Drop the service so a stale one cannot be used under an isolated mode.
    service = null;
  }
}

export function getMachineAccessMode(): string {
  return activeMode;
}

/** True when machine access may act on the real machine. */
export function isMachineAccessActive(): boolean {
  return service !== null;
}

export function setMachineAccessProject(projectId: string): void {
  currentProjectId = projectId;
}

/**
 * The service for a workspace, created on first use. Returns null when the
 * active execution mode is isolated — callers must treat that as "machine
 * access is not available", never as "allowed".
 */
export function getMachineAccessService(
  workspaceRoot: string,
  projectId?: string
): MachineAccessService | null {
  if (activeMode === 'wsl' || activeMode === 'lima' || activeMode === 'ssh' || activeMode === 'daytona') {
    return null;
  }
  const project = projectId ?? currentProjectId;
  if (service && service.projectId === project && service.workspaceRoot === workspaceRoot) {
    return service;
  }
  const db = getDatabase();
  service = new MachineAccessService({
    workspaceRoot,
    projectId: project,
    appDataPath: app.getPath('userData'),
    registry: toolRegistry,
    db: {
      prepare: (sql: string) => db.raw.prepare(sql),
      exec: (sql: string) => db.raw.exec(sql),
    },
    trashItem: async (filePath: string) => {
      // The system trash is the ONLY deletion path; nothing here unlinks.
      await shell.trashItem(filePath);
    },
  });
  service.registerTools();
  return service;
}

/** The existing service without creating one (read paths). */
export function peekMachineAccessService(): MachineAccessService | null {
  return service;
}

export function resetMachineAccessRuntime(): void {
  service = null;
  activeMode = 'none';
  currentProjectId = 'default';
}