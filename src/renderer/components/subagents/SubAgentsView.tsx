import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Network, RotateCcw, X } from 'lucide-react';
import { SettingsContentSection } from '../settings/shared';
import {
  buildConfigSetLites,
  ConfigSetModelPicker,
  type ConfigSetLite,
} from '../shared/ConfigSetModelPicker';
import { DelegationSettingsForm } from '../settings/DelegationSettingsForm';
import { ProposedSkillsSection } from '../settings/SettingsSkillDoctor';
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
  perRole: Partial<
    Record<
      SubAgentRoleKey,
      { configSetId: string; modelId?: string; personaName?: string; systemPrompt?: string }
    >
  >;
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
  const perRole: Partial<Record<SubAgentRoleKey, RoleSelection>> = {};
  for (const role of SUB_AGENT_ROLES) {
    const selection = draft.perRole?.[role];
    if (typeof selection?.configSetId === 'string' && selection.configSetId.trim()) {
      perRole[role] = {
        configSetId: selection.configSetId.trim(),
        modelId:
          typeof selection.modelId === 'string' && selection.modelId.trim()
            ? selection.modelId.trim()
            : undefined,
        personaName:
          typeof selection.personaName === 'string' && selection.personaName.trim()
            ? selection.personaName.trim()
            : undefined,
        systemPrompt:
          typeof selection.systemPrompt === 'string' && selection.systemPrompt.trim()
            ? selection.systemPrompt.trim()
            : undefined,
      };
    }
  }
  return {
    configSetId: typeof draft.configSetId === 'string' ? draft.configSetId.trim() : '',
    modelId:
      typeof draft.modelId === 'string' && draft.modelId.trim() ? draft.modelId.trim() : undefined,
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

type RoleSelection = {
  configSetId: string;
  modelId?: string;
  personaName?: string;
  systemPrompt?: string;
};

/** Merge a partial role patch into the existing selection (empty set id clears the role). */
function mergeRoleSelection(
  prev: RoleSelection | undefined,
  patch: Partial<RoleSelection>
): RoleSelection | undefined {
  const merged = { ...(prev ?? { configSetId: '' }), ...patch };
  if (!merged.configSetId?.trim()) return undefined;
  return {
    configSetId: merged.configSetId,
    modelId: merged.modelId?.trim() || undefined,
    personaName: merged.personaName?.trim() || undefined,
    systemPrompt: merged.systemPrompt?.trim() || undefined,
  };
}

const inputClass =
  'rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none';

function OpenJevSection() {
  const { t } = useTranslation();
  const appConfig = useAppStore((s) => s.appConfig);
  const config = appConfig?.openjev ?? { enabled: false, baseUrl: 'http://127.0.0.1:8080' };

  const save = async (next: { enabled?: boolean; baseUrl?: string }) => {
    const merged = { ...config, ...next };
    await window.electronAPI.config.save({ openjev: merged } as never);
  };

  return (
    <SettingsContentSection
      title={t('subAgents.openjevTitle')}
      description={t('subAgents.openjevDescription')}
    >
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        {t('subAgents.openjevEnable')}
      </label>
      {config.enabled && (
        <label className="block text-sm text-text-secondary">
          {t('subAgents.openjevUrl')}
          <input
            type="text"
            defaultValue={config.baseUrl}
            onBlur={(e) => void save({ baseUrl: e.target.value.trim() })}
            className={`${inputClass} mt-1 w-full max-w-md`}
            placeholder="http://127.0.0.1:8080"
          />
          <span className="mt-1 block text-xs text-text-muted">{t('subAgents.openjevHint')}</span>
        </label>
      )}
    </SettingsContentSection>
  );
}

/**
 * The sub-agents interface: role personas, per-role model selector, guardrails,
 * async delegations, pending skill proposals and cost transparency.
 *
 * One implementation, two hosts: the dedicated sidebar view (no onClose, so the
 * close button clears `subAgentsVisible`) and the Settings → Sub-agents tab,
 * which passes the settings panel's own close handler. Both persist through the
 * SAME IPC config.get/config.save channel.
 */
export function SubAgentsView({ onClose }: { onClose?: () => void } = {}) {
  const { t } = useTranslation();
  const setSubAgentsVisible = useAppStore((s) => s.setSubAgentsVisible);
  // Settings hosts this interface too; there the close button must dismiss the
  // settings panel rather than the sidebar view.
  const handleClose = (): void => {
    if (onClose) onClose();
    else setSubAgentsVisible(false);
  };
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
    <div className="flex h-full w-full overflow-hidden bg-background">
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div className="flex items-center justify-between px-4 lg:px-8 py-4 border-b border-border-muted flex-shrink-0 panel-glass">
          <div>
            <p className="text-[11px] text-text-muted flex items-center gap-1.5">
              <Network className="w-3 h-3" />
              {t('subAgentsView.eyebrow')}
            </p>
            <h3 className="mt-1 text-[1.3rem] font-semibold tracking-[-0.03em] text-text-primary">
              {t('subAgentsView.title')}
            </h3>
            <div className="accent-underline mt-1.5 w-14" />
            <p className="mt-2 text-sm text-text-muted max-w-[36rem]">
              {t('subAgentsView.description')}
            </p>
          </div>
          <button
            onClick={handleClose}
            className="p-2 rounded-lg hover:bg-surface-hover transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5 text-text-secondary" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 lg:px-8 lg:py-8">
          <div className="max-w-[860px] w-full min-w-0 mx-auto">
            <div className="space-y-0">
              <ProfileSection t={t} sets={sets} draft={draft} busy={busy} setDraft={setDraft} />

              <GuardrailsSection t={t} draft={draft} busy={busy} setDraft={setDraft} />

              <OpenJevSection />

              <section className="space-y-3 py-5 border-b border-border-muted">
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold text-text-primary">
                    {t('subAgents.delegationTitle')}
                  </h4>
                  <p className="text-xs leading-5 text-text-muted">
                    {t('subAgents.delegationDescription')}
                  </p>
                </div>
                {/* Same form the tracking panel's gear renders — one implementation. */}
                <DelegationSettingsForm />
              </section>

              {/* Pending skill proposals — the same human-gated section the
                  Skill doctor renders (one implementation, two hosts). */}
              <ProposedSkillsSection />

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
                {saved && (
                  <span className="text-xs text-text-secondary">{t('subAgents.saved')}</span>
                )}
                {error && <span className="text-xs text-rose-500">{t(`subAgents.${error}`)}</span>}
                <span className="text-[11px] text-text-muted">{t('subAgents.saveScopeHint')}</span>
              </div>
            </div>
          </div>
        </div>
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
    <SettingsContentSection
      title={t('subAgents.profileTitle')}
      description={t('subAgents.profileDescription')}
    >
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input
          type="checkbox"
          checked={draft.configSetId !== ''}
          disabled={busy}
          onChange={(e) =>
            setDraft((prev) => ({
              ...prev,
              configSetId: e.target.checked ? (sets.find((s) => s.id)?.id ?? '') : '',
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
              setDraft((prev) => ({
                ...prev,
                configSetId: next.configSetId,
                modelId: next.modelId,
              }))
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
            const patch = (
              p: Partial<{
                configSetId: string;
                modelId?: string;
                personaName?: string;
                systemPrompt?: string;
              }>
            ) =>
              setDraft((prev) => ({
                ...prev,
                perRole: {
                  ...prev.perRole,
                  [role]: mergeRoleSelection(prev.perRole[role], p),
                },
              }));
            return (
              <div
                key={role}
                className="flex flex-col gap-1.5 rounded-lg border border-border-subtle p-2"
              >
                <ConfigSetModelPicker
                  sets={sets}
                  value={{
                    configSetId: selection?.configSetId ?? '',
                    modelId: selection?.modelId,
                  }}
                  onChange={(next) =>
                    patch({ configSetId: next.configSetId, modelId: next.modelId ?? undefined })
                  }
                  disabled={busy}
                  configSetLabel={t(`subAgents.role.${role}`)}
                  modelLabel={t('subAgents.model')}
                  allowEmpty
                  emptyLabel={t('subAgents.defaultProfile')}
                />
                {selection && (
                  <>
                    <input
                      type="text"
                      value={selection.personaName ?? ''}
                      onChange={(e) => patch({ personaName: e.target.value })}
                      placeholder={t('subAgents.personaNamePlaceholder')}
                      className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                    />
                    <textarea
                      value={selection.systemPrompt ?? ''}
                      onChange={(e) => patch({ systemPrompt: e.target.value })}
                      placeholder={t('subAgents.systemPromptPlaceholder')}
                      rows={3}
                      className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12px] leading-5 text-text-primary focus:border-accent focus:outline-none"
                    />
                  </>
                )}
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
    <SettingsContentSection
      title={t('subAgents.guardrailsTitle')}
      description={t('subAgents.guardrailsDescription')}
    >
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

function CostSection({ t }: { t: (key: string, options?: Record<string, unknown>) => string }) {
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setSubAgentsVisible = useAppStore((s) => s.setSubAgentsVisible);
  const [stats, setStats] = useState<{ swarm: SwarmStats; delegations: DelegationStats } | null>(
    null
  );
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

  const openSkillDoctor = () => {
    // Leave the dedicated view, land on Settings › Skills (Skill doctor lives there).
    setSubAgentsVisible(false);
    setShowSettings(true);
    setSettingsTab('skills');
  };

  return (
    <>
      <SettingsContentSection
        title={t('subAgents.costTitle')}
        description={t('subAgents.costDescription')}
      >
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
                    date: new Intl.DateTimeFormat(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(swarm.lastRunAt)),
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

      <SettingsContentSection
        title={t('subAgents.diagnosticsTitle')}
        description={t('subAgents.diagnosticsDescription')}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label={t('subAgents.statSwarms')}
            value={swarm ? String(swarm.totalSwarms) : '—'}
            loading={loading}
          />
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
              deleg ? `${deleg.completed + deleg.failed + deleg.cancelled}/${deleg.total}` : '—'
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
            onClick={openSkillDoctor}
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

function Stat({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-muted/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-text-primary">{loading ? '…' : value}</div>
    </div>
  );
}
