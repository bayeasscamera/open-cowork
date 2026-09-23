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
  IsolationPlan,
  NewCheckpointEvidence,
  RolePlanInput,
  WorkflowState,
} from '../../shared/workflow-types';
import { planIsolation } from '../agent/isolation-planner';
import type { ProofRunner } from '../agent/proof-runner';
import { planRoles } from '../agent/role-planner';
import type { WorkflowEntry } from '../agent/workflow-registry';
import type {
  WorkflowExecutor,
  WorkflowExecutorOptions,
  WorkflowRunControl,
  WorkflowTaskRunner,
} from '../agent/workflow-executor';
import { log, logError } from '../utils/logger';

export interface WorkflowRegistryLike {
  get(sessionId: string): WorkflowEntry | null;
  getOrCreate(sessionId: string): WorkflowEntry | null;
  /** Present on the real registry; omitted by lightweight test doubles. */
  executorFor?(
    sessionId: string,
    runTask: WorkflowTaskRunner,
    overrides?: Partial<WorkflowExecutorOptions>
  ): WorkflowExecutor | null;
  /** Durable snapshot write; omitted when no persistence is configured. */
  persist?(sessionId: string): Promise<boolean>;
  /** Run control, so pause/cancel reach the execution in flight. */
  beginRun?(sessionId: string): WorkflowRunControl | undefined;
  endRun?(sessionId: string): void;
  pauseRun?(sessionId: string): WorkflowState | null;
  cancelRun?(sessionId: string): WorkflowState | null;
}

export interface WorkflowIpcContext {
  registry: WorkflowRegistryLike;
  /**
   * Runs one approved task through the real LLM loop. When absent, the
   * execution channels report that execution is unavailable instead of
   * silently pretending the task ran.
   */
  runWorkflowTask?: WorkflowTaskRunner;
  /** Re-runs a task's declared proof commands in the workspace. */
  runProof?: ProofRunner;
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

async function safeAsync<T>(channel: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
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

  /**
   * Build the executor that actually drives approved tasks. The LLM runner is
   * injected at bootstrap so this module never imports the agent session stack.
   */
  const requireExecutor = (
    sessionId: string,
    overrides: Partial<WorkflowExecutorOptions> = {}
  ): WorkflowExecutor => {
    const runTask = context.runWorkflowTask;
    if (!runTask || typeof registry.executorFor !== 'function') {
      throw new Error('Workflow execution is not available in this build.');
    }
    requireEntry(sessionId);
    const executor = registry.executorFor(sessionId, runTask, {
      runProof: context.runProof,
      ...overrides,
    });
    if (!executor) {
      throw new Error('No workspace is available for session "' + sessionId + '".');
    }
    return executor;
  };

  /**
   * Drive a plan under a fresh run control, so `workflow.pause` and
   * `workflow.cancel` can reach the execution that is in flight instead of
   * waiting for it to finish.
   */
  const runWithControl = async <T>(
    sessionId: string,
    run: (executor: WorkflowExecutor) => Promise<T>
  ): Promise<T> => {
    const control = registry.beginRun?.(sessionId);
    try {
      return await run(requireExecutor(sessionId, control ? { control } : {}));
    } finally {
      registry.endRun?.(sessionId);
    }
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

  ipcMain.handle('workflow.startReadyTasks', (_event, sessionId: string) =>
    safe('workflow.startReadyTasks', () =>
      requireEntry(sessionId).orchestrator.startReadyTasks()
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

  ipcMain.handle(
    'workflow.exportAuditLog',
    (_event, sessionId: string, format?: string) =>
      safe('workflow.exportAuditLog', () => {
        const entry = requireEntry(sessionId);
        log('[workflow] exporting audit log for session ' + sessionId);
        switch (format) {
          case 'ndjson':
            return entry.audit.exportNdjson();
          case 'csv':
            return entry.audit.exportCsv();
          default:
            return entry.audit.exportJson();
        }
      })
  );

  ipcMain.handle('workflow.planIsolation', (_event, sessionId: string, taskIds?: string[]) =>
    safe('workflow.planIsolation', () => {
      const entry = requireEntry(sessionId);
      const state = entry.orchestrator.getState();
      const selected =
        Array.isArray(taskIds) && taskIds.length > 0
          ? state.tasks.filter((task) => taskIds.includes(task.id))
          : state.tasks;
      return planIsolation(selected, entry.workspaceRoot);
    })
  );

  ipcMain.handle(
    'workflow.createIsolation',
    (_event, sessionId: string, plan: IsolationPlan) =>
      safe('workflow.createIsolation', () =>
        requireEntry(sessionId).isolation.create(plan)
      )
  );

  ipcMain.handle('workflow.isolationStatus', (_event, sessionId: string) =>
    safe('workflow.isolationStatus', () => requireEntry(sessionId).isolation.activeTaskIds())
  );

  ipcMain.handle('workflow.cleanupIsolation', (_event, sessionId: string, taskId: string) =>
    safe('workflow.cleanupIsolation', () =>
      requireEntry(sessionId).isolation.cleanup(taskId)
    )
  );

  ipcMain.handle('workflow.cleanupAllIsolation', (_event, sessionId: string) =>
    safe('workflow.cleanupAllIsolation', () =>
      requireEntry(sessionId).isolation.cleanupAll()
    )
  );

  // --- Execution (Phase 8) -------------------------------------------------
  // These channels run the approved plan for real: each ready task is driven
  // through the LLM loop, its declared proof commands are re-run by the main
  // process, and the outcome is recorded on the orchestrator.

  ipcMain.handle('workflow.executePlan', (_event, sessionId: string) =>
    safeAsync('workflow.executePlan', () =>
      runWithControl(sessionId, (executor) => executor.executePlan())
    )
  );

  ipcMain.handle('workflow.executeReadyTasks', (_event, sessionId: string) =>
    safeAsync('workflow.executeReadyTasks', () =>
      runWithControl(sessionId, (executor) => executor.executeReadyTasks())
    )
  );

  // Pause and cancel act on the run in flight. Pause lets the running task
  // finish (no half-applied write); cancel aborts it immediately.
  ipcMain.handle('workflow.pause', (_event, sessionId: string) =>
    safe('workflow.pause', () => {
      const entry = requireEntry(sessionId);
      return registry.pauseRun?.(sessionId) ?? entry.orchestrator.getState();
    })
  );

  ipcMain.handle('workflow.cancel', (_event, sessionId: string) =>
    safe('workflow.cancel', () => {
      const entry = requireEntry(sessionId);
      return registry.cancelRun?.(sessionId) ?? entry.orchestrator.getState();
    })
  );

  ipcMain.handle('workflow.verifyTask', (_event, sessionId: string, taskId: string) =>
    safeAsync('workflow.verifyTask', async () =>
      requireEntry(sessionId).orchestrator.verifyTask(taskId)
    )
  );

  ipcMain.handle('workflow.persist', (_event, sessionId: string) =>
    safeAsync('workflow.persist', async () => {
      requireEntry(sessionId);
      if (typeof registry.persist !== 'function') {
        return false;
      }
      return registry.persist(sessionId);
    })
  );
}
