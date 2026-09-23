/**
 * Cowork 4.0 — Phase 3.5: live plan graph.
 *
 * Renders the task DAG with per-node state, dependencies, cost, files touched
 * and verification evidence, so the user can see what the swarm is doing without
 * reading raw logs.
 */

import { useTranslation } from 'react-i18next';
import { CheckCircle2, CircleDashed, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import type { AtomicTask, TaskCheckpoint, WorkflowState } from '../../shared/workflow-types';

interface PlanGraphProps {
  state: WorkflowState;
}

type NodeStatus = 'done' | 'running' | 'ready' | 'blocked' | 'rejected';

function statusFor(
  task: AtomicTask,
  state: WorkflowState,
  checkpoint: TaskCheckpoint | undefined
): NodeStatus {
  if (checkpoint?.status === 'rejected') {
    return 'rejected';
  }
  if (state.completedTaskIds.includes(task.id)) {
    return 'done';
  }
  if (state.phase === 'executing' && checkpoint) {
    return 'running';
  }
  const waitingOn = task.dependsOn.filter(
    (dependency) => !state.completedTaskIds.includes(dependency)
  );
  return waitingOn.length === 0 ? 'ready' : 'blocked';
}

function statusIcon(status: NodeStatus) {
  const className = 'h-3.5 w-3.5 shrink-0';
  switch (status) {
    case 'done':
      return <CheckCircle2 className={className + ' text-emerald-400'} />;
    case 'running':
      return <Loader2 className={className + ' animate-spin text-accent'} />;
    case 'rejected':
      return <XCircle className={className + ' text-red-400'} />;
    case 'blocked':
      return <ShieldAlert className={className + ' text-amber-400'} />;
    default:
      return <CircleDashed className={className + ' text-text-muted'} />;
  }
}

export function PlanGraph({ state }: PlanGraphProps) {
  const { t } = useTranslation();

  if (state.tasks.length === 0) {
    return <p className="text-xs text-text-muted">{t('planPanel.graph.empty')}</p>;
  }

  return (
    <div className="space-y-3">
      {state.groups.map((group, index) => (
        <div key={'group-' + index} className="space-y-1.5">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-muted">
            <span>{t('planPanel.graph.group', { index: index + 1 })}</span>
            <span>{t('planPanel.graph.parallel', { count: group.length })}</span>
          </div>
          <ul className="space-y-1.5">
            {group.map((task) => {
              const checkpoint = state.checkpoints.find((item) => item.taskId === task.id);
              const status = statusFor(task, state, checkpoint);
              return (
                <li
                  key={task.id}
                  className="rounded-xl border border-border-subtle bg-background/60 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    {statusIcon(status)}
                    <span className="truncate text-xs font-medium text-text-primary">
                      {task.title}
                    </span>
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                      {t('planPanel.role.' + task.role)}
                    </span>
                    <span className="ml-auto text-[10px] text-text-muted">
                      {t('planPanel.graph.status.' + status)}
                    </span>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-text-muted">
                    {task.dependsOn.length > 0 && (
                      <span>
                        {t('planPanel.graph.dependsOn')}: {task.dependsOn.join(', ')}
                      </span>
                    )}
                    {task.budget.maxTokens !== undefined && (
                      <span>{t('planPanel.graph.tokens', { count: task.budget.maxTokens })}</span>
                    )}
                    {task.budget.estimatedCostUsd !== undefined && (
                      <span>{task.budget.estimatedCostUsd.toFixed(4)} USD</span>
                    )}
                    {task.writeScope.length > 0 && (
                      <span className="truncate">
                        {t('planPanel.graph.files', { count: task.writeScope.length })}:{' '}
                        <span className="font-mono">{task.writeScope.join(', ')}</span>
                      </span>
                    )}
                    {checkpoint && (
                      <span>
                        {t('planPanel.graph.evidence', { count: checkpoint.evidence.length })}
                      </span>
                    )}
                    {checkpoint && (checkpoint.additions > 0 || checkpoint.deletions > 0) && (
                      <span className="font-mono">
                        +{checkpoint.additions}/-{checkpoint.deletions}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
