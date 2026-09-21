import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { SettingsContentSection } from './shared';

interface DoctorEntry {
  name: string;
  path: string;
  tokenEstimate: number;
  useCount: number;
  lastUsedAt: number | null;
  recommendation: 'disable' | 'keep';
}

interface DoctorReport {
  entries: DoctorEntry[];
  totalSkillTokens: number;
  contextWindow: number | null;
}

interface SkillProposal {
  name: string;
  description: string;
  proposedBy: string;
  proposedAt: number;
  version: number;
  rationale?: string;
  path: string;
  content: string;
}

/**
 * PENDING skill proposals (from sub-agents or the auto-synthesizer) with the
 * MANDATORY manual gate: Approve moves the draft into the active skills
 * directory (making it the ONLY activation path), Reject deletes it. Until one
 * of those two buttons is pressed, the proposal is inert — nothing loads it
 * and nothing executes it.
 */
export function ProposedSkillsSection({ onChanged }: { onChanged?: () => void }) {
  const { t } = useTranslation();
  const [proposals, setProposals] = useState<SkillProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const id = Math.random().toString(36).slice(2);
    setBusy(true);
    try {
      const result = await window.electronAPI.skills.listProposals();
      if (result.success) setProposals(result.proposals);
      void id;
    } catch {
      setActionError('failed');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Inline rename flow state — shown when approve hits a name conflict. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const act = async (name: string, action: 'approve' | 'reject', renameTo?: string) => {
    setActionError(null);
    setNotice(null);
    try {
      const result =
        action === 'approve'
          ? await window.electronAPI.skills.approveProposal(name, renameTo)
          : await window.electronAPI.skills.rejectProposal(name);
      if (!result.success) {
        if (action === 'approve' && result.code === 'name_conflict') {
          // Offer the approve-as-rename flow instead of failing bluntly.
          setRenaming(name);
          setRenameValue(`${name}-2`);
          setActionError(t('skillDoctor.proposals.conflictHint', { name }));
        } else {
          setActionError(result.error ?? t('skillDoctor.proposals.actionFailed'));
        }
        return;
      }
      const finalName = action === 'approve' && 'name' in result ? result.name ?? name : name;
      setNotice(
        action === 'approve'
          ? t('skillDoctor.proposals.approvedNotice', {
              name: renameTo?.trim() ? `${name} → ${finalName}` : finalName,
            })
          : t('skillDoctor.proposals.rejectedNotice', { name })
      );
      setRenaming(null);
      await refresh();
      onChanged();
    } catch {
      setActionError(t('skillDoctor.proposals.actionFailed'));
    }
  };

  return (
    <SettingsContentSection
      title={t('skillDoctor.proposals.title')}
      description={t('skillDoctor.proposals.description')}
    >
      <p className="rounded-lg border border-border-subtle bg-surface-muted/40 px-3 py-2 text-xs leading-5 text-text-secondary">
        {t('skillDoctor.proposals.securityNote')}
      </p>
      {notice && <p className="text-xs text-emerald-500">{notice}</p>}
      {actionError && (
        <p role="alert" className="text-xs text-rose-500">
          {actionError}
        </p>
      )}
      {!busy && proposals.length === 0 && (
        <p className="text-sm text-text-muted">{t('skillDoctor.proposals.empty')}</p>
      )}
      {proposals.map((proposal) => (
        <div
          key={proposal.name}
          className="rounded-lg border border-border-subtle bg-background px-3 py-2.5"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-text-primary truncate">
                  {proposal.name}
                </span>
                <span className="rounded-full border border-accent/40 px-1.5 py-px text-[9px] font-medium text-accent">
                  {t('skillDoctor.proposals.pendingTag')}
                </span>
              </div>
              <p className="mt-0.5 text-xs leading-5 text-text-secondary">
                {proposal.description}
              </p>
              <p className="mt-1 text-[11px] text-text-muted">
                {t('skillDoctor.proposals.meta', {
                  by: proposal.proposedBy,
                  version: proposal.version,
                  date: new Intl.DateTimeFormat(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }).format(new Date(proposal.proposedAt)),
                })}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => void act(proposal.name, 'approve')}
                className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-500 hover:bg-emerald-500/20 transition-colors"
              >
                <Check className="w-3 h-3" />
                {t('skillDoctor.proposals.approve')}
              </button>
              <button
                onClick={() => void act(proposal.name, 'reject')}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-error hover:bg-surface-hover transition-colors"
                title={t('skillDoctor.proposals.rejectTitle')}
              >
                <Trash2 className="w-3 h-3" />
                {t('skillDoctor.proposals.reject')}
              </button>
            </div>
          </div>
          {renaming === proposal.name ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder={t('skillDoctor.proposals.renamePlaceholder')}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12px] text-text-primary focus:border-accent focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void act(proposal.name, 'approve', renameValue);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
                <button
                  onClick={() => void act(proposal.name, 'approve', renameValue)}
                  className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-500 hover:bg-emerald-500/20 transition-colors"
                >
                  {t('skillDoctor.proposals.approveAs')}
                </button>
                <button
                  onClick={() => setRenaming(null)}
                  className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-text-secondary hover:bg-surface-hover transition-colors"
                >
                  {t('common.cancel')}
                </button>
              </div>
          ) : proposal.rationale ? (
            <p className="mt-2 text-[11px] leading-5 text-text-muted">
              <span className="font-medium">{t('skillDoctor.proposals.rationale')}:</span>{' '}
              {proposal.rationale}
            </p>
          ) : null}
          <button
            onClick={() => setExpanded(expanded === proposal.name ? null : proposal.name)}
            className="mt-1.5 flex items-center gap-1 text-[11px] text-accent hover:underline"
          >
            {expanded === proposal.name ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            {t('skillDoctor.proposals.contentPreview')}
          </button>
          {expanded === proposal.name && (
            <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-border-subtle bg-surface-muted/40 p-2 text-[10px] leading-4 text-text-secondary whitespace-pre-wrap">
              {proposal.content}
            </pre>
          )}
        </div>
      ))}
    </SettingsContentSection>
  );
}

/**
 * `/skill doctor` — local context-cost analyzer for loaded skills. All data is
 * computed in the main process from local files; nothing leaves the machine.
 */
export function SettingsSkillDoctor() {
  const { t } = useTranslation();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const run = useCallback(async () => {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.skillsDoctor();
      if (id !== requestId.current) return;
      if (!result.success || !result.report) {
        setError('failed');
        return;
      }
      setReport(result.report);
    } catch {
      if (id === requestId.current) setError('failed');
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void run();
    return () => {
      requestId.current += 1;
    };
  }, [run]);

  const percent =
    report && report.contextWindow
      ? Math.min(100, Math.round((report.totalSkillTokens / report.contextWindow) * 100))
      : null;

  return (
    <>
    {/* Pending proposals FIRST — the manual approval gate is the entry point. */}
    <ProposedSkillsSection onChanged={() => void run()} />
    <SettingsContentSection title={t('skillDoctor.title')} description={t('skillDoctor.description')}>
      <div className="space-y-3 settings-card p-4" aria-busy={busy}>
        <div className="flex items-center justify-between gap-3">
          {report && (
            <p className="text-xs text-text-muted">
              {t('skillDoctor.total', {
                tokens: report.totalSkillTokens.toLocaleString(),
                percent: percent !== null ? `(${percent}%)` : '',
              })}
            </p>
          )}
          <button
            className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-text-primary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy}
            onClick={() => {
              void run();
            }}
          >
            {t('skillDoctor.refresh')}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-rose-500">{t(`skillDoctor.${error}`)}</p>
        )}
        {!error && report && report.entries.length === 0 && (
          <p className="text-sm text-text-muted">{t('skillDoctor.empty')}</p>
        )}
        {report && report.entries.length > 0 && (
          <div role="table" aria-label={t('skillDoctor.table')} className="overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-text-muted">
                  <th className="py-1 pr-2 font-medium">{t('skillDoctor.skill')}</th>
                  <th className="py-1 pr-2 font-medium">{t('skillDoctor.tokens')}</th>
                  <th className="py-1 pr-2 font-medium">{t('skillDoctor.uses')}</th>
                  <th className="py-1 font-medium">{t('skillDoctor.recommendation')}</th>
                </tr>
              </thead>
              <tbody>
                {report.entries.map((entry) => (
                  <tr key={entry.path} className="border-t border-border-muted text-text-secondary">
                    <td className="break-all py-1.5 pr-2">{entry.name}</td>
                    <td className="py-1.5 pr-2 font-mono">{entry.tokenEstimate.toLocaleString()}</td>
                    <td className="py-1.5 pr-2 font-mono">
                      {entry.useCount}
                      {entry.lastUsedAt
                        ? ` · ${new Date(entry.lastUsedAt).toLocaleDateString()}`
                        : ` · ${t('skillDoctor.never')}`}
                    </td>
                    <td className="py-1.5">
                      {entry.recommendation === 'disable'
                        ? t('skillDoctor.considerDisabling')
                        : t('skillDoctor.keep')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SettingsContentSection>
    </>
  );
}