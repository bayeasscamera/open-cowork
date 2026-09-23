/**
 * Cowork 4.0 — Lot A: Execution Report Panel.
 *
 * Displays the WorkflowExecutionReport produced by executePlan(): per-task
 * status, verification outcome, aggregated cost/tokens/duration, and any
 * remaining (unexecuted) tasks.
 */

import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Coins,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type {
  TaskRunResult,
  VerificationReport,
  WorkflowExecutionReport,
  WorkflowPhase,
} from '../../shared/workflow-types';

interface ExecutionReportPanelProps {
  report: WorkflowExecutionReport | null;
  totalTasks: number;
}

function phaseColor(phase: WorkflowPhase): string {
  switch (phase) {
    case 'completed':
      return 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10';
    case 'failed':
      return 'text-red-400 border-red-500/40 bg-red-500/10';
    case 'executing':
      return 'text-blue-400 border-blue-500/40 bg-blue-500/10';
    default:
      return 'text-text-secondary border-border bg-background/60';
  }
}

function statusIcon(status: TaskRunResult['status']): JSX.Element {
  switch (status) {
    case 'succeeded':
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
    case 'failed':
    case 'budget-exceeded':
      return <XCircle className="h-3.5 w-3.5 text-red-400" />;
    case 'forbidden':
    case 'skipped':
    case 'cancelled':
      return <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />;
    default:
      return <Clock className="h-3.5 w-3.5 text-text-muted" />;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return ms + 'ms';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return minutes + 'm ' + remaining + 's';
}

export function ExecutionReportPanel({ report, totalTasks }: ExecutionReportPanelProps) {
  const { t } = useTranslation();

  if (!report || !report.started) {
    return (
      <section className="space-y-2">
        <span className="text-xs font-medium text-text-secondary">{t('planPanel.report.title')}</span>
        <div className="rounded-xl border border-border-subtle bg-background/60 px-4 py-6 text-center">
          <p className="text-sm text-text-secondary">{t('planPanel.report.empty')}</p>
        </div>
      </section>
    );
  }

  const succeeded = report.results.filter((r) => r.status === 'succeeded').length;
  const failed = report.failedTaskIds.length;
  const totalCost = report.results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const totalTokens = report.results.reduce((sum, r) => sum + (r.tokens ?? 0), 0);
  const totalDuration = report.results.reduce(
    (sum, r) => sum + Math.max(0, r.finishedAt - r.startedAt),
    0
  );
  const remaining = totalTasks - report.results.length;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-secondary">{t('planPanel.report.title')}</span>
        <span
          className={
            'rounded-full border px-2 py-0.5 text-[10px] font-medium ' + phaseColor(report.phase)
          }
        >
          {t('planPanel.report.phase')}: {report.phase}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricCard
          icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
          label={t('planPanel.report.succeeded', { count: succeeded })}
        />
        <MetricCard
          icon={<XCircle className="h-3.5 w-3.5 text-red-400" />}
          label={t('planPanel.report.failed', { count: failed })}
        />
        <MetricCard
          icon={<Coins className="h-3.5 w-3.5 text-amber-400" />}
          label={t('planPanel.report.totalCost')}
          value={totalCost > 0 ? '$' + totalCost.toFixed(4) : '\u2014'}
        />
        <MetricCard
          icon={<Clock className="h-3.5 w-3.5 text-blue-400" />}
          label={t('planPanel.report.totalDuration')}
          value={formatDuration(totalDuration)}
        />
      </div>

      {totalTokens > 0 && (
        <div className="rounded-lg border border-border-subtle bg-background/60 px-3 py-1.5 text-[11px] text-text-muted">
          {t('planPanel.report.totalTokens')}: {totalTokens.toLocaleString()}
        </div>
      )}

      {report.verification && (
        <VerificationBadge verification={report.verification} />
      )}

      <ul className="space-y-1.5 max-h-64 overflow-y-auto">
        {report.results.map((res) => (
          <li
            key={res.taskId}
            className="flex items-start gap-2 rounded-lg border border-border-subtle bg-background/60 px-3 py-2"
          >
            <span className="mt-0.5 shrink-0">{statusIcon(res.status)}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-text-primary truncate">
                  {res.taskId}
                </span>
                <span className="rounded border border-border px-1 py-0.5 text-[9px] text-text-muted">
                  {res.role}
                </span>
                <span className="text-[10px] text-text-muted">
                  {t('planPanel.report.taskStatus.' + res.status)}
                </span>
              </div>
              {res.summary && (
                <p className="mt-0.5 text-[11px] text-text-muted line-clamp-2">
                  {res.summary}
                </p>
              )}
              {res.error && (
                <p className="mt-0.5 text-[11px] text-red-400 line-clamp-2">
                  {res.error}
                </p>
              )}
              <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-text-muted">
                <span>{formatDuration(res.durationMs)}</span>
                <span>{res.toolCalls} tool calls</span>
                {res.tokens !== undefined && <span>{res.tokens} tokens</span>}
                {res.costUsd !== undefined && (
                  <span>${res.costUsd.toFixed(4)}</span>
                )}
                {res.isolated && <span>isolated</span>}
                {res.recovered && (
                  <span className="text-emerald-400">
                    {t('planPanel.report.recovered', { count: res.attempts })}
                  </span>
                )}
                {res.evidenceKinds.length > 0 && (
                  <span>evidence: {res.evidenceKinds.join(', ')}</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {remaining > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {t('planPanel.report.remaining')}: {remaining}
        </div>
      )}
      {remaining === 0 && report.results.length > 0 && (
        <p className="text-[11px] text-text-muted">
          {t('planPanel.report.noRemaining')}
        </p>
      )}
    </section>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: JSX.Element;
  label: string;
  value?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-background/60 px-3 py-2">
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] text-text-muted truncate">{label}</div>
        {value && <div className="text-xs font-medium text-text-primary">{value}</div>}
      </div>
    </div>
  );
}

function VerificationBadge({ verification }: { verification: VerificationReport }) {
  const { t } = useTranslation();
  const ok = verification.ok;
  const missing = verification.missing;

  return (
    <div
      className={
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ' +
        (ok
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
          : 'border-red-500/40 bg-red-500/10 text-red-400')
      }
    >
      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div>
        <span className="font-medium">
          {ok
            ? t('planPanel.report.verified')
            : t('planPanel.report.unverified', { count: missing.length })}
        </span>
        {!ok && missing.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-[11px] opacity-80">
            {missing.map((item: string) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
