/**
 * Cowork — Settings ladder pane (Control Center).
 *
 * Makes the global -> project -> session precedence visible and editable.
 * The resolution is computed with the SAME pure module the agent runner uses,
 * so the panel can never disagree with what actually runs: it shows which level
 * decided the ConfigSet, which level decided the model, and lets the user pin
 * (or clear) the session-level override.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Layers, RotateCcw, TriangleAlert } from 'lucide-react';
import {
  resolveSettingsLadder,
  type EffectiveSettings,
  type SettingsLevel,
} from '../../shared/settings-levels';
import { useAppStore } from '../store';

const LEVEL_STYLE: Record<SettingsLevel, string> = {
  global: 'border-border bg-surface',
  project: 'border-sky-500/40 bg-sky-500/10',
  session: 'border-accent bg-accent/10',
};

function levelLabelKey(level: SettingsLevel): string {
  return 'settingsLevels.level.' + level;
}

function summarizeValue(effective: EffectiveSettings): string {
  const parts = [effective.configSetName, effective.provider, effective.model].filter(Boolean);
  return parts.join(' · ');
}

export function SettingsLevelsPane({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI?.session : undefined;
  const appConfig = useAppStore((s) => s.appConfig);
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);

  const session = useMemo(
    () => sessions.find((candidate) => candidate.id === sessionId) ?? null,
    [sessions, sessionId]
  );
  const project = useMemo(
    () =>
      session?.projectId
        ? projects.find((candidate) => candidate.id === session.projectId) ?? null
        : null,
    [projects, session]
  );

  const globalInput = useMemo(
    () => ({
      activeConfigSetId: appConfig?.activeConfigSetId ?? '',
      configSets: appConfig?.configSets ?? [],
    }),
    [appConfig]
  );
  const projectInput = useMemo(
    () =>
      project
        ? {
            id: project.id,
            name: project.name,
            configSetId: project.configSetId,
            modelId: project.modelId,
          }
        : null,
    [project]
  );

  const ladder = useMemo(
    () =>
      resolveSettingsLadder({
        global: globalInput,
        project: projectInput,
        session: {
          configSetId: session?.configSetId ?? null,
          modelId: session?.configModelId ?? null,
        },
      }),
    [globalInput, projectInput, session]
  );
  // What would apply WITHOUT the session override: used as the placeholder for
  // an empty model field, so the user sees the value they would inherit.
  const inherited = useMemo(
    () => resolveSettingsLadder({ global: globalInput, project: projectInput, session: null }),
    [globalInput, projectInput]
  );

  const [draftSetId, setDraftSetId] = useState<string>('');
  const [draftModelId, setDraftModelId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraftSetId(session?.configSetId ?? '');
    setDraftModelId(session?.configModelId ?? '');
    setError(null);
  }, [sessionId, session?.configSetId, session?.configModelId]);

  const apply = useCallback(
    async (configSetId: string | null, modelId: string | null) => {
      if (!api) return;
      setBusy(true);
      setError(null);
      try {
        const result = await api.setConfigOverride(sessionId, configSetId, modelId);
        if (!result?.success) {
          setError(t('settingsLevels.saveFailed'));
        }
      } catch {
        setError(t('settingsLevels.saveFailed'));
      } finally {
        setBusy(false);
      }
    },
    [api, sessionId, t]
  );

  const dirty =
    draftSetId !== (session?.configSetId ?? '') || draftModelId !== (session?.configModelId ?? '');
  const configSets = appConfig?.configSets ?? [];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Layers className="h-4 w-4" />
            {t('settingsLevels.title')}
          </h3>
          <p className="text-xs text-text-muted">{t('settingsLevels.subtitle')}</p>
        </div>
        <div className="rounded-lg border border-border px-3 py-2 text-right">
          <div className="text-[11px] uppercase tracking-wide text-text-muted">
            {t('settingsLevels.effective')}
          </div>
          <div className="font-mono text-xs text-text-primary">
            {summarizeValue(ladder) || t('settingsLevels.none')}
          </div>
        </div>
      </header>

      {ladder.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {ladder.warnings.map((warning) => (
            <li key={warning.code + warning.level + (warning.value ?? '')} className="flex gap-2">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {t('settingsLevels.warning.' + warning.code, {
                  level: t(levelLabelKey(warning.level)),
                  value: warning.value ?? '',
                })}
              </span>
            </li>
          ))}
        </ul>
      )}

      <ol className="flex flex-col gap-2" data-testid="settings-levels-ladder">
        {ladder.levels.map((state, index) => {
          const wins = state.decidesConfigSet || state.decidesModel;
          return (
            <li
              key={state.level}
              data-level={state.level}
              data-decides={wins ? 'true' : 'false'}
              className={
                'flex items-start gap-3 rounded-lg border px-3 py-2 ' + LEVEL_STYLE[state.level]
              }
            >
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-semibold text-text-secondary">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-text-primary">
                    {t(levelLabelKey(state.level))}
                  </span>
                  {state.level === 'project' && project && (
                    <span className="truncate text-[11px] text-text-muted">{project.name}</span>
                  )}
                  {state.ignored && (
                    <span className="text-[11px] text-amber-400">
                      {t('settingsLevels.ignored')}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 font-mono text-[11px] text-text-secondary">
                  {state.configSetId || state.modelId
                    ? [
                        state.configSetId
                          ? t('settingsLevels.pinsSet', { id: state.configSetId })
                          : null,
                        state.modelId
                          ? t('settingsLevels.pinsModel', { id: state.modelId })
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : t('settingsLevels.inherits')}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {state.decidesConfigSet && (
                  <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400">
                    {t('settingsLevels.decidesSet')}
                  </span>
                )}
                {state.decidesModel && (
                  <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-400">
                    {t('settingsLevels.decidesModel')}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <section className="flex flex-col gap-2 rounded-lg border border-border px-3 py-3">
        <h4 className="text-xs font-semibold text-text-primary">{t('settingsLevels.override')}</h4>
        <p className="text-[11px] text-text-muted">{t('settingsLevels.overrideHint')}</p>

        <label className="flex flex-col gap-1 text-[11px] text-text-muted">
          {t('settingsLevels.configSet')}
          <select
            value={draftSetId}
            disabled={busy}
            onChange={(event) => setDraftSetId(event.target.value)}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-text-primary"
          >
            <option value="">{t('settingsLevels.inheritOption')}</option>
            {configSets.map((set) => (
              <option key={set.id} value={set.id}>
                {set.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[11px] text-text-muted">
          {t('settingsLevels.model')}
          <input
            type="text"
            value={draftModelId}
            disabled={busy || !draftSetId}
            onChange={(event) => setDraftModelId(event.target.value)}
            placeholder={inherited.model || t('settingsLevels.modelPlaceholder')}
            className="rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-xs text-text-primary"
          />
        </label>

        {error && <p className="text-[11px] text-red-400">{error}</p>}

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || !dirty}
            onClick={() => void apply(draftSetId || null, draftModelId || null)}
            className="flex items-center gap-1.5 rounded-lg border border-accent bg-accent/10 px-3 py-1.5 text-xs text-text-primary disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            {t('settingsLevels.apply')}
          </button>
          <button
            type="button"
            disabled={busy || !session?.configSetId}
            onClick={() => {
              setDraftSetId('');
              setDraftModelId('');
              void apply(null, null);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary disabled:opacity-50"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('settingsLevels.clear')}
          </button>
        </div>
      </section>
    </div>
  );
}
