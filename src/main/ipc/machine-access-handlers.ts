/**
 * @module main/ipc/machine-access-handlers
 *
 * Machine-access IPC channels (`machineAccess.*`): folder grants (added only
 * from the native folder picker or an explicit confirm button), autonomy
 * level, allowed applications, batch preview/execution, journal + undo,
 * project rename preview/execution, system permission state and the emergency
 * stop.
 *
 * The approval flow deliberately has NO channel that lets the agent answer a
 * card: `machineAccess.resolveApproval` is only reachable from the renderer
 * after the user clicked a button, and it re-checks the action fingerprint.
 */

import { ipcMain, dialog, shell, app } from 'electron';
import { getDatabase } from '../db/database';
import { MachineAccessService } from '../machine-access/machine-access-service';
import { getEmergencyStop, AllowedApps } from '../machine-access/machine-control';
import { macPermissionStates } from '../machine-access/machine-control';
import { previewRename, executeRename } from '../machine-access/project-rename';
import { getSharedProjectStore } from '../projects/project-store';
import { toolRegistry } from '../tools/registry';
import type { AutonomyLevel, GrantAccess, GrantScope } from '../machine-access/types';
import type { BatchOpInput } from '../machine-access/batch-plan';
import { logError } from '../utils/logger';

let service: MachineAccessService | null = null;
const allowedApps = new AllowedApps();

/**
 * The service is per-workspace. Machine access is native-mode only, so a
 * non-native sandbox mode leaves it null and the UI shows machine access as
 * inactive rather than implying it works.
 */
export function setMachineAccessSandboxMode(mode: string): void {
  if (mode !== 'native' && mode !== 'none') {
    service = null;
  }
}

function getService(workspaceRoot: string, projectId: string): MachineAccessService {
  if (!service) {
    const db = getDatabase();
    service = new MachineAccessService({
      workspaceRoot,
      projectId,
      appDataPath: app.getPath('userData'),
      registry: toolRegistry,
      db: {
        prepare: (sql: string) => db.raw.prepare(sql),
        exec: (sql: string) => db.raw.exec(sql),
      },
      trashItem: async (filePath: string) => {
        await shell.trashItem(filePath);
      },
    });
    service.registerTools();
  }
  return service;
}

export function registerMachineAccessIpcHandlers(): void {
  ipcMain.handle('machineAccess.getState', async (_event, args: { workspaceRoot?: string; projectId?: string }) => {
    try {
      const svc = getService(args?.workspaceRoot ?? process.cwd(), args?.projectId ?? 'default');
      return {
        nativeMode: service !== null,
        grants: svc.listGrants(),
        autonomy: svc.autonomy,
        allowedApps: allowedApps.list(),
        permissions: macPermissionStates(),
        history: svc.history(),
        backupQuotaBytes: 512 * 1024 * 1024,
      };
    } catch (error) {
      logError('[MachineAccess] getState failed:', error);
      return { nativeMode: false, grants: [], autonomy: 'ask-always', allowedApps: [], permissions: [], history: [] };
    }
  });

  // Folder grant: the path comes from the NATIVE picker opened here, or from a
  // renderer confirm button that passes an explicit path. Never from the model.
  ipcMain.handle(
    'machineAccess.pickFolder',
    async (_event, args: { access?: GrantAccess; scope?: GrantScope; expiresAt?: number } = {}) => {
      try {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
        if (result.canceled || result.filePaths.length === 0) return { granted: false };
        const svc = getService(process.cwd(), 'default');
        const grant = svc.addGrantFromUser({
          path: result.filePaths[0],
          access: args.access ?? 'read-write',
          scope: args.scope ?? 'project',
          expiresAt: args.expiresAt,
        });
        return { granted: true, grant };
      } catch (error) {
        logError('[MachineAccess] pickFolder failed:', error);
        return { granted: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle('machineAccess.revokeGrant', async (_event, args: { id: string }) => {
    try {
      const svc = getService(process.cwd(), 'default');
      return { revoked: svc.revokeGrant(args.id) };
    } catch (error) {
      logError('[MachineAccess] revokeGrant failed:', error);
      return { revoked: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('machineAccess.setAutonomy', async (_event, args: { projectId: string; level: AutonomyLevel }) => {
    try {
      const svc = getService(process.cwd(), args.projectId);
      svc.setAutonomy(args.level);
      return { autonomy: svc.autonomy };
    } catch (error) {
      logError('[MachineAccess] setAutonomy failed:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('machineAccess.addApp', async (_event, args: { name: string }) => {
    try {
      allowedApps.addByUser(args.name);
      return { allowedApps: allowedApps.list() };
    } catch (error) {
      logError('[MachineAccess] addApp failed:', error);
      return { allowedApps: allowedApps.list(), error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('machineAccess.removeApp', async (_event, args: { name: string }) => {
    try {
      allowedApps.remove(args.name);
      return { allowedApps: allowedApps.list() };
    } catch (error) {
      logError('[MachineAccess] removeApp failed:', error);
      return { allowedApps: allowedApps.list(), error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Batch: preview first (changes nothing), then execute the same plan.
  ipcMain.handle(
    'machineAccess.planBatch',
    async (_event, args: { workspaceRoot: string; projectId: string; ops: BatchOpInput[]; allowGitRoots?: boolean }) => {
      try {
        const svc = getService(args.workspaceRoot, args.projectId);
        return { plan: svc.planBatch(args.ops, args.allowGitRoots ?? false) };
      } catch (error) {
        logError('[MachineAccess] planBatch failed:', error);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle(
    'machineAccess.runBatch',
    async (_event, args: { workspaceRoot: string; projectId: string; plan: ReturnType<MachineAccessService['planBatch']>; allowGitRoots?: boolean }) => {
      try {
        const svc = getService(args.workspaceRoot, args.projectId);
        return { result: await svc.runBatch(args.plan, args.allowGitRoots ?? false) };
      } catch (error) {
        logError('[MachineAccess] runBatch failed:', error);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle('machineAccess.undoBatch', async (_event, args: { workspaceRoot: string; projectId: string; batchId: string }) => {
    try {
      const svc = getService(args.workspaceRoot, args.projectId);
      return { undo: svc.undoBatch(args.batchId) };
    } catch (error) {
      logError('[MachineAccess] undoBatch failed:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Project rename: preview lists every reference, execution is transactional.
  ipcMain.handle(
    'machineAccess.previewProjectRename',
    async (_event, args: { projectId: string; newName: string; renameDir: boolean; newDirName?: string }) => {
      try {
        const store = getSharedProjectStore();
        const preview = previewRename(
          {
            getProject: (id) => {
              const p = store.get(id);
              return p ? { id: p.id, name: p.name, workdir: p.workdir } : undefined;
            },
            listSessions: (id) => store.getSessions(id).map((s) => ({ id: s.id, cwd: s.cwd ?? '' })),
            listFiles: (id) => store.get(id)?.referenceFiles ?? [],
          },
          args.projectId,
          args.newName,
          args.renameDir,
          args.newDirName
        );
        return { preview };
      } catch (error) {
        logError('[MachineAccess] previewProjectRename failed:', error);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle(
    'machineAccess.runProjectRename',
    async (_event, args: { projectId: string; newName: string; renameDir: boolean; newDirName?: string }) => {
      try {
        const store = getSharedProjectStore();
        const db = getDatabase();
        const project = store.get(args.projectId);
        if (!project) return { error: `Project not found: ${args.projectId}` };
        const preview = previewRename(
          {
            getProject: (id) => {
              const p = store.get(id);
              return p ? { id: p.id, name: p.name, workdir: p.workdir } : undefined;
            },
            listSessions: (id) => store.getSessions(id).map((s) => ({ id: s.id, cwd: s.cwd ?? '' })),
            listFiles: (id) => store.get(id)?.referenceFiles ?? [],
          },
          args.projectId,
          args.newName,
          args.renameDir,
          args.newDirName
        );
        const out = executeRename(
          {
            getProject: (id) => {
              const p = store.get(id);
              return p ? { id: p.id, name: p.name, workdir: p.workdir } : undefined;
            },
            listSessions: (id) => store.getSessions(id).map((s) => ({ id: s.id, cwd: s.cwd ?? '' })),
            listFiles: (id) => store.get(id)?.referenceFiles ?? [],
            transaction: (fn) => db.raw.transaction(fn)(),
            applyDbUpdates: (updates) => {
              store.update(args.projectId, {
                name: updates.project.name,
                ...(updates.project.workdir ? { workdir: updates.project.workdir } : {}),
              });
              for (const s of updates.sessions) db.sessions.update(s.id, { cwd: s.cwd });
              for (const f of updates.files) {
                if (f.before !== f.after) {
                  store.detachFile(args.projectId, f.before);
                  store.attachFile(args.projectId, f.after);
                }
              }
            },
            isInUse: () => null,
            journal: getService(project.workdir, args.projectId).journal,
          },
          preview
        );
        return { workdir: out.workdir };
      } catch (error) {
        logError('[MachineAccess] runProjectRename failed:', error);
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  // Emergency stop: independent of the agent loop, works even if it is stuck.
  ipcMain.handle('machineAccess.emergencyStop', async () => {
    try {
      return getEmergencyStop().stop();
    } catch (error) {
      logError('[MachineAccess] emergencyStop failed:', error);
      return { controllers: 0, processes: 0, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Reset between tests / app restarts. */
export function __resetMachineAccessForTests(): void {
  service = null;
}
