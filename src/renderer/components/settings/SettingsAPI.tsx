import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Key,
  Plug,
  Server,
  Cpu,
  Loader2,
  Edit3,
  AlertCircle,
  CheckCircle,
  RefreshCw,
  Plus,
  X,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useApiConfigState } from '../../hooks/useApiConfigState';
import { ApiConfigSetManager } from '../ApiConfigSetManager';
import { CommonProviderSetupsCard, GuidanceInlineHint } from '../ProviderGuidance';
import ApiDiagnosticsPanel from '../ApiDiagnosticsPanel';

interface ModelOptionItem {
  id: string;
  name: string;
}

function AddCustomModelRow({ onAdd }: { onAdd: (id: string) => void }) {
  const [value, setValue] = useState('');
  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) {
      onAdd(trimmed);
      setValue('');
    }
  };
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="ex: mon-modele-1.0"
        className="flex-1 px-3 py-1.5 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!value.trim()}
        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-40 hover:bg-accent/90 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        Ajouter
      </button>
    </div>
  );
}

// ==================== API Settings Tab ====================

export function SettingsAPI() {
  const { t } = useTranslation();
  const [showApiKey, setShowApiKey] = useState(false);
  const {
    provider,
    customProtocol,
    apiKey,
    baseUrl,
    model,
    customModel,
    useCustomModel,
    contextWindow,
    maxTokens,
    modelInputPlaceholder,
    modelInputHint,
    presets,
    currentPreset,
    modelOptions,
    isSaving,
    isLoadingConfig,
    error,
    successMessage,
    isRefreshingModels,
    isDiscoveringLocalOllama,
    enableThinking,
    isOllamaMode,
    requiresApiKey,
    protocolGuidanceText,
    protocolGuidanceTone,
    baseUrlGuidanceText,
    commonProviderSetups,
    configSets,
    activeConfigSetId,
    currentConfigSet,
    pendingConfigSetAction,
    pendingConfigSet,
    hasUnsavedChanges,
    isMutatingConfigSet,
    canDeleteCurrentConfigSet,
    setApiKey,
    setBaseUrl,
    setModel,
    setCustomModel,
    addCustomModel,
    removeCustomModel,
    setContextWindow,
    setMaxTokens,
    toggleCustomModel,
    setEnableThinking,
    applyCommonProviderSetup,
    changeProvider,
    changeProtocol,
    requestConfigSetSwitch,
    requestCreateBlankConfigSet,
    cancelPendingConfigSetAction,
    saveAndContinuePendingConfigSetAction,
    discardAndContinuePendingConfigSetAction,
    renameConfigSet,
    deleteConfigSet,
    handleSave,
    refreshModelOptions,
    discoverLocalOllama,
    diagnosticResult,
    isDiagnosing,
    handleDiagnose,
    handleDeepDiagnose,
    shouldShowOllamaManualModelToggle,
  } = useApiConfigState();

  if (isLoadingConfig) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
        <span className="ml-2 text-text-secondary">{t('common.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Config Set Switcher */}
      <ApiConfigSetManager
        configSets={configSets}
        activeConfigSetId={activeConfigSetId}
        currentConfigSet={currentConfigSet}
        pendingConfigSetAction={pendingConfigSetAction}
        pendingConfigSet={pendingConfigSet}
        hasUnsavedChanges={hasUnsavedChanges}
        isMutatingConfigSet={isMutatingConfigSet}
        isSaving={isSaving}
        canDeleteCurrentConfigSet={canDeleteCurrentConfigSet}
        onSwitchSet={requestConfigSetSwitch}
        onRequestCreateBlankSet={requestCreateBlankConfigSet}
        onSaveCurrentSet={handleSave}
        onRenameSet={renameConfigSet}
        onDeleteSet={deleteConfigSet}
        onCancelPendingAction={cancelPendingConfigSetAction}
        onSaveAndContinuePendingAction={saveAndContinuePendingConfigSetAction}
        onDiscardAndContinuePendingAction={discardAndContinuePendingConfigSetAction}
      />

      {/* Provider Selection */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Server className="w-4 h-4" />
          {t('api.provider')}
        </label>
        <p className="text-xs leading-5 text-text-muted">{t('api.providerDescription')}</p>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
          {(['openrouter', 'anthropic', 'openai', 'gemini', 'ollama', 'custom'] as const).map(
            (p) => (
              <button
                key={p}
                onClick={() => changeProvider(p)}
                disabled={isLoadingConfig}
                className={`px-3 py-2 rounded-lg text-sm transition-colors border ${
                  provider === p
                    ? 'border-accent bg-accent/10 text-accent font-medium'
                    : 'border-border-muted text-text-secondary hover:border-border hover:text-text-primary disabled:opacity-50'
                }`}
              >
                {p === 'custom' ? t('api.moreModels') : presets?.[p]?.name || p}
              </button>
            )
          )}
        </div>
      </div>

      {/* API Key */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <label
          htmlFor="api-key-input"
          className="flex items-center gap-2 text-sm font-medium text-text-primary"
        >
          <Key className="w-4 h-4" />
          {t('api.apiKey')}
        </label>
        <p className="text-xs leading-5 text-text-muted">{t('api.apiKeyDescription')}</p>
        <div className="relative">
          <input
            id="api-key-input"
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={currentPreset?.keyPlaceholder || t('api.enterApiKey')}
            className="w-full px-4 py-3 pr-11 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
            title={showApiKey ? t('common.hide', 'Masquer') : t('common.show', 'Afficher')}
          >
            {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {currentPreset?.keyHint && (
          <p className="text-xs text-text-muted">{currentPreset.keyHint}</p>
        )}
      </div>

      {/* Custom Protocol */}
      {provider === 'custom' && (
        <div className="space-y-3 py-5 border-b border-border-muted">
          <label
            id="api-protocol-label"
            className="flex items-center gap-2 text-sm font-medium text-text-primary"
          >
            <Server className="w-4 h-4" />
            {t('api.protocol')}
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {(
              [
                { id: 'anthropic', label: 'Anthropic' },
                { id: 'openai', label: 'OpenAI' },
                { id: 'gemini', label: 'Gemini' },
              ] as const
            ).map((mode) => (
              <button
                key={mode.id}
                onClick={() => changeProtocol(mode.id)}
                className={`px-3 py-2 rounded-lg text-sm transition-colors border ${
                  customProtocol === mode.id
                    ? 'border-accent bg-accent/10 text-accent font-medium'
                    : 'border-border-muted text-text-secondary hover:border-border hover:text-text-primary'
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-text-muted">{t('api.selectProtocol')}</p>
          <GuidanceInlineHint text={protocolGuidanceText} tone={protocolGuidanceTone} />
        </div>
      )}

      {(provider === 'custom' || provider === 'ollama') && (
        <div className="space-y-3 py-5 border-b border-border-muted">
          <div className="flex items-center justify-between gap-2">
            <label
              htmlFor="api-base-url-input"
              className="flex items-center gap-2 text-sm font-medium text-text-primary"
            >
              <Server className="w-4 h-4" />
              {t('api.baseUrl')}
            </label>
            {isOllamaMode && (
              <button
                type="button"
                onClick={() => {
                  void discoverLocalOllama();
                }}
                disabled={isDiscoveringLocalOllama}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 bg-accent-muted text-accent hover:bg-accent-muted/80 disabled:opacity-50"
              >
                <Plug className="w-3 h-3" />
                {isDiscoveringLocalOllama
                  ? t('api.discoveringLocalOllama')
                  : t('api.discoverLocalOllama')}
              </button>
            )}
          </div>
          <input
            id="api-base-url-input"
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={
              provider === 'ollama'
                ? 'http://localhost:11434/v1'
                : customProtocol === 'openai'
                  ? 'https://api.openai.com/v1'
                  : customProtocol === 'gemini'
                    ? 'https://generativelanguage.googleapis.com'
                    : currentPreset?.baseUrl || 'https://api.anthropic.com'
            }
            className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
          />
          <p className="text-xs text-text-muted">
            {provider === 'ollama'
              ? t('api.enterOllamaUrl')
              : customProtocol === 'openai'
                ? t('api.enterOpenAIUrl')
                : customProtocol === 'gemini'
                  ? t('api.enterGeminiUrl')
                  : t('api.enterAnthropicUrl')}
          </p>
          {isOllamaMode && (
            <p className="text-xs text-text-muted">{t('api.discoverLocalOllamaHint')}</p>
          )}
          {provider === 'custom' && <GuidanceInlineHint text={baseUrlGuidanceText} />}
        </div>
      )}

      {/* Model Selection */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <div className="flex items-center justify-between">
          <label
            htmlFor="api-model-input"
            className="flex items-center gap-2 text-sm font-medium text-text-primary"
          >
            <Cpu className="w-4 h-4" />
            {t('api.model')}
          </label>
          <div className="flex items-center gap-2">
            {isOllamaMode && (
              <button
                type="button"
                onClick={() => {
                  void refreshModelOptions();
                }}
                disabled={isRefreshingModels}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 bg-surface-hover text-text-secondary hover:bg-surface-active disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${isRefreshingModels ? 'animate-spin' : ''}`} />
                {isRefreshingModels ? t('api.refreshingModels') : t('api.refreshModels')}
              </button>
            )}
            {shouldShowOllamaManualModelToggle && (
              <button
                type="button"
                onClick={toggleCustomModel}
                className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 ${
                  useCustomModel
                    ? 'bg-accent-muted text-accent'
                    : 'border border-border-muted bg-background text-text-secondary hover:bg-surface-hover'
                }`}
              >
                <Edit3 className="w-3 h-3" />
                {isOllamaMode
                  ? useCustomModel
                    ? t('api.useDetectedModels')
                    : t('api.manualModel')
                  : useCustomModel
                    ? t('api.usePreset')
                    : t('api.custom')}
              </button>
            )}
          </div>
        </div>
        {useCustomModel ? (
          <div className="space-y-3">
            {/* Champ de saisie du modèle actif */}
            <input
              id="api-model-input"
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder={modelInputPlaceholder}
              className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
            />
            {/* Pour custom provider : gestion des modèles configurés */}
            {provider === 'custom' ? (
              <div className="space-y-2">
                {modelOptions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {(modelOptions as ModelOptionItem[]).map((m) => (
                      <span
                        key={m.id}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono border transition-colors ${
                          customModel === m.id
                            ? 'border-accent bg-accent/15 text-accent font-semibold'
                            : 'border-border-muted bg-surface-muted text-text-secondary'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => setCustomModel(m.id)}
                          className="hover:text-text-primary transition-colors"
                        >
                          {m.name}
                        </button>
                        <button
                          type="button"
                          title="Supprimer ce modèle"
                          onClick={() => removeCustomModel(m.id)}
                          className="ml-0.5 text-text-muted hover:text-red-400 transition-colors"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <AddCustomModelRow onAdd={addCustomModel} />
              </div>
            ) : (
              modelOptions.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[11px] text-text-muted font-medium mr-1">Modèles :</span>
                  {(modelOptions as ModelOptionItem[]).slice(0, 8).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setCustomModel(m.id)}
                      className={`px-2 py-0.5 rounded-md text-xs font-mono transition-colors border ${
                        customModel === m.id
                          ? 'border-accent bg-accent/15 text-accent font-semibold'
                          : 'border-border-muted bg-surface-muted hover:border-border text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <select
              id="api-model-input"
              value={modelOptions.length ? model : ''}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all appearance-none cursor-pointer"
            >
              {modelOptions.length ? (
                (modelOptions as ModelOptionItem[]).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))
              ) : (
                <option value="" disabled>
                  {t('api.noModelsAvailable')}
                </option>
              )}
            </select>
            {/* Quick model pills */}
            {modelOptions.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {(modelOptions as ModelOptionItem[]).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModel(m.id)}
                    className={`px-2 py-0.5 rounded-md text-xs font-mono transition-colors border ${
                      model === m.id
                        ? 'border-accent bg-accent/15 text-accent font-semibold'
                        : 'border-border-muted bg-surface-muted hover:border-border text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {useCustomModel && <p className="text-xs text-text-muted">{modelInputHint}</p>}

        {/* Context Window & Max Tokens — Configurable & Durci pour tous les fournisseurs */}
        <div className="grid grid-cols-2 gap-3 pt-2">
            <div>
              <label
                htmlFor="api-context-window-input"
                className="block text-xs font-medium text-text-secondary mb-1"
              >
                {t('api.contextWindow')}
              </label>
              <input
                id="api-context-window-input"
                type="number"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder={t('api.contextWindowPlaceholder')}
                min={1024}
                step={1024}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
              />
            </div>
            <div>
              <label
                htmlFor="api-max-tokens-input"
                className="block text-xs font-medium text-text-secondary mb-1"
              >
                {t('api.maxOutputTokens')}
              </label>
              <input
                id="api-max-tokens-input"
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder={t('api.maxOutputTokensPlaceholder')}
                min={256}
                step={256}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
              />
            </div>
            <p className="col-span-2 text-xs text-text-muted">{t('api.contextWindowHint')}</p>
          </div>
      </div>

      {provider === 'custom' && (
        <CommonProviderSetupsCard
          setups={commonProviderSetups}
          onApplySetup={applyCommonProviderSetup}
        />
      )}

      {/* Enable Thinking Mode */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <div className="flex items-start gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            id="enable-thinking"
            checked={enableThinking}
            onChange={(e) => setEnableThinking(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded border-border text-accent focus:ring-accent"
          />
          <label htmlFor="enable-thinking" className="space-y-0.5 flex-1">
            <div className="text-text-primary font-medium">{t('api.enableThinking')}</div>
            <div>{t('api.enableThinkingHint')}</div>
            {isOllamaMode && (
              <div className="text-amber-500 dark:text-amber-400 text-xs mt-1">
                {t('api.enableThinkingOllamaHint')}
              </div>
            )}
          </label>
        </div>
      </div>

      {/* Error/Success Messages */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-error/10 text-error text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
      {successMessage && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-success/10 text-success text-sm">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          {successMessage}
        </div>
      )}
      {/* Diagnostics Panel */}
      <ApiDiagnosticsPanel
        result={diagnosticResult}
        isRunning={isDiagnosing}
        onRunDiagnostics={handleDiagnose}
        onRunDeepDiagnostics={isOllamaMode ? handleDeepDiagnose : undefined}
        disabled={requiresApiKey && !apiKey.trim()}
      />

      {/* Save Button */}
      <div className="space-y-3 py-5 border-b border-border-muted">
        <div className="grid grid-cols-1 gap-2">
          <button
            onClick={() => {
              void handleSave();
            }}
            disabled={isSaving || (requiresApiKey && !apiKey.trim())}
            className="w-full py-3 px-4 rounded-lg bg-accent text-white font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98] flex items-center justify-center gap-2"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('common.saving')}
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4" />
                {t('api.saveSettings')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
