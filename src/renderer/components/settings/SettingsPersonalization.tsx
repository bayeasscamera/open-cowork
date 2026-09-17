import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings as SettingsIcon } from 'lucide-react';
import { useAppStore } from '../../store';
import type { MemoryOverview } from '../../types';
import { SettingsContentSection } from './shared';

const INSTRUCTION_PRESETS = [
  { key: 'concise' },
  { key: 'stepByStep' },
  { key: 'professional' },
  { key: 'codeComments' },
] as const;

type InstructionPresetKey = (typeof INSTRUCTION_PRESETS)[number]['key'];

export function SettingsPersonalization() {
  const { t } = useTranslation();
  const appConfig = useAppStore((state) => state.appConfig);
  const setSettingsTab = useAppStore((state) => state.setSettingsTab);

  const [memoryEnabled, setMemoryEnabled] = useState(appConfig?.memoryEnabled ?? true);
  const [instructionsDraft, setInstructionsDraft] = useState(appConfig?.coworkInstructions || '');
  const [coreCount, setCoreCount] = useState(0);
  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setMemoryEnabled(appConfig?.memoryEnabled ?? true);
    setInstructionsDraft(appConfig?.coworkInstructions || '');
  }, [appConfig?.memoryEnabled, appConfig?.coworkInstructions]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const overview: MemoryOverview = await window.electronAPI.memory.getOverview();
        if (!cancelled) setCoreCount(overview?.coreCount ?? 0);
      } catch {
        // Overview stats are informational only — ignore load failures.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyPreset = (preset: { key: InstructionPresetKey }) => {
    const text = t(`personalization.presetText_${preset.key}`);
    setInstructionsDraft((prev) => {
      if (prev.includes(text)) return prev;
      const trimmed = prev.trimEnd();
      return trimmed ? `${trimmed}\n${text}` : text;
    });
  };

  const handleToggleMemory = async () => {
    const next = !memoryEnabled;
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.config.save({ memoryEnabled: next });
      setMemoryEnabled(next);
      setStatus(
        next
          ? t('personalization.memoryEnabledStatus')
          : t('personalization.memoryDisabledStatus')
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveInstructions = async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.config.save({ coworkInstructions: instructionsDraft });
      setStatus(t('personalization.instructionsSaved'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsContentSection
        title={t('personalization.memorySectionTitle')}
        description={t('personalization.memorySectionDesc')}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-muted bg-background-secondary/60 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">
              {t('personalization.memoryToggleLabel')}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              {t('personalization.memoryToggleHint', { count: coreCount })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSettingsTab('memory')}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary hover:bg-surface-hover transition-colors"
            >
              <SettingsIcon className="w-3.5 h-3.5" />
              {t('personalization.manageMemory')}
            </button>
            <button
              onClick={() => {
                void handleToggleMemory();
              }}
              disabled={isBusy}
              role="switch"
              aria-checked={memoryEnabled}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                memoryEnabled ? 'bg-accent' : 'bg-border'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  memoryEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>
      </SettingsContentSection>

      <SettingsContentSection
        title={t('personalization.instructionsTitle')}
        description={t('personalization.instructionsDesc')}
      >
        <div className="space-y-3 rounded-xl border border-border-muted bg-background-secondary/60 p-4">
          <div className="flex flex-wrap gap-2">
            {INSTRUCTION_PRESETS.map((preset) => (
              <button
                key={preset.key}
                onClick={() => applyPreset(preset)}
                disabled={isBusy}
                title={t(`personalization.presetText_${preset.key}`)}
                className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {t(`personalization.preset_${preset.key}`)}
              </button>
            ))}
          </div>
          <textarea
            value={instructionsDraft}
            onChange={(event) => setInstructionsDraft(event.target.value)}
            placeholder={t('personalization.instructionsPlaceholder')}
            rows={8}
            className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-accent"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-text-muted">
              {t('personalization.instructionsHint')}
            </p>
            <button
              onClick={() => {
                void handleSaveInstructions();
              }}
              disabled={isBusy}
              className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('personalization.instructionsSave')}
            </button>
          </div>
        </div>
      </SettingsContentSection>

      {status && (
        <div className="rounded-lg border border-border-muted bg-background-secondary/70 px-4 py-3 text-sm text-text-secondary">
          {status}
        </div>
      )}
    </div>
  );
}
