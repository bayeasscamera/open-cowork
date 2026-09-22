import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon } from 'lucide-react';
import { useAppStore } from '../../store';
import { buildConfigSetLites, ConfigSetModelPicker } from '../shared/ConfigSetModelPicker';
import { SettingsContentSection } from './shared';

const DEFAULT_COST_THRESHOLD_USD = 0.05;

/**
 * Dedicated IMAGES profile: read (vision) and generation share one picker.
 *
 * Image models are billed per image rather than per token, so they get their
 * own ConfigSet selection here instead of silently inheriting the chat model.
 * Reuses the exact ConfigSetModelPicker component the sub-agents and projects
 * screens use, so the three can never drift apart.
 */
export function SettingsImages() {
  const { t } = useTranslation();
  const appConfig = useAppStore((state) => state.appConfig);
  const setAppConfig = useAppStore((state) => state.setAppConfig);
  const imageConfig = appConfig?.imageGeneration;
  const [thresholdDraft, setThresholdDraft] = useState<string>('');
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const persisted = imageConfig?.costConfirmThresholdUsd ?? DEFAULT_COST_THRESHOLD_USD;
    setThresholdDraft(String(persisted));
  }, [imageConfig?.costConfirmThresholdUsd]);

  const save = async (next: {
    configSetId: string;
    modelId?: string;
    costConfirmThresholdUsd?: number;
  }) => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.config.save({ imageGeneration: next });
      if (!result.success || !result.config) {
        setStatus('error');
        return;
      }
      setAppConfig(result.config);
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      setBusy(false);
    }
  };

  const current = {
    configSetId: imageConfig?.configSetId ?? '',
    modelId: imageConfig?.modelId,
    costConfirmThresholdUsd:
      imageConfig?.costConfirmThresholdUsd ?? DEFAULT_COST_THRESHOLD_USD,
  };

  const commitThreshold = () => {
    const parsed = Number(thresholdDraft);
    const next = Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 100) : current.costConfirmThresholdUsd;
    setThresholdDraft(String(next));
    if (next !== current.costConfirmThresholdUsd) {
      void save({ ...current, costConfirmThresholdUsd: next });
    }
  };

  return (
    <SettingsContentSection title={t('api.images.title')} description={t('api.images.description')}>
      <div className="settings-card space-y-3 p-4">
        <ConfigSetModelPicker
          sets={buildConfigSetLites(appConfig ?? {})}
          value={{ configSetId: current.configSetId, modelId: current.modelId }}
          onChange={(next) =>
            void save({
              configSetId: next.configSetId,
              modelId: next.modelId,
              costConfirmThresholdUsd: current.costConfirmThresholdUsd,
            })
          }
          configSetLabel={t('api.images.profileLabel')}
          modelLabel={t('subAgents.model')}
          allowEmpty
          emptyLabel={t('api.images.inheritActive')}
          disabled={busy}
          inputClassName="rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
        />
        <p className="text-xs leading-5 text-text-muted">{t('api.images.modelHint')}</p>
        <label className="block text-sm text-text-secondary">
          <span className="flex items-center gap-2 text-xs text-text-muted">
            <ImageIcon aria-hidden="true" className="w-3.5 h-3.5" />
            {t('api.images.costThresholdLabel')}
          </span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={thresholdDraft}
            disabled={busy}
            onChange={(event) => setThresholdDraft(event.target.value)}
            onBlur={commitThreshold}
            className="mt-1 w-40 rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        </label>
        <p className="text-xs leading-5 text-text-muted">{t('api.images.costThresholdHint')}</p>
        {status && (
          <p
            className={status === 'error' ? 'text-xs text-rose-500' : 'text-xs text-text-muted'}
            role="status"
          >
            {status === 'error' ? t('api.images.error') : t('api.images.saved')}
          </p>
        )}
      </div>
    </SettingsContentSection>
  );
}
