import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsContentSection } from './shared';

interface DoctorEntry {
  name: string;
  path: string;
  tokenEstimate: number;
  useCount: number;
  lastUsedAt: number | null;
  recommendation: 'disable' | 'keep';
}

interface DoctorReport {
  entries: DoctorEntry[];
  totalSkillTokens: number;
  contextWindow: number | null;
}

/**
 * `/skill doctor` — local context-cost analyzer for loaded skills. All data is
 * computed in the main process from local files; nothing leaves the machine.
 */
export function SettingsSkillDoctor() {
  const { t } = useTranslation();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const run = useCallback(async () => {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.skillsDoctor();
      if (id !== requestId.current) return;
      if (!result.success || !result.report) {
        setError('failed');
        return;
      }
      setReport(result.report);
    } catch {
      if (id === requestId.current) setError('failed');
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run();
    return () => {
      requestId.current += 1;
    };
  }, [run]);

  const percent =
    report && report.contextWindow
      ? Math.min(100, Math.round((report.totalSkillTokens / report.contextWindow) * 100))
      : null;

  return (
    <SettingsContentSection title={t('skillDoctor.title')} description={t('skillDoctor.description')}>
      <div className="space-y-3 rounded-xl border border-border-muted bg-background-secondary/60 p-4" aria-busy={busy}>
        <div className="flex items-center justify-between gap-3">
          {report && (
            <p className="text-xs text-text-muted">
              {t('skillDoctor.total', {
                tokens: report.totalSkillTokens.toLocaleString(),
                percent: percent !== null ? `(${percent}%)` : '',
              })}
            </p>
          )}
          <button
            className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
            onClick={() => {
              void run();
            }}
          >
            {t('skillDoctor.refresh')}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-rose-500">{t(`skillDoctor.${error}`)}</p>
        )}
        {!error && report && report.entries.length === 0 && (
          <p className="text-sm text-text-muted">{t('skillDoctor.empty')}</p>
        )}
        {report && report.entries.length > 0 && (
          <div role="table" aria-label={t('skillDoctor.table')} className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="py-1 pr-2 font-medium">{t('skillDoctor.skill')}</th>
                  <th className="py-1 pr-2 font-medium">{t('skillDoctor.tokens')}</th>
                  <th className="py-1 pr-2 font-medium">{t('skillDoctor.uses')}</th>
                  <th className="py-1 font-medium">{t('skillDoctor.recommendation')}</th>
                </tr>
              </thead>
              <tbody>
                {report.entries.map((entry) => (
                  <tr key={entry.path} className="border-t border-border-muted text-text-secondary">
                    <td className="break-all py-1.5 pr-2">{entry.name}</td>
                    <td className="py-1.5 pr-2 font-mono">{entry.tokenEstimate.toLocaleString()}</td>
                    <td className="py-1.5 pr-2 font-mono">
                      {entry.useCount}
                      {entry.lastUsedAt
                        ? ` · ${new Date(entry.lastUsedAt).toLocaleDateString()}`
                        : ` · ${t('skillDoctor.never')}`}
                    </td>
                    <td className="py-1.5">
                      {entry.recommendation === 'disable'
                        ? t('skillDoctor.considerDisabling')
                        : t('skillDoctor.keep')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SettingsContentSection>
  );
}