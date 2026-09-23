/**
 * @module main/ipc/workflow-handlers
 *
 * Cowork 4.0 — IPC surface for the Plan -> Act -> Verify workflow. All inputs
 * cross the trust boundary here, so they are rebuilt through the shared
 * factories (`createTaskContract`, `createAtomicTask`) instead of being trusted
 * as-is. Every handler is wrapped so a failure is logged rather than crashing
 * the main process.
 */

import { ipcMain } from 'electron';
import type {
  AtomicTask,
  CreateTaskContractInput,
  TaskContract,
  WorkflowMode,
} from '../../shared/task-contract';
import { createAtomicTask, createTaskContract, isWorkflowMode } from '../../shared/task-contract';
import type {
  ApprovalDecisionInput,
  NewCheckpointEvidence,
  RolePlanInput,
} from '../../shared/workflow-types';
import { planRoles } from '../agent/role-planner';
import type { WorkflowEntry } from '../agent/workflow-registry';
import { log, logError } from '../utils/logger';

export interface WorkflowRegistryLike {
  get(sessionId: string): WorkflowEntry | null;
  getOrCreate(sessionId: string): WorkflowEntry | null;
}

export interface WorkflowIpcContext {
  registry: WorkflowRegistryLike;
}

type TaskInput = Partial<AtomicTask> & Pick<AtomicTask, 'id' | 'title'>;

function normalizeTasks(tasks: TaskInput[]): AtomicTask[] {
  return tasks.map((task) => createAtomicTask(task));
}

function safe<T>(channel: string, run: () => T): T {
  try {
    return run();
  } catch (error: unknown) {
    logError('[workflow] handler failed on ' + channel, error);
    throw error;
  }
}

export function registerWorkflowIpcHandlers(context: WorkflowIpcContext): void {
  const { registry } = context;

  const requireEntry = (sessionId: string): WorkflowEntry => {
    const entry = registry.getOrCreate(sessionId);
    if (!entry) {
      throw new Error('No workspace is available for session "' + sessionId + '".');
    }
    return entry;
  };

  ipcMain.handle('workflow.getState', (_event, sessionId: string) =>
    safe('workflow.getState', () => {
      const entry = registry.getOrCreate(sessionId);
      return entry ? entry.orchestrator.getState() : null;
    })
  );

  ipcMain.handle('workflow.setMode', (_event, sessionId: string, mode: WorkflowMode) =>
    safe('workflow.setMode', () => {
      if (!isWorkflowMode(mode)) {
        throw new Error('Unknown workflow mode: ' + String(mode));
      }
      return requireEntry(sessionId).orchestrator.setMode(mode);
    })
  );

  ipcMain.handle(
    'workflow.loadContract',
    (
      _event,
      sessionId: string,
      contractInput: CreateTaskContractInput,
      taskInputs: TaskInput[]
    ) =>
      safe('workflow.loadContract', () => {
        const contract: TaskContract = createTaskContract({
          ...contractInput,
          workspaceRoot:
            contractInput.workspaceRoot ?? requireEntry(sessionId).workspaceRoot,
        });
        return requireEntry(sessionId).orchestrator.loadContract(
          contract,
          normalizeTasks(Array.isArray(taskInputs) ? taskInputs : [])
        );
      })
  );

  ipcMain.handle('workflow.requestApproval', (_event, sessionId: string) =>
    safe('workflow.requestApproval', () =>
      requireEntry(sessionId).orchestrator.requestApproval()
    )
  );

  ipcMain.handle(
    'workflow.approve',
    (_event, sessionId: string, decision: ApprovalDecisionInput) =>
      safe('workflow.approve', () =>
        requireEntry(sessionId).orchestrator.approve({
          approved: Boolean(decision?.approved),
          reason: typeof decision?.reason === 'string' ? decision.reason : undefined,
          approver: typeof decision?.approver === 'string' ? decision.approver : undefined,
        })
      )
  );

  ipcMain.handle('workflow.startExecution', (_event, sessionId: string) =>
    safe('workflow.startExecution', () =>
      requireEntry(sessionId).orchestrator.startExecution()
    )
  );

  ipcMain.handle('workflow.startTask', (_event, sessionId: string, taskId: string) =>
    safe('workflow.startTask', () =>
      requireEntry(sessionId).orchestrator.startTask(taskId)
    )
  );

  ipcMain.handle(
    'workflow.completeTask',
    (_event, sessionId: string, taskId: string, evidence: NewCheckpointEvidence[]) =>
      safe('workflow.completeTask', () =>
        requireEntry(sessionId).orchestrator.completeTask(
          taskId,
          Array.isArray(evidence) ? evidence : []
        )
      )
  );

  ipcMain.handle('workflow.acceptTask', (_event, sessionId: string, taskId: string) =>
    safe('workflow.acceptTask', () =>
      requireEntry(sessionId).orchestrator.acceptTask(taskId)
    )
  );

  ipcMain.handle('workflow.restoreTask', (_event, sessionId: string, taskId: string) =>
    safe('workflow.restoreTask', () =>
      requireEntry(sessionId).orchestrator.restoreTask(taskId)
    )
  );

  ipcMain.handle(
    'workflow.rejectTask',
    (_event, sessionId: string, taskId: string, reason?: string) =>
      safe('workflow.rejectTask', () =>
        requireEntry(sessionId).orchestrator.rejectTask(
          taskId,
          typeof reason === 'string' ? reason : undefined
        )
      )
  );

  ipcMain.handle('workflow.restorePlan', (_event, sessionId: string) =>
    safe('workflow.restorePlan', () => requireEntry(sessionId).orchestrator.restorePlan())
  );

  ipcMain.handle('workflow.verify', (_event, sessionId: string) =>
    safe('workflow.verify', () => requireEntry(sessionId).orchestrator.verify())
  );

  ipcMain.handle('workflow.planRoles', (_event, sessionId: string, input: RolePlanInput) =>
    safe('workflow.planRoles', () => {
      const entry = requireEntry(sessionId);
      const contract = entry.orchestrator.getContract();
      if (!contract) {
        throw new Error('Load a contract before planning roles.');
      }
      return planRoles(input ?? { request: '' }, contract);
    })
  );

  ipcMain.handle('workflow.getAuditLog', (_event, sessionId: string) =>
    safe('workflow.getAuditLog', () => {
      const entry = requireEntry(sessionId);
      return entry.audit.list();
    })
  );

  ipcMain.handle('workflow.exportAuditLog', (_event, sessionId: string) =>
    safe('workflow.exportAuditLog', () => {
      const entry = requireEntry(sessionId);
      log('[workflow] exporting audit log for session ' + sessionId);
      return entry.audit.exportJson();
    })
  );
}
