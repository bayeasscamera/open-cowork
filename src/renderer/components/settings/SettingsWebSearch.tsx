import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Globe, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store';

const KEY_FIELDS = ['tavilyApiKey', 'braveApiKey'] as const;
type KeyField = (typeof KEY_FIELDS)[number];
type KeyDraft = Record<KeyField, string>;

export function SettingsWebSearch() {
  const { t } = useTranslation();
  const appConfig = useAppStore((state) => state.appConfig);
  const setAppConfig = useAppStore((state) => state.setAppConfig);
  const setIsConfigured = useAppStore((state) => state.setIsConfigured);
  // Untouched fields follow persisted config; unrelated config saves never erase edits.
  const [draft, setDraft] = useState<Partial<KeyDraft>>({});
  const [visible, setVisible] = useState<Record<KeyField, boolean>>({
    tavilyApiKey: false,
    braveApiKey: false,
  });
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  const keys: KeyDraft = {
    tavilyApiKey: draft.tavilyApiKey ?? appConfig?.tavilyApiKey ?? '',
    braveApiKey: draft.braveApiKey ?? appConfig?.braveApiKey ?? '',
  };

  async function handleSave() {
    if (savingRef.current || !appConfig) return;
    savingRef.current = true;
    setIsSaving(true);
    setStatus(null);
    try {
      const result = await window.electronAPI.config.save({
        tavilyApiKey: keys.tavilyApiKey.trim(),
        braveApiKey: keys.braveApiKey.trim(),
      });
      if (!result.success || !result.config) {
        setStatus('error');
        return;
      }
      setAppConfig(result.config);
      setIsConfigured(Boolean(result.config.isConfigured));
      setDraft({});
      setVisible({ tavilyApiKey: false, braveApiKey: false });
      setStatus('saved');
    } catch {
      // Never display or log raw IPC errors: they may contain submitted credentials.
      setStatus('error');
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  return (
    <section
      aria-labelledby="web-search-heading"
      className="space-y-3 py-5 border-b border-border-muted"
    >
      <h3
        id="web-search-heading"
        className="flex items-center gap-2 text-sm font-medium text-text-primary"
      >
        <Globe aria-hidden="true" className="w-4 h-4" />
        {t('api.webSearch.title')}
      </h3>
      <p id="web-search-description" className="text-xs leading-5 text-text-muted">
        {t('api.webSearch.description')}
      </p>
      <p id="web-search-environment" className="text-xs leading-5 text-text-muted">
        {t('api.webSearch.environmentHint')}
      </p>
      {KEY_FIELDS.map((field) => (
        <div key={field} className="space-y-2">
          <label
            htmlFor={`web-search-${field}`}
            className="block text-sm font-medium text-text-primary"
          >
            {t(`api.webSearch.${field}`)}
          </label>
          <div className="relative">
            <input
              id={`web-search-${field}`}
              type={visible[field] ? 'text' : 'password'}
              value={keys[field]}
              disabled={isSaving || !appConfig}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby="web-search-description web-search-environment"
              onChange={(event) => {
                setDraft((previous) => ({ ...previous, [field]: event.target.value }));
                setStatus(null);
              }}
              className="w-full px-4 py-3 pr-11 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all font-mono text-sm disabled:opacity-50"
            />
            <button
              type="button"
              aria-label={t(visible[field] ? 'api.webSearch.hideKey' : 'api.webSearch.showKey', {
                provider: field === 'tavilyApiKey' ? 'Tavily' : 'Brave',
              })}
              aria-controls={`web-search-${field}`}
              aria-pressed={visible[field]}
              onClick={() => setVisible((previous) => ({ ...previous, [field]: !previous[field] }))}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary focus-visible:outline focus-visible:outline-accent transition-colors"
            >
              {visible[field] ? (
                <EyeOff aria-hidden="true" className="w-4 h-4" />
              ) : (
                <Eye aria-hidden="true" className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      ))}
      {status === 'error' && (
        <p role="alert" className="px-4 py-3 rounded-lg bg-error/10 text-error text-sm">
          {t('api.webSearch.saveFailed')}
        </p>
      )}
      {status === 'saved' && (
        <p role="status" className="px-4 py-3 rounded-lg bg-success/10 text-success text-sm">
          {t('api.webSearch.saved')}
        </p>
      )}
      <button
        type="button"
        onClick={() => {
          void handleSave();
        }}
        disabled={isSaving || !appConfig}
        className="w-full py-3 px-4 rounded-lg bg-accent text-white font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {isSaving && <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />}
        {t(isSaving ? 'api.webSearch.saving' : 'api.webSearch.save')}
      </button>
    </section>
  );
}
