import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RotateCcw } from 'lucide-react';
import { SettingsContentSection } from './shared';
import {
  buildConfigSetLites,
  ConfigSetModelPicker,
  type ConfigSetLite,
} from '../shared/ConfigSetModelPicker';
import { DelegationSettingsForm } from './DelegationSettingsForm';
import { useAppStore } from '../../store';
import type { DelegationStats, SwarmStats } from '../../types';

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

/** Configure the multi-agent swarm AND the async delegation mode in one screen. */
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
    <div className="space-y-0">
      <ProfileSection
        t={t}
        sets={sets}
        draft={draft}
        busy={busy}
        setDraft={setDraft}
      />

      <GuardrailsSection t={t} draft={draft} busy={busy} setDraft={setDraft} />

      <section className="space-y-3 py-5 border-b border-border-muted">
        <div className="space-y-1">
          <h4 className="text-sm font-semibold text-text-primary">
            {t('subAgents.delegationTitle')}
          </h4>
          <p className="text-xs leading-5 text-text-muted">{t('subAgents.delegationDescription')}</p>
        </div>
        {/* Same form the tracking panel's gear renders — one implementation. */}
        <DelegationSettingsForm />
      </section>

      <CostSection t={t} />

      <div className="flex items-center gap-3 py-5">
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
        <span className="text-[11px] text-text-muted">{t('subAgents.saveScopeHint')}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — model profile
// ─────────────────────────────────────────────────────────────────────────────

function ProfileSection({
  t,
  sets,
  draft,
  busy,
  setDraft,
}: {
  t: (key: string, options?: Record<string, unknown>) => string;
  sets: ConfigSetLite[];
  draft: SubAgentsDraft;
  busy: boolean;
  setDraft: React.Dispatch<React.SetStateAction<SubAgentsDraft>>;
}) {
  return (
    <SettingsContentSection title={t('subAgents.profileTitle')} description={t('subAgents.profileDescription')}>
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
    </SettingsContentSection>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — execution guardrails (incl. the visible fallback policy)
// ─────────────────────────────────────────────────────────────────────────────

function GuardrailsSection({
  t,
  draft,
  busy,
  setDraft,
}: {
  t: (key: string, options?: Record<string, unknown>) => string;
  draft: SubAgentsDraft;
  busy: boolean;
  setDraft: React.Dispatch<React.SetStateAction<SubAgentsDraft>>;
}) {
  return (
    <SettingsContentSection title={t('subAgents.guardrailsTitle')} description={t('subAgents.guardrailsDescription')}>
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
      <p className="rounded-lg border border-border-subtle bg-surface-muted/40 px-3 py-2 text-xs leading-5 text-text-secondary">
        {t('subAgents.fallbackPolicy')}
      </p>
    </SettingsContentSection>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 4 — cost & transparency (measured swarm cost + last run)
// Section 5 — diagnostics (execution stats + skill-doctor link)
// ─────────────────────────────────────────────────────────────────────────────

function CostSection({
  t,
}: {
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const [stats, setStats] = useState<{ swarm: SwarmStats; delegations: DelegationStats } | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.backgroundTasks.getStats();
      if (result.success && result.swarm && result.delegations) {
        setStats({ swarm: result.swarm, delegations: result.delegations });
      }
    } catch {
      // stats optional — keep last snapshot
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const swarm = stats?.swarm;
  const deleg = stats?.delegations;
  const pct = (part: number, total: number) =>
    total > 0 ? `${Math.round((part / total) * 100)} %` : '—';
  const lastRunSeconds = swarm?.lastRunMs ? Math.round(swarm.lastRunMs / 1000) : null;

  return (
    <>
      <SettingsContentSection title={t('subAgents.costTitle')} description={t('subAgents.costDescription')}>
        <ul className="list-disc pl-5 text-xs leading-5 text-text-secondary space-y-1">
          <li>{t('subAgents.costMeasured')}</li>
          <li>{t('subAgents.costWhenToUse')}</li>
        </ul>
        {swarm && (
          <div className="rounded-lg border border-border-subtle bg-surface-muted/40 px-3 py-2 text-xs text-text-secondary">
            {swarm.lastRunAt && lastRunSeconds !== null ? (
              <>
                <p>
                  {t('subAgents.lastSwarmRun', {
                    seconds: lastRunSeconds,
                    date: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
                      new Date(swarm.lastRunAt)
                    ),
                  })}
                </p>
                <p className="mt-1">
                  {swarm.lastRunTokens
                    ? t('subAgents.lastSwarmTokens', {
                        input: swarm.lastRunTokens.input,
                        output: swarm.lastRunTokens.output,
                      })
                    : t('subAgents.tokensUnavailable')}
                </p>
              </>
            ) : (
              <p>{t('subAgents.noSwarmRunYet')}</p>
            )}
          </div>
        )}
      </SettingsContentSection>

      <SettingsContentSection title={t('subAgents.diagnosticsTitle')} description={t('subAgents.diagnosticsDescription')}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t('subAgents.statSwarms')} value={swarm ? String(swarm.totalSwarms) : '—'} loading={loading} />
          <Stat
            label={t('subAgents.statSuccessRate')}
            value={swarm ? pct(swarm.succeededSwarms, swarm.totalSwarms) : '—'}
            loading={loading}
          />
          <Stat
            label={t('subAgents.statFallbackRate')}
            value={swarm ? pct(swarm.fallbackTasks, swarm.totalTasks) : '—'}
            loading={loading}
          />
          <Stat
            label={t('subAgents.statDelegations')}
            value={
              deleg
                ? `${deleg.completed + deleg.failed + deleg.cancelled}/${deleg.total}`
                : '—'
            }
            loading={loading}
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-60"
          >
            <RotateCcw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            {t('subAgents.refreshStats')}
          </button>
          <button
            onClick={() => {
              setShowSettings(true);
              setSettingsTab('skills');
            }}
            className="flex items-center gap-1.5 text-xs text-accent hover:underline"
          >
            <ExternalLink className="w-3 h-3" />
            {t('subAgents.skillDoctorLink')}
          </button>
        </div>
      </SettingsContentSection>
    </>
  );
}

function Stat({
  label,
  value,
  loading,
}: {
  label: string;
  value: string;
  loading: boolean;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-muted/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-text-primary">
        {loading ? '…' : value}
      </div>
    </div>
  );
}