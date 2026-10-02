import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';

import { SettingsContentSection } from './shared';

/**
 * Read-only view of the agent presets, plus the approve / reject actions for
 * pending proposals.
 *
 * The approval checkbox is rendered from `consentReasons`, not from a hardcoded
 * "this is dangerous" label: the reason text comes from the preset itself, so
 * the user consents to the specific capability being granted rather than to a
 * generic warning.
 *
 * Approve is the only mutating action here, and it goes through the main
 * process, which refuses a capability-changing preset without explicit
 * consent — this panel is the surface for that consent, not the enforcement.
 */

type PresetSummary = {
  id: string;
  label: string;
  description?: string;
  presentation: 'direct' | 'code';
  builtin: boolean;
  allowFork: boolean;
  maxDepth: number;
  tools: string[];
  pruner: {
    thresholdChars: number;
    headChars: number;
    tailChars: number;
    compactionThresholdChars?: number;
  };
  consentReasons: string[];
};

type Proposal = {
  id: string;
  proposedBy: string;
  proposedAt: number;
  version: number;
  rationale?: string;
  requiresConsent: boolean;
  consentReasons: string[];
  preset: { label: string };
};

type Overview = {
  presets: PresetSummary[];
  proposals: Proposal[];
  issues: Array<{ id: string; file: string; errors: string[] }>;
  knownTools: string[];
};

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export function SettingsPresets({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Consent is per proposal id: approving one must not silently pre-check the
  // next one.
  const [consented, setConsented] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (!isElectron) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.electronAPI.presets.overview();
      setOverview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('presets.loadFailed'));
    } finally {
      setBusy(false);
    }
  }, [t]);

  useEffect(() => {
    if (isActive) void load();
  }, [isActive, load]);

  const approve = async (proposal: Proposal) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.electronAPI.presets.approve(
        proposal.id,
        consented[proposal.id] === true
      );
      if (result.success) {
        setNotice(t('presets.approved'));
        // The draft is consumed on approval, so its consent is spent.
        setConsented((previous) => ({ ...previous, [proposal.id]: false }));
        await load();
      } else {
        setError(result.error || t('presets.approveFailed'));
      }
    } catch {
      setError(t('presets.approveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const reject = async (proposal: Proposal) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await window.electronAPI.presets.reject(proposal.id);
      if (result.success) {
        setNotice(t('presets.rejected'));
        await load();
      } else {
        setError(result.error || t('presets.rejectFailed'));
      }
    } catch {
      setError(t('presets.rejectFailed'));
    } finally {
      setBusy(false);
    }
  };

  const builtin = (overview?.presets ?? []).filter((preset) => preset.builtin);
  const user = (overview?.presets ?? []).filter((preset) => !preset.builtin);

  return (
    <div className="space-y-6">
      <SettingsContentSection title={t('presets.title')} description={t('presets.description')}>
        {error && (
          <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            {notice}
          </div>
        )}

        {overview && overview.presets.length === 0 && !busy && (
          <p className="text-sm text-text-muted">{t('presets.empty')}</p>
        )}
        {busy && !overview && (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}

        {builtin.length > 0 && (
          <div className="mb-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {t('presets.builtin')}
            </h4>
            <div className="space-y-2">
              {builtin.map((preset) => (
                <PresetRow key={preset.id} preset={preset} />
              ))}
            </div>
          </div>
        )}

        {user.length > 0 && (
          <div className="mb-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {t('presets.user')}
            </h4>
            <div className="space-y-2">
              {user.map((preset) => (
                <PresetRow key={preset.id} preset={preset} />
              ))}
            </div>
          </div>
        )}

        {overview && overview.proposals.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {t('presets.proposed')}
            </h4>
            <div className="space-y-3">
              {overview.proposals.map((proposal) => (
                <div
                  key={proposal.id}
                  className="rounded-lg border border-border bg-background p-3"
                  data-testid={`preset-proposal-${proposal.id}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">
                          {proposal.preset.label}
                        </span>
                        <code className="text-[11px] text-text-muted">{proposal.id}</code>
                        {proposal.requiresConsent && (
                          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                            {t('presets.consentRequired')}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-text-muted">
                        {t('presets.proposedBy')}: {proposal.proposedBy}
                      </div>
                      {proposal.rationale && (
                        <div className="mt-1 text-xs text-text-secondary">
                          {t('presets.rationale')}: {proposal.rationale}
                        </div>
                      )}
                      {proposal.consentReasons.map((reason) => (
                        <p
                          key={reason}
                          className="mt-2 flex items-start gap-1.5 text-xs text-amber-300"
                        >
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          <span>{reason}</span>
                        </p>
                      ))}
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        onClick={() => void approve(proposal)}
                        disabled={busy}
                        className="flex items-center gap-1 rounded bg-accent px-2.5 py-1.5 text-xs text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                        data-testid={`preset-approve-${proposal.id}`}
                      >
                        <Check className="h-3 w-3" />
                        {t('presets.approve')}
                      </button>
                      <button
                        onClick={() => void reject(proposal)}
                        disabled={busy}
                        className="flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
                        data-testid={`preset-reject-${proposal.id}`}
                      >
                        <X className="h-3 w-3" />
                        {t('presets.reject')}
                      </button>
                    </div>
                  </div>
                  {proposal.requiresConsent && (
                    <label className="mt-2 flex items-start gap-2 text-xs text-text-secondary">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={consented[proposal.id] === true}
                        onChange={(event) =>
                          setConsented((previous) => ({
                            ...previous,
                            [proposal.id]: event.target.checked,
                          }))
                        }
                        data-testid={`preset-consent-${proposal.id}`}
                      />
                      <span>{t('presets.consentCheckbox')}</span>
                    </label>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {overview && overview.issues.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
              {t('presets.issues')}
            </h4>
            {overview.issues.map((issue) => (
              <div key={`${issue.id}-${issue.file}`} className="mb-2 text-xs text-amber-300">
                <div className="font-medium">
                  {t('presets.errorTitle')}: {issue.id}
                </div>
                {issue.errors.map((message) => (
                  <div key={message} className="text-text-muted">
                    {message}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </SettingsContentSection>
    </div>
  );
}

function PresetRow({ preset }: { preset: PresetSummary }) {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-lg border border-border bg-background p-3"
      data-testid={`preset-row-${preset.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text-primary">{preset.label}</span>
        <code className="text-[11px] text-text-muted">{preset.id}</code>
        {preset.presentation === 'code' && (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            {t('presets.presentationCode')}
          </span>
        )}
      </div>
      {preset.description && (
        <p className="mt-1 text-xs text-text-secondary">{preset.description}</p>
      )}

      {/* Warnings state the concrete consequence, not a generic "be careful". */}
      {preset.presentation === 'code' && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{t('presets.codeModeWarning')}</span>
        </p>
      )}
      {preset.pruner.thresholdChars >= 384000 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{t('presets.longContextWarning')}</span>
        </p>
      )}

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-text-muted sm:grid-cols-4">
        <div>
          <dt className="inline">{t('presets.presentation')}: </dt>
          <dd className="inline text-text-secondary">
            {preset.presentation === 'code'
              ? t('presets.presentationCode')
              : t('presets.presentationDirect')}
          </dd>
        </div>
        <div>
          <dt className="inline">{t('presets.maxDepth')}: </dt>
          <dd className="inline text-text-secondary">{preset.maxDepth}</dd>
        </div>
        <div>
          <dt className="inline">{t('presets.allowFork')}: </dt>
          <dd className="inline text-text-secondary">
            {preset.allowFork ? t('presets.yes') : t('presets.no')}
          </dd>
        </div>
        <div>
          <dt className="inline">{t('presets.prunerThreshold')}: </dt>
          <dd className="inline text-text-secondary">{preset.pruner.thresholdChars}</dd>
        </div>
        <div className="col-span-2 sm:col-span-4">
          <dt className="inline">{t('presets.tools')}: </dt>
          <dd className="inline text-text-secondary">{preset.tools.join(', ')}</dd>
        </div>
      </dl>
    </div>
  );
}
