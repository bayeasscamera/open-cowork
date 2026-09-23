import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlaskConical, Route, Trash2 } from 'lucide-react';
import type {
  MetricsDelta,
  RoutingValidationReport,
  ScenarioSuiteResult,
} from '../../shared/metrics-types';

/** Formats a 0..1 ratio as a whole percentage. */
const asPercent = (value: number): string => Math.round(value * 100) + '%';

const asUsd = (value: number): string => '$' + value.toFixed(4);

const asMs = (value: number): string => Math.round(value) + ' ms';

/**
 * Signed delta. The harness reports every axis so that a positive number
 * means the candidate improved, which keeps the colour mapping simple.
 */
const asDelta = (value: number): string => (value > 0 ? '+' : '') + value.toFixed(3);

const deltaClass = (value: number): string => {
  if (value < 0) {
    return 'text-red-400';
  }
  if (value > 0) {
    return 'text-emerald-400';
  }
  return 'text-text-muted';
};

/**
 * Cowork 4.0 — Phase 5.5 / 7.5: the reference-scenario harness. The metrics
 * channels existed but nothing rendered them, so the measured success rate,
 * cost and regressions stayed invisible. This pane surfaces the stored suites,
 * the delta between the last two runs and the end-to-end routing validation.
 */
export function EvalPanel() {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI?.metrics : undefined;
  const [history, setHistory] = useState<ScenarioSuiteResult[]>([]);
  const [delta, setDelta] = useState<MetricsDelta | null>(null);
  const [routing, setRouting] = useState<RoutingValidationReport | null>(null);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      setHistory(await api.history());
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runSuite = useCallback(async () => {
    if (!api || busy) {
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const label = version.trim();
      await api.runSuite(label.length > 0 ? label : undefined);
      setError(null);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, busy, refresh, version]);

  const compare = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      setDelta(await api.compare());
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  const validateRouting = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      setRouting(await api.validateRouting());
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  const clearHistory = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const result = await api.clearHistory();
      setDelta(null);
      setNotice(t('evalPanel.cleared', { count: result.cleared }));
      setError(null);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, refresh, t]);

  const latest = history.length > 0 ? history[history.length - 1] : null;
  const failingCases = routing?.outcomes.filter((outcome) => !outcome.ok).length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      {!api && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {t('evalPanel.unavailable')}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-border-subtle bg-background/60 px-3 py-2 text-xs text-text-secondary">
          {notice}
        </div>
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-medium text-text-secondary">{t('evalPanel.title')}</h3>
        <p className="text-[11px] text-text-muted">{t('evalPanel.hint')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            placeholder={t('evalPanel.versionPlaceholder')}
            aria-label={t('evalPanel.version')}
            className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-text-primary"
          />
          <button
            type="button"
            disabled={!api || busy}
            onClick={() => void runSuite()}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs text-text-secondary disabled:opacity-40"
          >
            <FlaskConical className="h-3.5 w-3.5" />
            {busy ? t('evalPanel.running') : t('evalPanel.run')}
          </button>
          <button
            type="button"
            disabled={!api || history.length < 2}
            onClick={() => void compare()}
            className="rounded-lg border border-border px-2 py-1 text-xs text-text-secondary disabled:opacity-40"
          >
            {t('evalPanel.compare')}
          </button>
          <button
            type="button"
            disabled={!api}
            onClick={() => void validateRouting()}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs text-text-secondary disabled:opacity-40"
          >
            <Route className="h-3.5 w-3.5" />
            {t('evalPanel.validateRouting')}
          </button>
          <button
            type="button"
            disabled={!api || history.length === 0}
            onClick={() => void clearHistory()}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs text-text-secondary disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('evalPanel.clear')}
          </button>
        </div>
      </section>

      {latest === null ? (
        <p className="text-xs text-text-muted">{t('evalPanel.empty')}</p>
      ) : (
        <section className="space-y-2">
          <h3 className="text-xs font-medium text-text-secondary">
            {t('evalPanel.summary.title', { version: latest.version })}
          </h3>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
            <span>{t('evalPanel.summary.runs', { count: latest.summary.runs })}</span>
            <span>
              {t('evalPanel.summary.successRate', { percent: asPercent(latest.summary.successRate) })}
            </span>
            <span>
              {t('evalPanel.summary.avgTurns', { value: latest.summary.avgTurns.toFixed(1) })}
            </span>
            <span>{t('evalPanel.summary.avgCost', { value: asUsd(latest.summary.avgCostUsd) })}</span>
            <span>
              {t('evalPanel.summary.avgDuration', { value: asMs(latest.summary.avgDurationMs) })}
            </span>
            <span>
              {t('evalPanel.summary.regressionRate', {
                percent: asPercent(latest.summary.regressionRate),
              })}
            </span>
            <span>
              {t('evalPanel.summary.humanInterventionRate', {
                percent: asPercent(latest.summary.humanInterventionRate),
              })}
            </span>
            <span>
              {t('evalPanel.summary.avgEvidence', { value: latest.summary.avgEvidence.toFixed(1) })}
            </span>
          </div>
        </section>
      )}

      {latest !== null && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-text-secondary">{t('evalPanel.records.title')}</h3>
          <ul className="space-y-1.5">
            {latest.records.map((record) => (
              <li
                key={record.scenarioId}
                className="rounded-lg border border-border-subtle bg-background/60 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-xs text-text-primary">{record.scenarioId}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                    {t('evalPanel.kind.' + record.kind)}
                  </span>
                  <span
                    className={
                      'text-[10px] ' +
                      (record.metrics.success ? 'text-emerald-400' : 'text-red-400')
                    }
                  >
                    {record.metrics.success
                      ? t('evalPanel.records.success')
                      : t('evalPanel.records.failed')}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-text-muted">
                  <span>{t('evalPanel.records.turns', { value: record.metrics.turns })}</span>
                  <span>{t('evalPanel.records.cost', { value: asUsd(record.metrics.costUsd) })}</span>
                  <span>
                    {t('evalPanel.records.regressions', { value: record.metrics.regressions })}
                  </span>
                  <span>
                    {t('evalPanel.records.interventions', {
                      value: record.metrics.humanInterventions,
                    })}
                  </span>
                  <span>{t('evalPanel.records.evidence', { value: record.metrics.evidenceCount })}</span>
                </div>
                {record.error && <p className="mt-1 text-[10px] text-red-400">{record.error}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {delta && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-text-secondary">{t('evalPanel.delta.title')}</h3>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
            <span className={deltaClass(delta.successRate)}>
              {t('evalPanel.delta.successRate', { value: asDelta(delta.successRate) })}
            </span>
            <span className={deltaClass(delta.avgTurns)}>
              {t('evalPanel.delta.avgTurns', { value: asDelta(delta.avgTurns) })}
            </span>
            <span className={deltaClass(delta.avgCostUsd)}>
              {t('evalPanel.delta.avgCost', { value: asDelta(delta.avgCostUsd) })}
            </span>
            <span className={deltaClass(delta.avgDurationMs)}>
              {t('evalPanel.delta.avgDuration', { value: asDelta(delta.avgDurationMs) })}
            </span>
            <span className={deltaClass(delta.regressionRate)}>
              {t('evalPanel.delta.regressionRate', { value: asDelta(delta.regressionRate) })}
            </span>
            <span className={deltaClass(delta.humanInterventionRate)}>
              {t('evalPanel.delta.humanInterventionRate', {
                value: asDelta(delta.humanInterventionRate),
              })}
            </span>
          </div>
          <p
            className={
              'text-[11px] ' + (delta.noRegression ? 'text-emerald-400' : 'text-amber-400')
            }
          >
            {delta.noRegression ? t('evalPanel.delta.noRegression') : t('evalPanel.delta.regression')}
          </p>
        </section>
      )}

      {routing && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-text-secondary">{t('evalPanel.routing.title')}</h3>
          <p className={'text-[11px] ' + (routing.ok ? 'text-emerald-400' : 'text-red-400')}>
            {routing.ok
              ? t('evalPanel.routing.ok')
              : t('evalPanel.routing.failed', { count: failingCases })}
          </p>
          <ul className="space-y-1">
            {routing.outcomes.map((outcome) => (
              <li key={outcome.caseId} className="flex items-center gap-2 text-[10px] text-text-muted">
                <span className="flex-1 truncate">{outcome.caseId}</span>
                <span className={outcome.ok ? 'text-emerald-400' : 'text-red-400'}>
                  {outcome.ok ? t('evalPanel.routing.caseOk') : t('evalPanel.routing.caseFailed')}
                </span>
                {outcome.violations.length > 0 && (
                  <span className="text-amber-400">
                    {t('evalPanel.routing.violations', { count: outcome.violations.length })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
