import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image as ImageIcon } from 'lucide-react';
import { useAppStore } from '../../store';
import { buildConfigSetLites, ConfigSetModelPicker } from '../shared/ConfigSetModelPicker';
import { SettingsContentSection } from './shared';
import type { CustomProtocolType, ProviderType } from '../../types';

const DEFAULT_COST_THRESHOLD_USD = 0.05;

/** How the images profile gets its provider. */
type ImageSourceMode = 'inherit' | 'configset' | 'custom';

const PROVIDER_OPTIONS: Array<{ id: ProviderType; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'custom', label: 'Custom' },
];

const PROTOCOL_OPTIONS: Array<{ id: CustomProtocolType; label: string }> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'anthropic', label: 'Anthropic' },
];

interface ImageSettingsDraft {
  configSetId: string;
  modelId?: string;
  costConfirmThresholdUsd: number;
  provider?: ProviderType;
  customProtocol?: CustomProtocolType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none';

/**
 * Dedicated IMAGES profile: read (vision) and generation share one picker.
 *
 * Three sources, in precedence order:
 *   - Inherit the active profile (zero config)
 *   - A ConfigSet (reuses the same picker as sub-agents/projects)
 *   - ANY provider, with its own key/base URL/model — so image models can run
 *     on a vendor that has no text ConfigSet, or on a self-hosted
 *     OpenAI/Gemini/Anthropic-compatible endpoint.
 */
export function SettingsImages() {
  const { t } = useTranslation();
  const appConfig = useAppStore((state) => state.appConfig);
  const setAppConfig = useAppStore((state) => state.setAppConfig);
  const imageConfig = appConfig?.imageGeneration;
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  const [busy, setBusy] = useState(false);
  const [thresholdDraft, setThresholdDraft] = useState<string>('');
  const [customDraft, setCustomDraft] = useState({
    provider: 'openai' as ProviderType,
    customProtocol: 'openai' as CustomProtocolType,
    baseUrl: '',
    apiKey: '',
    model: '',
  });

  useEffect(() => {
    setThresholdDraft(
      String(imageConfig?.costConfirmThresholdUsd ?? DEFAULT_COST_THRESHOLD_USD)
    );
  }, [imageConfig?.costConfirmThresholdUsd]);

  useEffect(() => {
    setCustomDraft({
      provider: imageConfig?.provider ?? 'openai',
      customProtocol: imageConfig?.customProtocol ?? 'openai',
      baseUrl: imageConfig?.baseUrl ?? '',
      apiKey: imageConfig?.apiKey ?? '',
      model: imageConfig?.model ?? '',
    });
  }, [
    imageConfig?.provider,
    imageConfig?.customProtocol,
    imageConfig?.baseUrl,
    imageConfig?.apiKey,
    imageConfig?.model,
  ]);

  const current: ImageSettingsDraft = {
    configSetId: imageConfig?.configSetId ?? '',
    modelId: imageConfig?.modelId,
    costConfirmThresholdUsd:
      imageConfig?.costConfirmThresholdUsd ?? DEFAULT_COST_THRESHOLD_USD,
    provider: imageConfig?.provider,
    customProtocol: imageConfig?.customProtocol,
    apiKey: imageConfig?.apiKey,
    baseUrl: imageConfig?.baseUrl,
    model: imageConfig?.model,
  };

  // Provider presence (not model) selects the custom view, so the user can see
  // the fields and type a model before the profile becomes usable.
  const mode: ImageSourceMode = imageConfig?.provider
    ? 'custom'
    : imageConfig?.configSetId
      ? 'configset'
      : 'inherit';

  const save = async (next: ImageSettingsDraft) => {
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

  const applyMode = (nextMode: ImageSourceMode) => {
    const firstSetId = buildConfigSetLites(appConfig ?? {})[0]?.id ?? '';
    if (nextMode === 'inherit') {
      void save({
        ...current,
        configSetId: '',
        modelId: undefined,
        provider: undefined,
        customProtocol: undefined,
        apiKey: undefined,
        baseUrl: undefined,
        model: undefined,
      });
      return;
    }
    if (nextMode === 'configset') {
      void save({
        ...current,
        configSetId: current.configSetId || firstSetId,
        provider: undefined,
        customProtocol: undefined,
        apiKey: undefined,
        baseUrl: undefined,
        model: undefined,
      });
      return;
    }
    void save({
      ...current,
      configSetId: '',
      modelId: undefined,
      provider: customDraft.provider,
      customProtocol: customDraft.provider === 'custom' ? customDraft.customProtocol : undefined,
      baseUrl: customDraft.baseUrl,
      apiKey: customDraft.apiKey,
      model: customDraft.model,
    });
  };

  const commitThreshold = () => {
    const parsed = Number(thresholdDraft);
    const next =
      Number.isFinite(parsed) && parsed >= 0
        ? Math.min(parsed, 100)
        : current.costConfirmThresholdUsd;
    setThresholdDraft(String(next));
    if (next !== current.costConfirmThresholdUsd) {
      void save({ ...current, costConfirmThresholdUsd: next });
    }
  };

  const commitCustom = (overrides: Partial<typeof customDraft>) => {
    const merged = { ...customDraft, ...overrides };
    setCustomDraft(merged);
    void save({
      ...current,
      configSetId: '',
      modelId: undefined,
      provider: merged.provider,
      customProtocol: merged.provider === 'custom' ? merged.customProtocol : undefined,
      baseUrl: merged.baseUrl,
      apiKey: merged.apiKey,
      model: merged.model,
    });
  };

  return (
    <SettingsContentSection title={t('api.images.title')} description={t('api.images.description')}>
      <div className="settings-card space-y-3 p-4">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <span className="w-24 text-xs text-text-muted">{t('api.images.sourceLabel')}</span>
          <select
            className={`${inputClass} flex-1`}
            disabled={busy}
            value={mode}
            aria-label={t('api.images.sourceLabel')}
            onChange={(event) => applyMode(event.target.value as ImageSourceMode)}
          >
            <option value="inherit">{t('api.images.sourceInherit')}</option>
            <option value="configset">{t('api.images.sourceConfigSet')}</option>
            <option value="custom">{t('api.images.sourceCustom')}</option>
          </select>
        </label>

        {mode === 'configset' && (
          <ConfigSetModelPicker
            sets={buildConfigSetLites(appConfig ?? {})}
            value={{ configSetId: current.configSetId, modelId: current.modelId }}
            onChange={(next) =>
              void save({
                ...current,
                configSetId: next.configSetId,
                modelId: next.modelId,
              })
            }
            configSetLabel={t('api.images.profileLabel')}
            modelLabel={t('subAgents.model')}
            disabled={busy}
            inputClassName="rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        )}

        {mode === 'custom' && (
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <span className="w-24 text-xs text-text-muted">{t('api.images.providerLabel')}</span>
              <select
                className={`${inputClass} flex-1`}
                disabled={busy}
                value={customDraft.provider}
                aria-label={t('api.images.providerLabel')}
                onChange={(event) =>
                  commitCustom({ provider: event.target.value as ProviderType })
                }
              >
                {PROVIDER_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {customDraft.provider === 'custom' && (
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <span className="w-24 text-xs text-text-muted">{t('api.images.protocolLabel')}</span>
                <select
                  className={`${inputClass} flex-1`}
                  disabled={busy}
                  value={customDraft.customProtocol}
                  aria-label={t('api.images.protocolLabel')}
                  onChange={(event) =>
                    commitCustom({ customProtocol: event.target.value as CustomProtocolType })
                  }
                >
                  {PROTOCOL_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <span className="w-24 text-xs text-text-muted">{t('api.images.baseUrlLabel')}</span>
              <input
                className={`${inputClass} flex-1`}
                disabled={busy}
                value={customDraft.baseUrl}
                placeholder="https://api.openai.com/v1"
                aria-label={t('api.images.baseUrlLabel')}
                onChange={(event) => setCustomDraft((prev) => ({ ...prev, baseUrl: event.target.value }))}
                onBlur={() => commitCustom({ baseUrl: customDraft.baseUrl })}
              />
            </label>

            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <span className="w-24 text-xs text-text-muted">{t('api.images.apiKeyLabel')}</span>
              <input
                type="password"
                className={`${inputClass} flex-1`}
                disabled={busy}
                value={customDraft.apiKey}
                placeholder={t('api.images.apiKeyPlaceholder')}
                aria-label={t('api.images.apiKeyLabel')}
                onChange={(event) => setCustomDraft((prev) => ({ ...prev, apiKey: event.target.value }))}
                onBlur={() => commitCustom({ apiKey: customDraft.apiKey })}
              />
            </label>

            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <span className="w-24 text-xs text-text-muted">{t('api.images.modelLabel')}</span>
              <input
                className={`${inputClass} flex-1`}
                disabled={busy}
                value={customDraft.model}
                placeholder={t('api.images.modelPlaceholder')}
                aria-label={t('api.images.modelLabel')}
                onChange={(event) => setCustomDraft((prev) => ({ ...prev, model: event.target.value }))}
                onBlur={() => commitCustom({ model: customDraft.model })}
              />
            </label>
          </div>
        )}

        <p className="text-xs leading-5 text-text-muted">
          {mode === 'custom' ? t('api.images.providerHint') : t('api.images.modelHint')}
        </p>

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
