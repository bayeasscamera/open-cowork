/**
 * Cowork 4.0 — Phase 1.3 approval page.
 *
 * Surfaces the plan, its file scope, the commands it intends to run, the risk
 * level and the estimated cost, then gates execution on an explicit human
 * decision. Also exposes per-task checkpoints (Phase 2) and the audit trail
 * (Phase 5).
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Download,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  X,
  XCircle,
} from 'lucide-react';
import type {
  AuditEntry,
  TaskCheckpoint,
  WorkflowExecutionReport,
  WorkflowMode,
  WorkflowState,
} from '../../shared/workflow-types';
import { ExecutionReportPanel } from './ExecutionReportPanel';
import { PlanGraph } from './PlanGraph';

const MODES: WorkflowMode[] = ['explore', 'plan', 'execute'];

interface PlanApprovalPanelProps {
  sessionId: string;
  onClose: () => void;
}

function statusClasses(status: TaskCheckpoint['status']): string {
  switch (status) {
    case 'accepted':
      return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400';
    case 'rejected':
      return 'border-red-500/40 bg-red-500/10 text-red-400';
    case 'restored':
      return 'border-amber-500/40 bg-amber-500/10 text-amber-400';
    default:
      return 'border-border text-text-secondary';
  }
}

export function PlanApprovalPanel({ sessionId, onClose }: PlanApprovalPanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<WorkflowState | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [execReport, setExecReport] = useState<WorkflowExecutionReport | null>(null);

  const api = typeof window !== 'undefined' ? window.electronAPI?.workflow : undefined;

  const refresh = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const [nextState, nextAudit] = await Promise.all([
        api.getState(sessionId),
        api.getAuditLog(sessionId),
      ]);
      setState(nextState);
      setAudit(nextAudit);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        const result = await action();
        // Capture execution reports so the panel can display them.
        if (
          result &&
          typeof result === 'object' &&
          'results' in result &&
          Array.isArray((result as WorkflowExecutionReport).results)
        ) {
          setExecReport(result as WorkflowExecutionReport);
        }
        await refresh();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const exportAudit = useCallback(async () => {
    if (!api) {
      return;
    }
    const json = await api.exportAuditLog(sessionId);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'cowork-audit-' + sessionId + '.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, [api, sessionId]);

  const approval = state?.approval ?? null;
  const blockers = state?.blockers ?? [];
  const approved = state?.approvalOutcome?.approved === true;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">{t('planPanel.title')}</h2>
          <p className="text-xs text-text-muted">{t('planPanel.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy}
            className="rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary hover:bg-surface-hover disabled:opacity-50"
            aria-label={t('planPanel.actions.refresh')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary hover:bg-surface-hover"
            aria-label={t('planPanel.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-5">
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        <section className="space-y-2">
          <span className="text-xs font-medium text-text-secondary">{t('planPanel.mode.label')}</span>
          <div className="flex flex-wrap gap-2">
            {MODES.map((mode) => {
              const active = state?.mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={busy || !api}
                  onClick={() => api && void run(() => api.setMode(sessionId, mode))}
                  className={
                    'rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ' +
                    (active
                      ? 'border-accent bg-accent/10 text-text-primary'
                      : 'border-border text-text-secondary hover:bg-surface-hover')
                  }
                >
                  <span className="font-medium">{t('planPanel.mode.' + mode)}</span>
                  <span className="ml-2 text-text-muted">{t('planPanel.mode.' + mode + 'Hint')}</span>
                </button>
              );
            })}
          </div>
        </section>

        {state && (
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full border border-border px-2 py-0.5 text-text-secondary">
              {t('planPanel.phaseLabel')}: {t('planPanel.phase.' + state.phase)}
            </span>
            {state.objective && (
              <span className="truncate text-text-muted" title={state.objective}>
                {state.objective}
              </span>
            )}
          </div>
        )}

        {!state || !state.contractId ? (
          <div className="rounded-xl border border-border-subtle bg-background/60 px-4 py-8 text-center">
            <p className="text-sm text-text-secondary">{t('planPanel.empty.title')}</p>
            <p className="mt-1 text-xs text-text-muted">{t('planPanel.empty.body')}</p>
          </div>
        ) : (
          <>
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label={t('planPanel.metrics.tasks')} value={String(state.tasks.length)} />
              <Metric
                label={t('planPanel.metrics.files')}
                value={String(approval?.fileScope.length ?? 0)}
              />
              <Metric
                label={t('planPanel.metrics.risk')}
                value={t('planPanel.risk.' + (approval?.riskLevel ?? 'low'))}
              />
              <Metric
                label={t('planPanel.metrics.cost')}
                value={
                  approval?.estimatedCostUsd === null || approval?.estimatedCostUsd === undefined
                    ? t('planPanel.none')
                    : '$' + approval.estimatedCostUsd.toFixed(4)
                }
              />
            </section>

            {approval && approval.fileScope.length > 0 && (
              <section className="space-y-1">
                <span className="text-xs font-medium text-text-secondary">
                  {t('planPanel.scope')}
                </span>
                <ul className="space-y-0.5 font-mono text-xs text-text-muted">
                  {approval.fileScope.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </section>
            )}

            {approval && approval.plannedCommands.length > 0 && (
              <section className="space-y-1">
                <span className="text-xs font-medium text-text-secondary">
                  {t('planPanel.commands')}
                </span>
                <ul className="space-y-0.5 font-mono text-xs text-text-muted">
                  {approval.plannedCommands.map((command) => (
                    <li key={command}>{command}</li>
                  ))}
                </ul>
              </section>
            )}

            {blockers.length > 0 && (
              <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                <div className="flex items-center gap-2 text-xs font-medium text-amber-400">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  {t('planPanel.blockers.title')}
                </div>
                <ul className="mt-1 space-y-0.5 text-xs text-amber-300/90">
                  {blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </section>
            )}

            <section className="space-y-2">
              <span className="text-xs font-medium text-text-secondary">
                {t('planPanel.approval.title')}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy || !api || approved || blockers.length > 0}
                  onClick={() => api && void run(() => api.approve(sessionId, { approved: true }))}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-400 disabled:opacity-40"
                >
                  <Check className="h-3.5 w-3.5" />
                  {t('planPanel.approval.approve')}
                </button>
                <button
                  type="button"
                  disabled={busy || !api || !approval}
                  onClick={() =>
                    api &&
                    void run(() =>
                      api.approve(sessionId, { approved: false, reason: 'Rejected from UI' })
                    )
                  }
                  className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary disabled:opacity-40"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {t('planPanel.approval.reject')}
                </button>
                <button
                  type="button"
                  disabled={busy || !api}
                  onClick={() => api && void run(() => api.requestApproval(sessionId))}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary disabled:opacity-40"
                >
                  {t('planPanel.approval.refresh')}
                </button>
                <span className="text-xs text-text-muted">
                  {approved
                    ? t('planPanel.approval.approved')
                    : t('planPanel.approval.pending')}
                </span>
              </div>
            </section>

            <section className="space-y-2">
              <span className="text-xs font-medium text-text-secondary">
                {t('planPanel.graph.title')}
              </span>
              <PlanGraph state={state} />
            </section>

            <ExecutionReportPanel report={execReport} totalTasks={state.tasks.length} />

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-secondary">
                  {t('planPanel.tasks.title')}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || !api || !approved || blockers.length > 0}
                    onClick={() => api && void run(() => api.executePlan(sessionId))}
                    className="rounded-lg border border-border px-3 py-1 text-xs text-text-secondary disabled:opacity-40"
                  >
                    {t('planPanel.actions.start')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !api || !approved || blockers.length > 0}
                    onClick={() => api && void run(() => api.executeReadyTasks(sessionId))}
                    className="rounded-lg border border-border px-3 py-1 text-xs text-text-secondary disabled:opacity-40"
                  >
                    {t('planPanel.actions.startReady')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !api}
                    onClick={() => api && void run(() => api.verify(sessionId))}
                    className="rounded-lg border border-border px-3 py-1 text-xs text-text-secondary disabled:opacity-40"
                  >
                    {t('planPanel.actions.verify')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || !api}
                    onClick={() => api && void run(() => api.restorePlan(sessionId))}
                    className="flex items-center gap-1 rounded-lg border border-border px-3 py-1 text-xs text-text-secondary disabled:opacity-40"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {t('planPanel.actions.restorePlan')}
                  </button>
                </div>
              </div>

              <ul className="space-y-2">
                {state.tasks.map((task) => {
                  const checkpoint = state.checkpoints.find((item) => item.taskId === task.id);
                  const completed = state.completedTaskIds.includes(task.id);
                  return (
                    <li
                      key={task.id}
                      className="rounded-xl border border-border-subtle bg-background/60 px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-text-primary">{task.title}</span>
                        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                          {t('planPanel.role.' + task.role)}
                        </span>
                        <span className="text-[10px] text-text-muted">
                          {t('planPanel.risk.' + task.riskLevel)}
                        </span>
                        {checkpoint && (
                          <span
                            className={
                              'rounded border px-1.5 py-0.5 text-[10px] ' +
                              statusClasses(checkpoint.status)
                            }
                          >
                            {t('planPanel.task.status.' + checkpoint.status)}
                          </span>
                        )}
                        {completed && !checkpoint && (
                          <span className="rounded border border-emerald-500/40 px-1.5 py-0.5 text-[10px] text-emerald-400">
                            {t('planPanel.task.status.completed')}
                          </span>
                        )}
                      </div>

                      {checkpoint && (
                        <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-text-muted">
                          <span>
                            {t('planPanel.task.diffSummary', {
                              additions: checkpoint.additions,
                              deletions: checkpoint.deletions,
                            })}
                          </span>
                          <span>
                            {t('planPanel.task.evidence', { count: checkpoint.evidence.length })}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              disabled={busy || !api}
                              onClick={() =>
                                api && void run(() => api.startTask(sessionId, task.id))
                              }
                              className="rounded border border-border px-2 py-0.5 text-[10px] disabled:opacity-40"
                            >
                              {t('planPanel.task.start')}
                            </button>
                            <button
                              type="button"
                              disabled={busy || !api}
                              onClick={() => api && void run(() => api.acceptTask(sessionId, task.id))}
                              className="rounded border border-emerald-500/40 px-2 py-0.5 text-[10px] text-emerald-400 disabled:opacity-40"
                            >
                              {t('planPanel.task.accept')}
                            </button>
                            <button
                              type="button"
                              disabled={busy || !api}
                              onClick={() =>
                                api && void run(() => api.rejectTask(sessionId, task.id))
                              }
                              className="rounded border border-red-500/40 px-2 py-0.5 text-[10px] text-red-400 disabled:opacity-40"
                            >
                              {t('planPanel.task.reject')}
                            </button>
                            <button
                              type="button"
                              disabled={busy || !api}
                              onClick={() =>
                                api && void run(() => api.restoreTask(sessionId, task.id))
                              }
                              className="rounded border border-border px-2 py-0.5 text-[10px] disabled:opacity-40"
                            >
                              {t('planPanel.task.restore')}
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-secondary">
                  {t('planPanel.audit.title')}
                </span>
                <button
                  type="button"
                  disabled={busy || !api}
                  onClick={() => void run(exportAudit)}
                  className="flex items-center gap-1 rounded-lg border border-border px-3 py-1 text-xs text-text-secondary disabled:opacity-40"
                >
                  <Download className="h-3 w-3" />
                  {t('planPanel.actions.exportAudit')}
                </button>
              </div>
              {audit.length === 0 ? (
                <p className="text-xs text-text-muted">{t('planPanel.audit.empty')}</p>
              ) : (
                <ul className="max-h-56 space-y-1 overflow-y-auto">
                  {audit
                    .slice()
                    .reverse()
                    .map((entry) => (
                      <li key={entry.id} className="text-[11px] text-text-muted">
                        <span className="font-mono text-text-secondary">{entry.action}</span>{' '}
                        <span className="rounded border border-border px-1 py-0.5 text-[10px]">
                          {t('planPanel.audit.authorization.' + entry.authorization)}
                        </span>{' '}
                        {entry.justification}
                      </li>
                    ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>

      {busy && (
        <div className="flex items-center gap-2 border-t border-border-subtle px-6 py-2 text-xs text-text-muted">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('planPanel.working')}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-background/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="text-sm font-medium text-text-primary">{value}</div>
    </div>
  );
}
