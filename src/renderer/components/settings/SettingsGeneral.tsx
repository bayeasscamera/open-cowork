import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  BrainCircuit,
  ChevronRight,
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
  {
    tab: 'api',
    icon: Settings,
    titleKey: 'general.linkApi',
    descKey: 'settings.apiSettingsDesc',
  },
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
  {
    tab: 'logs',
    icon: AlertCircle,
    titleKey: 'general.linkLogs',
    descKey: 'settings.logsDesc',
  },
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

  const themeOptions = [
    { value: 'light' as const, label: t('general.themeLight') },
    { value: 'dark' as const, label: t('general.themeDark') },
    { value: 'system' as const, label: t('general.themeSystem', 'System') },
  ];

  const summary = summarizeConfiguration(appConfig);
  const configured = Boolean(appConfig?.isConfigured);
  const platform = window.electronAPI?.platform || 'darwin';
  const isArm = navigator.userAgent.includes('Arm') || navigator.userAgent.includes('Apple');
  const architecture = isArm ? 'arm64' : 'x64';
  const currentLanguageName =
    LANGUAGES.find((lang) => lang.code === currentLang)?.nativeName ?? currentLang;

  const systemRows = [
    { label: t('general.systemVersion'), value: appVer ? `v${appVer}` : '—' },
    { label: t('general.systemPlatform'), value: platform },
    { label: t('general.systemArchitecture'), value: architecture },
    { label: t('general.systemLanguage'), value: currentLanguageName },
    { label: t('general.configProvider'), value: summary?.providerName ?? '—' },
    { label: t('general.configModel'), value: summary?.modelName ?? '—' },
  ];

  const segmentedContainer =
    'flex gap-1.5 rounded-xl border border-border-subtle bg-surface-muted/60 p-1.5';

  return (
    <div className="space-y-6">
      {/* Theme */}
      <SettingsContentSection title={t('general.appearance')}>
        <div className={segmentedContainer}>
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateSettings({ theme: opt.value })}
              aria-pressed={settings.theme === opt.value}
              className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-200 ${
                settings.theme === opt.value
                  ? 'bg-surface text-text-primary shadow-premium'
                  : 'text-text-muted hover:bg-surface-hover/60 hover:text-text-secondary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </SettingsContentSection>

      {/* Language */}
      <SettingsContentSection title={t('general.language')}>
        <div className={segmentedContainer}>
          {LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => i18n.changeLanguage(lang.code)}
              aria-pressed={currentLang === lang.code}
              className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-200 ${
                currentLang === lang.code
                  ? 'bg-surface text-text-primary shadow-premium'
                  : 'text-text-muted hover:bg-surface-hover/60 hover:text-text-secondary'
              }`}
            >
              {lang.nativeName}
            </button>
          ))}
        </div>
      </SettingsContentSection>

      {/* Background quick access: tray icon + Alt+Space global toggle */}
      <SettingsContentSection
        title={t('general.backgroundAccess')}
        description={t('general.backgroundAccessDesc')}
      >
        <div className="settings-card flex items-center justify-between gap-4 px-4 py-3.5">
          <span className="text-sm text-text-secondary">{t('general.backgroundAccess')}</span>
          <button
            type="button"
            onClick={handleToggleTray}
            disabled={trayBusy}
            aria-pressed={trayEnabled}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50 ${
              trayEnabled ? 'bg-accent shadow-glow-accent' : 'bg-surface-active'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-soft transition-transform duration-200 ${
                trayEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </SettingsContentSection>

      {/* Local mods (also reachable from the Skills tab) */}
      <SettingsMods />

      {/* Active model configuration summary */}
      <SettingsContentSection
        title={t('general.configSection')}
        description={t('general.configSectionDesc')}
      >
        <div className="settings-card space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`badge ${
                configured ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'
              }`}
            >
              {configured ? t('general.configReady') : t('general.configMissing')}
            </span>
            {summary && (
              <span className="text-sm text-text-secondary">
                {summary.providerName} · {summary.modelName}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSettingsTab('api')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('general.configEdit')}
          </button>
        </div>
      </SettingsContentSection>

      {/* Quick access to the other settings screens */}
      <SettingsContentSection
        title={t('general.quickAccess')}
        description={t('general.quickAccessDesc')}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {QUICK_LINKS.map((link) => (
            <button
              key={link.tab}
              type="button"
              onClick={() => setSettingsTab(link.tab)}
              className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface px-3.5 py-3 text-left shadow-soft transition-all duration-200 hover:border-accent/40 hover:shadow-premium active:scale-[0.99]"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <link.icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {t(link.titleKey)}
                  </span>
                  <span className="block truncate text-[11px] text-text-muted">
                    {t(link.descKey)}
                  </span>
                </span>
              </span>
              <ChevronRight className="h-4 w-4 flex-shrink-0 text-text-muted" />
            </button>
          ))}
        </div>
      </SettingsContentSection>

      {/* About & System Specs */}
      <SettingsContentSection title={t('general.systemSection')}>
        <div className="settings-card divide-y divide-border-subtle overflow-hidden">
          {systemRows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="text-[11px] text-text-muted">{row.label}</span>
              <span className="select-text font-mono text-xs font-medium text-text-primary">
                {row.value}
              </span>
            </div>
          ))}
        </div>
      </SettingsContentSection>
    </div>
  );
}