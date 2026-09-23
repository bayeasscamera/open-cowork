import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cpu, RefreshCw, Trash2, X } from 'lucide-react';
import type {
  LocalProviderProbe,
  ModelBenchmark,
  ModelProfile,
  ModelProfileId,
  ModelRoutingState,
  RegistryValidation,
  RoutingDecision,
  RoutingRequest,
  TaskKind,
} from '../../shared/model-routing-types';
import { TASK_KINDS } from '../../shared/model-routing-types';

const CAPABILITY_KEYS: Array<'tools' | 'vision' | 'json'> = ['tools', 'vision', 'json'];

/**
 * Cowork 4.0 — Phase 7: model routing and local-first settings. Shows the named
 * profiles, routes a task with visible justification, keeps the local benchmark,
 * detects local inference servers and validates registry entries before download.
 */
export function ModelRoutingPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI?.modelRouting : undefined;

  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [benchmarks, setBenchmarks] = useState<ModelBenchmark[]>([]);
  const [routing, setRouting] = useState<ModelRoutingState | null>(null);
  const [taskKind, setTaskKind] = useState<TaskKind>('implementation');
  const [requiresTools, setRequiresTools] = useState(true);
  const [requiresVision, setRequiresVision] = useState(false);
  const [requiresJson, setRequiresJson] = useState(false);
  const [confidential, setConfidential] = useState(false);
  const [decision, setDecision] = useState<RoutingDecision | null>(null);
  const [probes, setProbes] = useState<LocalProviderProbe[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [repoId, setRepoId] = useState('');
  const [registryUrl, setRegistryUrl] = useState('');
  const [sha256, setSha256] = useState('');
  const [validation, setValidation] = useState<RegistryValidation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const [nextProfiles, nextBenchmarks, nextRouting] = await Promise.all([
        api.profiles(),
        api.benchmarks(),
        api.state(),
      ]);
      setProfiles(nextProfiles);
      setBenchmarks(nextBenchmarks);
      setRouting(nextRouting);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (!api) {
        return;
      }
      try {
        setRouting(await api.setEnabled(enabled));
        setError(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [api]
  );

  const toggleProfile = useCallback(
    async (profile: ModelProfileId) => {
      if (!api) {
        return;
      }
      try {
        setRouting(await api.setActiveProfile(routing?.activeProfile === profile ? null : profile));
        setError(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [api, routing]
  );

  const route = useCallback(async () => {
    if (!api) {
      return;
    }
    const request: RoutingRequest = { taskKind, requiresTools, requiresVision, requiresJson, confidential };
    try {
      setDecision(await api.route(request));
      setError(null);
    } catch (err: unknown) {
      setDecision(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, confidential, requiresJson, requiresTools, requiresVision, taskKind]);

  const detect = useCallback(async () => {
    if (!api) {
      return;
    }
    setDetecting(true);
    try {
      setProbes(await api.probeLocal());
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  }, [api]);

  const validate = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      setValidation(
        await api.validateRegistry({
          repoId,
          url: registryUrl.trim() || undefined,
          sha256: sha256.trim() || undefined,
        })
      );
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, registryUrl, repoId, sha256]);

  const checkbox = (checked: boolean, onChange: (next: boolean) => void, label: string) => (
    <label className="flex items-center gap-1.5 text-xs text-text-secondary">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between border-b border-border-subtle px-6 py-4">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Cpu className="h-4 w-4" />
            {t('modelRouting.title')}
          </h2>
          <p className="text-xs text-text-muted">{t('modelRouting.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            aria-label={t('modelRouting.refresh')}
            className="rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('modelRouting.close')}
            className="rounded-lg border border-border px-2 py-1.5 text-xs text-text-secondary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 space-y-5 overflow-y-auto px-6 py-4">
        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-text-secondary">{t('modelRouting.adaptive.title')}</h3>
          <p className="text-[11px] text-text-muted">
            {t('modelRouting.adaptive.description')}
          </p>
          <label className="flex items-center gap-1.5 text-xs text-text-secondary">
            <input
              type="checkbox"
              disabled={!api}
              checked={routing?.enabled ?? false}
              onChange={(event) => void setEnabled(event.target.checked)}
            />
            {t('modelRouting.adaptive.enabled')}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                disabled={!api}
                aria-pressed={routing?.activeProfile === profile.id}
                onClick={() => void toggleProfile(profile.id)}
                className={
                  'rounded-lg border px-3 py-1 text-xs transition-colors disabled:opacity-40 ' +
                  (routing?.activeProfile === profile.id
                    ? 'border-accent bg-accent/10 text-text-primary'
                    : 'border-border text-text-secondary hover:bg-surface-hover')
                }
              >
                {t('modelRouting.adaptive.use', { profile: profile.label })}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-text-muted">
            {routing?.activeProfile
              ? t('modelRouting.adaptive.active', { profile: routing.activeProfile })
              : t('modelRouting.adaptive.inactive')}
          </p>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-text-secondary">{t('modelRouting.profiles.title')}</h3>
          <div className="grid grid-cols-2 gap-2">
            {profiles.map((profile) => (
              <div
                key={profile.id}
                className="rounded-xl border border-border-subtle bg-background/60 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-text-primary">{profile.label}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                    {profile.id}
                  </span>
                  <span className="ml-auto text-[10px] text-text-muted">
                    {t('modelRouting.profiles.cost', { tier: profile.costTier })}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-text-muted">
                  {profile.provider}/{profile.model}
                </p>
                <p className="mt-1 text-[11px] text-text-muted">{profile.description}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px]">
                  {CAPABILITY_KEYS.filter((key) => profile.capabilities[key]).map((key) => (
                    <span key={key} className="rounded border border-border px-1.5 py-0.5 text-text-muted">
                      {t('modelRouting.profiles.capability.' + key)}
                    </span>
                  ))}
                  <span className={profile.capabilities.local ? 'text-emerald-500' : 'text-text-muted'}>
                    {profile.capabilities.local
                      ? t('modelRouting.profiles.local')
                      : t('modelRouting.profiles.remote')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-text-secondary">{t('modelRouting.route.title')}</h3>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={taskKind}
              onChange={(event) => setTaskKind(event.target.value as TaskKind)}
              className="rounded-lg border border-border bg-background px-2 py-1 text-xs text-text-primary"
            >
              {TASK_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t('modelRouting.route.taskKind.' + kind)}
                </option>
              ))}
            </select>
            {checkbox(requiresTools, setRequiresTools, t('modelRouting.route.requiresTools'))}
            {checkbox(requiresVision, setRequiresVision, t('modelRouting.route.requiresVision'))}
            {checkbox(requiresJson, setRequiresJson, t('modelRouting.route.requiresJson'))}
            {checkbox(confidential, setConfidential, t('modelRouting.route.confidential'))}
            <button
              type="button"
              disabled={!api}
              onClick={() => void route()}
              className="rounded-lg border border-accent bg-accent/10 px-3 py-1 text-xs text-text-primary disabled:opacity-40"
            >
              {t('modelRouting.route.run')}
            </button>
          </div>
          {decision && (
            <div className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-text-primary">
                  {t('modelRouting.route.decision')}
                </span>
                <span className="font-mono">
                  {decision.provider}/{decision.model}
                </span>
                <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                  {decision.profileId}
                </span>
                <span className={decision.local ? 'text-emerald-500' : 'text-text-muted'}>
                  {decision.local ? t('modelRouting.profiles.local') : t('modelRouting.profiles.remote')}
                </span>
                {decision.estimatedCostUsd !== null && (
                  <span className="text-text-muted">
                    {t('modelRouting.route.estimatedCost', { cost: decision.estimatedCostUsd })}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] text-text-muted">{decision.reason}</p>
              {decision.fallbacks.length > 0 && (
                <p className="mt-1 text-[10px] text-text-muted">
                  {t('modelRouting.route.fallbacks')}: {decision.fallbacks.join(', ')}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-text-secondary">
              {t('modelRouting.benchmarks.title')}
            </h3>
            <button
              type="button"
              disabled={!api || benchmarks.length === 0}
              onClick={() => api && void api.clearBenchmarks().then(refresh)}
              className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-text-secondary disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" />
              {t('modelRouting.benchmarks.clear')}
            </button>
          </div>
          {benchmarks.length === 0 ? (
            <p className="text-xs text-text-muted">{t('modelRouting.benchmarks.empty')}</p>
          ) : (
            <table className="w-full text-left text-[11px]">
              <thead className="text-text-muted">
                <tr>
                  <th className="py-1">{t('modelRouting.benchmarks.model')}</th>
                  <th className="py-1">{t('modelRouting.benchmarks.task')}</th>
                  <th className="py-1">{t('modelRouting.benchmarks.runs')}</th>
                  <th className="py-1">{t('modelRouting.benchmarks.success')}</th>
                  <th className="py-1">{t('modelRouting.benchmarks.score')}</th>
                </tr>
              </thead>
              <tbody className="text-text-secondary">
                {benchmarks.map((benchmark) => (
                  <tr key={benchmark.modelId + '::' + benchmark.taskKind}>
                    <td className="py-1 font-mono">{benchmark.modelId}</td>
                    <td className="py-1">{benchmark.taskKind}</td>
                    <td className="py-1">{benchmark.runs}</td>
                    <td className="py-1">
                      {Math.round((benchmark.successes / benchmark.runs) * 100)}%
                    </td>
                    <td className="py-1">{benchmark.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-3">
            <h3 className="text-xs font-medium text-text-secondary">
              {t('modelRouting.local.title')}
            </h3>
            <button
              type="button"
              disabled={!api || detecting}
              onClick={() => void detect()}
              className="rounded-lg border border-border px-2 py-1 text-xs text-text-secondary disabled:opacity-40"
            >
              {detecting ? t('modelRouting.local.detecting') : t('modelRouting.local.detect')}
            </button>
          </div>
          {probes.length > 0 && (
            <ul className="space-y-1.5">
              {probes.map((probe) => (
                <li
                  key={probe.kind}
                  className="rounded-lg border border-border-subtle bg-background/60 px-3 py-2 text-[11px]"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-primary">
                      {t('modelRouting.local.kind.' + probe.kind)}
                    </span>
                    <span className="font-mono text-text-muted">{probe.baseUrl}</span>
                    <span className={probe.reachable ? 'text-emerald-500' : 'text-text-muted'}>
                      {probe.reachable
                        ? t('modelRouting.local.reachable')
                        : t('modelRouting.local.unreachable')}
                    </span>
                  </div>
                  {probe.error && <p className="mt-1 text-[10px] text-red-400">{probe.error}</p>}
                  <p className="mt-1 text-[10px] text-text-muted">
                    {probe.models.length > 0
                      ? probe.models.join(', ')
                      : t('modelRouting.local.noModels')}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-medium text-text-secondary">
            {t('modelRouting.registry.title')}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={repoId}
              onChange={(event) => setRepoId(event.target.value)}
              placeholder={t('modelRouting.registry.repoId')}
              className="w-64 rounded-lg border border-border bg-background px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
            />
            <input
              value={registryUrl}
              onChange={(event) => setRegistryUrl(event.target.value)}
              placeholder={t('modelRouting.registry.url')}
              className="w-72 rounded-lg border border-border bg-background px-2 py-1 text-xs text-text-primary outline-none focus:border-accent"
            />
            <input
              value={sha256}
              onChange={(event) => setSha256(event.target.value)}
              placeholder={t('modelRouting.registry.sha256')}
              className="w-64 rounded-lg border border-border bg-background px-2 py-1 font-mono text-xs text-text-primary outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={!api}
              onClick={() => void validate()}
              className="rounded-lg border border-border px-3 py-1 text-xs text-text-secondary disabled:opacity-40"
            >
              {t('modelRouting.registry.validate')}
            </button>
          </div>
          {validation && (
            <div
              className={
                'rounded-lg border px-3 py-2 text-[11px] ' +
                (validation.valid
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
                  : 'border-red-500/40 bg-red-500/10 text-red-400')
              }
            >
              <span>
                {validation.valid ? t('modelRouting.registry.valid') : t('modelRouting.registry.invalid')}
              </span>
              {validation.normalizedUrl && (
                <p className="mt-1 font-mono text-text-muted">{validation.normalizedUrl}</p>
              )}
              {validation.reasons.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-text-muted">
                  {validation.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              {validation.suggestedProfile && (
                <p className="mt-1 text-text-muted">
                  {t('modelRouting.registry.suggested', { profile: validation.suggestedProfile })}
                </p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
