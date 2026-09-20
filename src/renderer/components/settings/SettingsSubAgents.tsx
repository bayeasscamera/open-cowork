import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsContentSection } from './shared';
import {
  buildConfigSetLites,
  ConfigSetModelPicker,
  type ConfigSetLite,
} from '../shared/ConfigSetModelPicker';

export type SubAgentRoleKey = 'architect' | 'developer' | 'reviewer' | 'security';
export const SUB_AGENT_ROLES: SubAgentRoleKey[] = [
  'architect',
  'developer',
  'reviewer',
  'security',
];

export interface SubAgentsDraft {
  configSetId: string;
  /** Model pinned inside the selected configSet (empty = its active model). */
  modelId?: string;
  perRole: Partial<Record<SubAgentRoleKey, { configSetId: string; modelId?: string }>>;
  timeoutMs: number;
  maxConcurrent: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CONCURRENT = 2;
const MAX_CONCURRENT = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Normalize a UI draft into the persisted sub-agents settings. Mirrors the
 * server-side normalizeSubAgentsConfig clamps so a save never stores a value
 * the store would silently rewrite.
 */
export function buildSubAgentsUpdate(draft: SubAgentsDraft): SubAgentsDraft {
  const perRole: Partial<Record<SubAgentRoleKey, { configSetId: string; modelId?: string }>> = {};
  for (const role of SUB_AGENT_ROLES) {
    const selection = draft.perRole?.[role];
    if (typeof selection?.configSetId === 'string' && selection.configSetId.trim()) {
      perRole[role] = {
        configSetId: selection.configSetId.trim(),
        modelId: typeof selection.modelId === 'string' && selection.modelId.trim() ? selection.modelId.trim() : undefined,
      };
    }
  }
  return {
    configSetId: typeof draft.configSetId === 'string' ? draft.configSetId.trim() : '',
    modelId: typeof draft.modelId === 'string' && draft.modelId.trim() ? draft.modelId.trim() : undefined,
    perRole,
    timeoutMs: clamp(
      Math.round(Number(draft.timeoutMs) || DEFAULT_TIMEOUT_MS),
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS
    ),
    maxConcurrent: clamp(
      Math.round(Number(draft.maxConcurrent) || DEFAULT_MAX_CONCURRENT),
      1,
      MAX_CONCURRENT
    ),
  };
}

const inputClass =
  'rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none';

/** Configure which model profile the multi-agent swarm runs on. */
export function SettingsSubAgents() {
  const { t } = useTranslation();
  const [sets, setSets] = useState<ConfigSetLite[]>([]);
  const [draft, setDraft] = useState<SubAgentsDraft>({
    configSetId: '',
    perRole: {},
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxConcurrent: DEFAULT_MAX_CONCURRENT,
  });
  const [busy, setBusy] = useState(true);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const config = await window.electronAPI.config.get();
      if (id !== requestId.current) return;
      const raw = config as {
        subAgents?: Partial<SubAgentsDraft>;
        configSets?: Array<{
          id: string;
          name: string;
          activeProfileKey?: string;
          profiles?: Record<string, { model?: string; customModels?: string[] }>;
        }>;
      };
      const sub = raw.subAgents;
      setDraft(
        buildSubAgentsUpdate({
          configSetId: sub?.configSetId ?? '',
          modelId: sub?.modelId,
          perRole: sub?.perRole ?? {},
          timeoutMs: sub?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxConcurrent: sub?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        })
      );
      setSets(buildConfigSetLites(raw));
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

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      const result = await window.electronAPI.config.save({
        subAgents: buildSubAgentsUpdate(draft),
      } as Parameters<typeof window.electronAPI.config.save>[0]);
      if (!result.success) {
        setError('saveFailed');
        return;
      }
      const sub = (result.config as { subAgents?: Partial<SubAgentsDraft> }).subAgents;
      setDraft(
        buildSubAgentsUpdate({
          configSetId: sub?.configSetId ?? '',
          modelId: sub?.modelId,
          perRole: sub?.perRole ?? {},
          timeoutMs: sub?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxConcurrent: sub?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        })
      );
      setSaved(true);
    } catch {
      setError('saveFailed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsContentSection title={t('subAgents.title')} description={t('subAgents.description')}>
      <div className="space-y-4 rounded-xl border border-border-muted bg-background-secondary/60 p-4" aria-busy={busy}>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            checked={draft.configSetId !== ''}
            disabled={busy}
            onChange={(e) =>
              setDraft((prev) => ({
                ...prev,
                configSetId: e.target.checked ? sets.find((s) => s.id)?.id ?? '' : '',
              }))
            }
          />
          {t('subAgents.distinct')}
        </label>

        {draft.configSetId !== '' && (
          <div className="flex flex-col gap-2">
            <ConfigSetModelPicker
              sets={sets}
              value={{ configSetId: draft.configSetId, modelId: draft.modelId }}
              onChange={(next) =>
                setDraft((prev) => ({ ...prev, configSetId: next.configSetId, modelId: next.modelId }))
              }
              disabled={busy}
              configSetLabel={t('subAgents.configSet')}
              modelLabel={t('subAgents.model')}
            />
          </div>
        )}

        <details className="text-sm text-text-secondary">
          <summary className="cursor-pointer select-none text-xs text-text-muted">
            {t('subAgents.roleOverrides')}
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {SUB_AGENT_ROLES.map((role) => {
              const selection = draft.perRole[role];
              return (
                <div key={role} className="flex flex-col gap-1">
                  <ConfigSetModelPicker
                    sets={sets}
                    value={{
                      configSetId: selection?.configSetId ?? '',
                      modelId: selection?.modelId,
                    }}
                    onChange={(next) =>
                      setDraft((prev) => ({
                        ...prev,
                        perRole: {
                          ...prev.perRole,
                          [role]: next.configSetId
                            ? { configSetId: next.configSetId, modelId: next.modelId }
                            : undefined,
                        },
                      }))
                    }
                    disabled={busy}
                    configSetLabel={t(`subAgents.role.${role}`)}
                    modelLabel={t('subAgents.model')}
                    allowEmpty
                    emptyLabel={t('subAgents.defaultProfile')}
                  />
                </div>
              );
            })}
          </div>
        </details>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm text-text-secondary">
            {t('subAgents.timeout')}
            <input
              type="number"
              className={`${inputClass} mt-1 w-full`}
              disabled={busy}
              min={10}
              max={300}
              step={10}
              value={Math.round(draft.timeoutMs / 1000)}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, timeoutMs: Number(e.target.value) * 1000 }))
              }
            />
            <span className="mt-1 block text-xs text-text-muted">
              {t('subAgents.timeoutHint', { min: 10, max: 300 })}
            </span>
          </label>
          <label className="text-sm text-text-secondary">
            {t('subAgents.maxConcurrent')}
            <input
              type="number"
              className={`${inputClass} mt-1 w-full`}
              disabled={busy}
              min={1}
              max={8}
              value={draft.maxConcurrent}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, maxConcurrent: Number(e.target.value) }))
              }
            />
            <span className="mt-1 block text-xs text-text-muted">
              {t('subAgents.maxConcurrentHint', { max: 8 })}
            </span>
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button
            className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
            onClick={() => {
              void save();
            }}
          >
            {t('subAgents.save')}
          </button>
          {saved && <span className="text-xs text-text-secondary">{t('subAgents.saved')}</span>}
          {error && <span className="text-xs text-rose-500">{t(`subAgents.${error}`)}</span>}
        </div>
      </div>
    </SettingsContentSection>
  );
}