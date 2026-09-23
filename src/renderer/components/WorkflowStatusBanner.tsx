/**
 * Cowork 4.0 — global workflow status banner.
 *
 * Always-visible strip reflecting the Plan -> Act -> Verify phase of the
 * active session, so execution progress is readable without opening the plan
 * panel. State, per-task results and throttled live budget updates are pushed
 * from the main process; a one-shot fetch covers snapshots restored before the
 * renderer window existed.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronRight, Loader2, X } from 'lucide-react';
import type { WorkflowPhase } from '../../shared/workflow-types';
import { useAppStore } from '../store';

const PHASE_STYLES: Record<WorkflowPhase, string> = {
  idle: 'border-border bg-background text-text-secondary',
  exploring: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  planning: 'border-sky-500/40 bg-sky-500/10 text-sky-400',
  'awaiting-approval': 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  executing: 'border-accent bg-accent/10 text-text-primary',
  verifying: 'border-violet-500/40 bg-violet-500/10 text-violet-400',
  completed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  failed: 'border-red-500/40 bg-red-500/10 text-red-400',
  cancelled: 'border-border bg-background text-text-muted',
};

/** Phases that mean work is in flight and deserve a spinner. */
const ACTIVE_PHASES: WorkflowPhase[] = [
  'exploring',
  'planning',
  'awaiting-approval',
  'executing',
  'verifying',
];

/** Compact token counts: 950, 12.4k, 1.3M. */
function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return (count / 1_000_000).toFixed(1) + 'M';
  }
  if (count >= 1_000) {
    return (count / 1_000).toFixed(1) + 'k';
  }
  return String(count);
}

export function WorkflowStatusBanner({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const state = useAppStore((s) => s.workflowStates[sessionId] ?? null);
  const results = useAppStore((s) => s.workflowTaskResults[sessionId] ?? null);
  const progress = useAppStore((s) => s.workflowTaskProgress[sessionId] ?? null);
  const setWorkflowState = useAppStore((s) => s.setWorkflowState);
  const setPlanPanelVisible = useAppStore((s) => s.setPlanPanelVisible);
  const planPanelVisible = useAppStore((s) => s.planPanelVisible);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  // Re-fetch on session switch so a restored workflow is not invisible, and
  // reset the dismissal so the banner returns for the newly selected session.
  useEffect(() => {
    setDismissedAt(null);
    const api = typeof window !== 'undefined' ? window.electronAPI?.workflow : undefined;
    if (!api) {
      return;
    }
    let cancelled = false;
    void api
      .getState(sessionId)
      .then((next) => {
        if (!cancelled && next) {
          setWorkflowState(sessionId, next);
        }
      })
      .catch(() => {
        // Best-effort: the plan panel surfaces load errors to the user.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, setWorkflowState]);

  // Finished results win over live progress: a task that already reported its
  // final usage must not be counted twice.
  const { totalTokens, totalCostUsd } = useMemo(() => {
    let tokens = 0;
    let cost = 0;
    if (results) {
      for (const result of Object.values(results)) {
        tokens += result.tokens ?? 0;
        cost += result.costUsd ?? 0;
      }
    }
    if (progress) {
      for (const entry of Object.values(progress)) {
        if (results && results[entry.taskId]) {
          continue;
        }
        tokens += entry.tokens;
        cost += entry.costUsd;
      }
    }
    return { totalTokens: tokens, totalCostUsd: cost };
  }, [results, progress]);

  if (!state || !state.contractId) {
    return null;
  }
  if (dismissedAt !== null && state.updatedAt <= dismissedAt) {
    return null;
  }

  const total = state.tasks.length;
  const done = state.completedTaskIds.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const active = ACTIVE_PHASES.includes(state.phase);
  const blocked = state.blockers.length > 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className={'flex items-center gap-3 border-b px-4 py-2 text-xs ' + PHASE_STYLES[state.phase]}
    >
      {active && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
      {!active && blocked && <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
      <span className="shrink-0 font-medium">{t('planPanel.phase.' + state.phase)}</span>
      {state.objective && (
        <span className="min-w-0 truncate text-text-secondary" title={state.objective}>
          {state.objective}
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {total > 0 && (
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-border">
              <span
                className="block h-full rounded-full bg-current"
                style={{ width: percent + '%' }}
              />
            </span>
            <span className="tabular-nums">
              {t('workflowBanner.progress', { done, total })}
            </span>
          </span>
        )}

        {totalTokens > 0 && (
          <span className="tabular-nums text-text-secondary">
            {t('workflowBanner.tokens', { tokens: formatTokens(totalTokens) })}
          </span>
        )}

        {totalCostUsd > 0 && (
          <span className="tabular-nums text-text-secondary">
            {'$' + totalCostUsd.toFixed(4)}
          </span>
        )}

        {blocked && (
          <span className="flex items-center gap-1 text-red-400">
            <AlertTriangle className="h-3 w-3" />
            {t('workflowBanner.blockers', { count: state.blockers.length })}
          </span>
        )}

        {!planPanelVisible && (
          <button
            type="button"
            onClick={() => setPlanPanelVisible(true)}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 font-medium hover:bg-surface-hover"
          >
            {t('workflowBanner.open')}
            <ChevronRight className="h-3 w-3" />
          </button>
        )}

        <button
          type="button"
          onClick={() => setDismissedAt(state.updatedAt)}
          aria-label={t('workflowBanner.dismiss')}
          className="opacity-60 hover:opacity-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
