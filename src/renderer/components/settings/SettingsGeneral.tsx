import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  BrainCircuit,
  Clock3,
  ExternalLink,
  Plug,
  Settings,
  Shield,
} from 'lucide-react';
import { useAppStore } from '../../store';
import type { AppConfig, ProviderType } from '../../types';
import { SettingsContentSection } from './shared';
import { SettingsMods } from './SettingsMods';

const LANGUAGES = [
  { code: 'en', nativeName: 'English' },
  { code: 'zh', nativeName: '中文' },
  { code: 'fr', nativeName: 'Français' },
] as const;

const THEME_OPTIONS = ['light', 'dark', 'system'] as const;

const PROVIDER_DISPLAY_NAMES: Record<ProviderType, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  ollama: 'Ollama',
  custom: 'Custom',
};

type TabLink = {
  tab: 'api' | 'sandbox' | 'connectors' | 'memory' | 'schedule' | 'logs';
  icon: typeof Settings;
  titleKey: string;
  descKey: string;
};

const QUICK_LINKS: TabLink[] = [
  { tab: 'api', icon: Settings, titleKey: 'general.linkApi', descKey: 'settings.apiSettingsDesc' },
  {
    tab: 'sandbox',
    icon: Shield,
    titleKey: 'general.linkSandbox',
    descKey: 'settings.sandboxDesc',
  },
  {
    tab: 'connectors',
    icon: Plug,
    titleKey: 'general.linkConnectors',
    descKey: 'settings.connectorsDesc',
  },
  {
    tab: 'memory',
    icon: BrainCircuit,
    titleKey: 'general.linkMemory',
    descKey: 'settings.memoryDesc',
  },
  {
    tab: 'schedule',
    icon: Clock3,
    titleKey: 'general.linkSchedule',
    descKey: 'settings.scheduleDesc',
  },
  { tab: 'logs', icon: AlertCircle, titleKey: 'general.linkLogs', descKey: 'settings.logsDesc' },
];

function summarizeConfiguration(
  config: AppConfig | null
): { providerName: string; modelName: string } | null {
  if (!config) return null;
  const activeSet =
    config.configSets.find((set) => set.id === config.activeConfigSetId) ?? config.configSets[0];
  const providerKey: ProviderType = activeSet?.provider ?? config.provider;
  const providerName = PROVIDER_DISPLAY_NAMES[providerKey] ?? providerKey;
  const profileKey = activeSet?.activeProfileKey ?? config.activeProfileKey;
  const profile = activeSet?.profiles?.[profileKey] ?? config.profiles?.[profileKey];
  const modelName = (profile?.model ?? config.model ?? '').trim();
  return { providerName, modelName: modelName || '—' };
}

export function SettingsGeneral() {
  const { i18n, t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const appConfig = useAppStore((s) => s.appConfig);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const currentLang = i18n.language.startsWith('zh')
    ? 'zh'
    : i18n.language.startsWith('fr')
      ? 'fr'
      : 'en';
  const [appVer, setAppVer] = useState('');
  const [trayEnabled, setTrayEnabled] = useState(false);
  const [trayBusy, setTrayBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    try {
      const cfg = window.electronAPI?.config?.get?.();
      if (cfg) {
        cfg
          .then((c) => {
            if (!cancelled && typeof c?.trayEnabled === 'boolean') setTrayEnabled(c.trayEnabled);
          })
          .catch(() => {
            /* keep default */
          });
      }
    } catch {
      /* browser mode / older bridge */
    }
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggleTray() {
    if (trayBusy) return;
    setTrayBusy(true);
    try {
      const next = !trayEnabled;
      await window.electronAPI?.config?.save?.({ trayEnabled: next });
      setTrayEnabled(next);
    } catch {
      /* switch stays unchanged on failure */
    } finally {
      setTrayBusy(false);
    }
  }

  useEffect(() => {
    try {
      const v = window.electronAPI?.getVersion?.();
      if (v instanceof Promise) v.then(setAppVer);
      else if (v) setAppVer(v);
    } catch {
      /* ignore */
    }
  }, []);

  const themeOptions = THEME_OPTIONS.map((value) => ({
    value,
    label:
      value === 'light'
        ? t('general.themeLight')
        : value === 'dark'
          ? t('general.themeDark')
          : t('general.themeSystem', 'System'),
  }));

  const platform = window.electronAPI?.platform || 'darwin';
  const isArm = navigator.userAgent.includes('Arm') || navigator.userAgent.includes('Apple');
  const architecture = isArm ? 'arm64' : 'x64';
  const configSummary = summarizeConfiguration(appConfig);
  const configured = appConfig ? Boolean(appConfig.isConfigured) : null;

  const systemRows: Array<{ label: string; value: string }> = [
    { label: t('general.systemVersion'), value: appVer ? `v${appVer}` : '—' },
    { label: t('general.systemPlatform'), value: platform },
    { label: t('general.systemArchitecture'), value: architecture },
    { label: t('general.systemLanguage'), value: LANGUAGES.find((l) => l.code === currentLang)?.nativeName ?? currentLang },
    {
      label: t('general.configProvider'),
      value: configSummary ? configSummary.providerName : '—',
    },
    {
      label: t('general.configModel'),
      value: configSummary ? configSummary.modelName : '—',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Appearance */}
      <SettingsContentSection title={t('general.appearance')} description={t('general.theme')}>
        <div className="flex gap-2">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateSettings({ theme: opt.value })}
              aria-pressed={settings.theme === opt.value}
              className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all ${
                settings.theme === opt.value
                  ? 'border-accent bg-accent/5 text-text-primary'
                  : 'border-border bg-surface hover:border-accent/50 text-text-secondary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingsContentSection>

      {/* Language */}
      <SettingsContentSection title={t('general.language')}>
        <div className="flex gap-2">
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => i18n.changeLanguage(lang.code)}
              aria-pressed={currentLang === lang.code}
              className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all ${
                currentLang === lang.code
                  ? 'border-accent bg-accent/5 text-text-primary'
                  : 'border-border bg-surface hover:border-accent/50 text-text-secondary'
              }`}
            >
              {lang.nativeName}
            </button>
          ))}
        </div>
      </SettingsContentSection>

      {/* Background quick access: tray icon + global toggle */}
      <SettingsContentSection title={t('general.backgroundAccess')}>
        <div className="flex items-center justify-between gap-4 p-3 rounded-lg border border-border bg-surface">
          <p className="min-w-0 text-xs leading-5 text-text-muted">
            {t('general.backgroundAccessDesc')}
          </p>
          <button
            type="button"
            onClick={handleToggleTray}
            disabled={trayBusy}
            aria-pressed={trayEnabled}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 disabled:opacity-50 flex-shrink-0 ${
              trayEnabled ? 'bg-accent' : 'bg-surface-muted'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-text-primary transition-transform ${
                trayEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </SettingsContentSection>

      {/* Local mods */}
      <SettingsMods />

      {/* Configuration summary */}
      <SettingsContentSection
        title={t('general.configSection')}
        description={t('general.configSectionDesc')}
      >
        <div className="rounded-lg border border-border bg-surface p-3 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {configured !== null && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border ${
                  configured
                    ? 'border-success/40 bg-success/10 text-success'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-500'
                }`}
              >
                {configured ? t('general.configReady') : t('general.configMissing')}
              </span>
            )}
            {configSummary && (
              <span className="font-mono text-xs text-text-secondary truncate">
                {configSummary.providerName} · {configSummary.modelName}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSettingsTab('api')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-hover transition-colors"
          >
            <Settings className="w-3.5 h-3.5" />
            {t('general.configEdit')}
          </button>
        </div>
      </SettingsContentSection>

      {/* Quick access to the other settings tabs */}
      <SettingsContentSection
        title={t('general.quickAccess')}
        description={t('general.quickAccessDesc')}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {QUICK_LINKS.map((link) => (
            <button
              key={link.tab}
              type="button"
              onClick={() => setSettingsTab(link.tab)}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-surface-hover"
            >
              <span className="flex min-w-0 items-center gap-2">
                <link.icon className="w-4 h-4 flex-shrink-0 text-text-muted" />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-text-primary truncate">
                    {t(link.titleKey)}
                  </span>
                  <span className="block text-[11px] text-text-muted truncate">
                    {t(link.descKey)}
                  </span>
                </span>
              </span>
              <ExternalLink className="w-3.5 h-3.5 flex-shrink-0 text-text-muted" />
            </button>
          ))}
        </div>
      </SettingsContentSection>

      {/* System & environment */}
      <SettingsContentSection title={t('general.systemSection')}>
        <div className="rounded-lg border border-border bg-surface divide-y divide-border-muted">
          {systemRows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-[11px] text-text-muted">{row.label}</span>
              <span className="font-mono text-xs font-medium text-text-primary select-text">
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </SettingsContentSection>
    </div>
  );
}