import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';

export function SettingsGeneral() {
  const { i18n, t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const currentLang = i18n.language.startsWith('zh') ? 'zh' : i18n.language.startsWith('fr') ? 'fr' : 'en';
  const [appVer, setAppVer] = useState('');
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
