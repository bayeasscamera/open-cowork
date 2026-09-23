/**
 * Settings -> Diagnostics: the single page that answers "why is the app not
 * working?".
 *
 * It composes three things the app already owns, instead of inventing a fourth
 * source of truth:
 *   - a main-process health report (credentials of the ConfigSet in effect,
 *     workspace, sandbox, storage, git),
 *   - the same global -> project -> session settings ladder the runner uses,
 *   - the API connection probe and the existing diagnostic bundle export.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Download,
  FolderOpen,
  RefreshCw,
  Stethoscope,
  XCircle,
} from 'lucide-react';
import type { DiagnosticResult, DiagnosticStepName } from '../../../shared/types';
import type { HealthCheck, HealthReport, HealthStatus } from '../../../shared/health-report';
import { resolveSettingsLadder, type SettingsLevel } from '../../../shared/settings-levels';
import { useAppStore } from '../../store';

const STATUS_STYLE: Record<HealthStatus, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  fail: 'border-red-500/40 bg-red-500/10 text-red-400',
};

const STATUS_ICON: Record<HealthStatus, typeof CheckCircle2> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
};

export function SettingsDiagnostics({ isActive = true }: { isActive?: boolean }) {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  const appConfig = useAppStore((s) => s.appConfig);
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);
  const activeSessionId = useAppStore((s) => s.activeSessionId);

  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [probe, setProbe] = useState<DiagnosticResult | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const session = useMemo(
    () => sessions.find((candidate) => candidate.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );
  const project = useMemo(
    () =>
      session?.projectId
        ? projects.find((candidate) => candidate.id === session.projectId) ?? null
        : null,
    [projects, session]
  );

  // The same resolver the agent runner uses: the page can never disagree with
  // what actually runs.
  const ladder = useMemo(
    () =>
      resolveSettingsLadder({
        global: {
          activeConfigSetId: appConfig?.activeConfigSetId ?? '',
          configSets: appConfig?.configSets ?? [],
        },
        project: project
          ? {
              id: project.id,
              name: project.name,
              configSetId: project.configSetId,
              modelId: project.modelId,
            }
          : null,
        session: { configSetId: session?.configSetId ?? null, modelId: session?.configModelId ?? null },
      }),
    [appConfig, project, session]
  );

  const refresh = useCallback(async () => {
    if (!api?.diagnostics) return;
    setLoading(true);
    try {
      setReport(await api.diagnostics.report(activeSessionId ?? null));
    } catch {
      setReport(null);
      setNotice(t('diagnostics.reportFailed'));
    } finally {
      setLoading(false);
    }
  }, [api, activeSessionId, t]);

  useEffect(() => {
    if (!isActive) return;
    void refresh();
  }, [isActive, refresh]);

  const runProbe = useCallback(async () => {
    if (!api?.config || !appConfig) return;
    setProbeBusy(true);
    setNotice(null);
    try {
      setProbe(
        await api.config.diagnose({
          provider: appConfig.provider,
          apiKey: appConfig.apiKey,
          baseUrl: appConfig.baseUrl,
          customProtocol: appConfig.customProtocol,
          model: ladder.model || appConfig.model,
          verificationLevel: 'fast',
        })
      );
    } catch {
      setProbe(null);
      setNotice(t('diagnostics.probeFailed'));
    } finally {
      setProbeBusy(false);
    }
  }, [api, appConfig, ladder.model, t]);

  const exportBundle = useCallback(async () => {
    if (!api?.logs) return;
    setNotice(null);
    try {
      const result = await api.logs.export();
      setNotice(
        result?.success
          ? t('diagnostics.bundleExported', { path: result.path ?? '' })
          : t('diagnostics.bundleFailed')
      );
    } catch {
      setNotice(t('diagnostics.bundleFailed'));
    }
  }, [api, t]);

  const overall: HealthStatus = report?.status ?? 'warn';
  const OverallIcon = STATUS_ICON[overall];

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-2xl border border-border-muted bg-surface/60 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span
              className={
                'mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg border ' +
                STATUS_STYLE[overall]
              }
            >
              <OverallIcon className="h-4 w-4" />
            </span>
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <Stethoscope className="h-4 w-4" />
                {t('diagnostics.overall.' + overall)}
              </h3>
              <p className="text-xs text-text-muted">{t('diagnostics.subtitle')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary disabled:opacity-50"
          >
            <RefreshCw className={'h-3.5 w-3.5' + (loading ? ' animate-spin' : '')} />
            {loading ? t('diagnostics.running') : t('diagnostics.refresh')}
          </button>
        </div>

        {report && (
          <ul className="flex flex-col divide-y divide-border-subtle" data-testid="diagnostics-checks">
            {report.checks.map((check: HealthCheck) => {
              const Icon = STATUS_ICON[check.status];
              return (
                <li key={check.id} className="flex items-start gap-3 py-2" data-check={check.id}>
                  <Icon
                    className={
                      'mt-0.5 h-4 w-4 shrink-0 ' +
                      (check.status === 'ok'
                        ? 'text-emerald-400'
                        : check.status === 'warn'
                          ? 'text-amber-400'
                          : 'text-red-400')
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-text-primary">
                      {t('diagnostics.check.' + check.id)}
                    </div>
                    <div className="text-[11px] text-text-muted">
                      {t('diagnostics.checkDetail.' + check.id)}
                    </div>
                    {check.status !== 'ok' && (
                      <div className="mt-0.5 text-[11px] text-amber-400">
                        {t('diagnostics.fix.' + check.id)}
                      </div>
                    )}
                  </div>
                  <div className="max-w-[16rem] truncate font-mono text-[11px] text-text-secondary">
                    {check.detail ?? ''}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-2xl border border-border-muted bg-surface/60 p-4">
        <h3 className="text-sm font-semibold text-text-primary">
          {t('diagnostics.effectiveTitle')}
        </h3>
        <div className="font-mono text-xs text-text-primary">
          {[ladder.configSetName, ladder.provider, ladder.model].filter(Boolean).join(' · ') ||
            t('settingsLevels.none')}
        </div>
        <div className="text-[11px] text-text-muted">
          {t('diagnostics.decidedAt', {
            configSet: t('settingsLevels.level.' + ladder.configSetLevel),
            model: t('settingsLevels.level.' + ladder.modelLevel),
          })}
        </div>
        {ladder.warnings.map((warning) => (
          <div
            key={warning.code + warning.level}
            className="text-[11px] text-amber-400"
          >
            {t('settingsLevels.warning.' + warning.code, {
              level: t('settingsLevels.level.' + (warning.level as SettingsLevel)),
              value: warning.value ?? '',
            })}
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3 rounded-2xl border border-border-muted bg-surface/60 p-4">
        <h3 className="text-sm font-semibold text-text-primary">{t('diagnostics.actions')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void runProbe()}
            disabled={probeBusy || !appConfig}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary disabled:opacity-50"
          >
            <Stethoscope className="h-3.5 w-3.5" />
            {probeBusy ? t('diagnostics.running') : t('diagnostics.probe')}
          </button>
          <button
            type="button"
            onClick={() => void exportBundle()}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary"
          >
            <Download className="h-3.5 w-3.5" />
            {t('diagnostics.exportBundle')}
          </button>
          <button
            type="button"
            onClick={() => void api?.logs?.open?.()}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t('diagnostics.openLogs')}
          </button>
        </div>

        {probe && (
          <div
            className={
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ' +
              STATUS_STYLE[probe.overallOk ? 'ok' : 'fail']
            }
            data-testid="diagnostics-probe"
          >
            {probe.overallOk ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            <span>
              {probe.overallOk
                ? t('diagnostics.probeOk', { ms: probe.totalLatencyMs })
                : t('diagnostics.probeFail', {
                    step: t('diagnostics.step.' + (probe.failedAt ?? ('auth' as DiagnosticStepName))),
                    ms: probe.totalLatencyMs,
                  })}
            </span>
          </div>
        )}

        {notice && (
          <p className="flex items-center gap-2 text-[11px] text-text-muted">
            <CircleSlash className="h-3.5 w-3.5" />
            {notice}
          </p>
        )}
      </section>
    </div>
  );
}
