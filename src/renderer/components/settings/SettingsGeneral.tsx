import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';

export function SettingsGeneral() {
  const { i18n, t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const currentLang = i18n.language.startsWith('zh') ? 'zh' : i18n.language.startsWith('fr') ? 'fr' : 'en';
  const [appVer, setAppVer] = useState('');
  const [trayEnabled, setTrayEnabled] = useState(true);
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

  const languages = [
    { code: 'en', nativeName: 'English' },
    { code: 'zh', nativeName: '中文' },
    { code: 'fr', nativeName: 'Français' },
  ];

  const themeOptions = [
    { value: 'light' as const, label: t('general.themeLight') },
    { value: 'dark' as const, label: t('general.themeDark') },
    { value: 'system' as const, label: t('general.themeSystem', 'System') },
  ];

  return (
    <div className="space-y-6">
      {/* Theme */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-text-primary">{t('general.appearance')}</h4>
        <div className="flex gap-2">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateSettings({ theme: opt.value })}
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
      </div>

      {/* Language */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-text-primary">{t('general.language')}</h4>
        <div className="flex gap-2">
          {languages.map((lang) => (
            <button
              key={lang.code}
              onClick={() => i18n.changeLanguage(lang.code)}
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
      </div>

      {/* Background quick access: tray icon + Alt+Space global toggle */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-text-primary">{t('general.backgroundAccess')}</h4>
        <div className="flex items-center justify-between gap-4 p-3 rounded-lg border border-border bg-surface">
          <p className="min-w-0 text-xs leading-5 text-text-muted">{t('general.backgroundAccessDesc')}</p>
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
      </div>

      {/* About & System Specs */}
      <div className="pt-4 border-t border-border space-y-3">
        <h4 className="text-sm font-medium text-text-primary">Système & Environnement</h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs">
          <div className="p-2.5 rounded-lg bg-surface border border-border">
            <span className="text-text-muted block text-[11px]">Version</span>
            <span className="font-mono font-medium text-text-primary">{appVer ? `v${appVer}` : '3.5.0'}</span>
          </div>
          <div className="p-2.5 rounded-lg bg-surface border border-border">
            <span className="text-text-muted block text-[11px]">Plateforme</span>
            <span className="font-mono font-medium text-text-primary">
              {window.electronAPI?.platform || 'darwin'} ({navigator.userAgent.includes('Arm') || navigator.userAgent.includes('Apple') ? 'arm64' : 'x64'})
            </span>
          </div>
          <div className="p-2.5 rounded-lg bg-surface border border-border">
            <span className="text-text-muted block text-[11px]">Moteur IA</span>
            <span className="font-mono font-medium text-text-primary">Pi-AI Native 1M</span>
          </div>
        </div>
      </div>
    </div>
  );
}
