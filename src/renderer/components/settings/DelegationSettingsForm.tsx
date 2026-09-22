import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import {
  buildConfigSetLites,
  ConfigSetModelPicker,
} from '../shared/ConfigSetModelPicker';
import type { DelegationSettings } from '../../types';

/**
 * The delegation-mode settings form — ONE implementation used by both the
 * central Sub-agents settings screen (section 3) and the tracking panel's
 * gear, so the two can never drift. Persists via backgroundTasks.setSettings.
 */
export function DelegationSettingsForm({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const appConfig = useAppStore((s) => s.appConfig);
  const [settings, setSettings] = useState<DelegationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.electronAPI.backgroundTasks.getSettings();
        if (!cancelled && result.success && result.settings) setSettings(result.settings);
      } catch {
        // leave the form hidden on failure
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (next: Omit<Partial<DelegationSettings>, 'modelId'> & { modelId?: string | null }) => {
      const result = await window.electronAPI.backgroundTasks.setSettings(next);
      if (result.success && result.settings) {
        setSettings(result.settings);
        setError(null);
      } else {
        setError(result.error ?? t('delegatedTasks.actionsError'));
      }
    },
    [t]
  );

  if (!settings) return null;

  const timeoutSeconds = Math.round(settings.timeoutMs / 1000);

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <ConfigSetModelPicker
        sets={buildConfigSetLites(appConfig ?? {})}
        value={{ configSetId: settings.configSetId, modelId: settings.modelId }}
        onChange={(next) =>
          void save({ configSetId: next.configSetId, modelId: next.modelId ?? null })
        }
        configSetLabel={t('subAgents.delegationProfile')}
        modelLabel={t('subAgents.model')}
        allowEmpty
        emptyLabel={t('delegatedTasks.inheritActive')}
        inputClassName="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
      />
      <div className={compact ? '' : 'grid gap-4 sm:grid-cols-2'}>
        <label className="block text-sm text-text-secondary">
          {t('delegatedTasks.timeout')}
          <input
            type="number"
            min={10}
            max={900}
            step={10}
            value={timeoutSeconds}
            onChange={(e) =>
              setSettings({ ...settings, timeoutMs: Number(e.target.value) * 1000 })
            }
            onBlur={(e) => void save({ timeoutMs: Number(e.target.value) * 1000 })}
            className={`${compact ? 'mt-1' : 'mt-1'} w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none`}
          />
        </label>
        <label className="block text-sm text-text-secondary">
          {t('delegatedTasks.maxConcurrent')}
          <select
            value={settings.maxConcurrent}
            onChange={(e) => void save({ maxConcurrent: Number(e.target.value) })}
            className={`${compact ? 'mt-1' : 'mt-1'} w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none`}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={settings.notifyOnCompletion}
          onChange={(e) => void save({ notifyOnCompletion: e.target.checked })}
        />
        {t('delegatedTasks.notify')}
      </label>
      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={settings.resumeOnRestart}
          onChange={(e) => void save({ resumeOnRestart: e.target.checked })}
        />
        {t('delegatedTasks.resumeOnRestart')}
      </label>
      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={settings.detachedExecution}
          onChange={(e) => void save({ detachedExecution: e.target.checked })}
        />
        {t('delegatedTasks.detachedExecution')}
      </label>
      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          checked={settings.detachedAutoApprove}
          onChange={(e) => void save({ detachedAutoApprove: e.target.checked })}
        />
        {t('delegatedTasks.detachedAutoApprove')}
      </label>
      {settings.detachedExecution && !settings.detachedAutoApprove && (
        <p className="text-xs text-amber-500">{t('delegatedTasks.detachedHint')}</p>
      )}
      {settings.detachedAutoApprove && (
        <p className="text-xs text-rose-500">{t('delegatedTasks.detachedAutoApproveWarning')}</p>
      )}
      {error && (
        <p className="text-xs text-rose-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}