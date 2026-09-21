import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsContentSection, ToggleSwitch } from './shared';

interface ModSummary {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

/**
 * Local mods (function hooks) management: every mod runs 100% locally and can
 * be enabled/disabled individually; state persists via electron-store.
 */
export function SettingsMods() {
  const { t } = useTranslation();
  const [mods, setMods] = useState<ModSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.mods.list();
      if (id !== requestId.current) return;
      if (!result.success) {
        setError('failed');
        return;
      }
      setMods(result.mods);
    } catch {
      if (id === requestId.current) setError('failed');
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  const toggle = async (mod: ModSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = !mod.enabled;
      const result = await window.electronAPI.mods.setEnabled(mod.id, next);
      if (!result.success) {
        setError('toggleFailed');
        return;
      }
      setMods((prev) =>
        prev.map((item) => (item.id === mod.id ? { ...item, enabled: next } : item))
      );
    } catch {
      setError('toggleFailed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsContentSection title={t('mods.title')} description={t('mods.description')}>
      <div className="space-y-3 settings-card space-y-3 p-4" aria-busy={busy}>
        {busy && mods.length === 0 && (
          <p role="status" className="text-sm text-text-muted">{t('mods.loading')}</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-rose-500">{t(`mods.${error}`)}</p>
        )}
        {!busy && !error && mods.length === 0 && (
          <p className="text-sm text-text-muted">{t('mods.empty')}</p>
        )}
        {mods.map((mod) => (
          <label key={mod.id} className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-sm text-text-primary">{mod.label}</span>
              <span className="mt-0.5 block text-xs text-text-muted">{mod.description}</span>
            </span>
            <ToggleSwitch
              checked={mod.enabled}
              disabled={busy}
              onToggle={() => {
                void toggle(mod);
              }}
            />
          </label>
        ))}
      </div>
    </SettingsContentSection>
  );
}