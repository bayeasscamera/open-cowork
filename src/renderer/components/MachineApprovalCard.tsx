import { AlertTriangle, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface ApprovalCardView {
  titleKey: string;
  /** Exactly what will happen: the command or the operation. */
  what: string;
  /** Why it is judged dangerous or suspicious. */
  why: string;
  /** What could go worst. */
  worstCase: string;
  /** How to cancel it afterwards. */
  undo: string;
  /** Where the request came from. */
  origin: string;
  risk: 'ordinaire' | 'dangereux' | 'suspect';
  /** Present for batch operations: before/after rows. */
  rows?: Array<{ before: string; after: string }>;
  /** Present when the action must be reconfirmed after untrusted content. */
  reconfirmationSource?: string;
}

export interface MachineApprovalCardProps {
  card: ApprovalCardView;
  onApproveOnce: () => void;
  onRefuse: () => void;
}

const RISK_TONE: Record<ApprovalCardView['risk'], string> = {
  ordinaire: 'border-border-muted text-text-muted',
  dangereux: 'border-danger/50 text-danger',
  suspect: 'border-orange-500/50 text-orange-500',
};

/**
 * Chat confirmation card. Never offers "always approve" for a dangerous or
 * suspicious action — only "approve once" and "refuse".
 */
export function MachineApprovalCard({ card, onApproveOnce, onRefuse }: MachineApprovalCardProps) {
  const { t } = useTranslation();
  const isElevated = card.risk !== 'ordinaire';

  return (
    <div className={`rounded-2xl border bg-surface p-4 ${RISK_TONE[card.risk]}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {isElevated && <AlertTriangle className="h-4 w-4" />}
          {t(card.titleKey)}
        </span>
        <span className="text-xs font-medium uppercase tracking-wide">
          {t(`machineAccess.risk.${card.risk}`)}
        </span>
      </div>

      <dl className="flex flex-col gap-2 text-sm">
        <div>
          <dt className="text-xs text-text-muted">{t('machineAccess.card.what')}</dt>
          <dd className="whitespace-pre-wrap break-words font-mono text-xs text-text">{card.what}</dd>
        </div>
        {isElevated && (
          <>
            <div>
              <dt className="text-xs text-text-muted">{t('machineAccess.card.why')}</dt>
              <dd className="text-xs text-text">{card.why}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">{t('machineAccess.card.worstCase')}</dt>
              <dd className="text-xs text-text">{card.worstCase}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">{t('machineAccess.card.undo')}</dt>
              <dd className="text-xs text-text">{card.undo}</dd>
            </div>
          </>
        )}
        <div>
          <dt className="text-xs text-text-muted">{t('machineAccess.card.origin')}</dt>
          <dd className="text-xs text-text">{card.origin}</dd>
        </div>
      </dl>

      {card.reconfirmationSource && (
        <p className="mt-2 rounded-lg bg-orange-500/10 px-2 py-1 text-xs text-orange-500">
          {t('machineAccess.card.reconfirmation', { source: card.reconfirmationSource })}
        </p>
      )}

      {card.rows && card.rows.length > 0 && (
        <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-border-muted">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th className="px-2 py-1 font-medium text-text-muted">{t('machineAccess.card.before')}</th>
                <th className="px-2 py-1 font-medium text-text-muted">{t('machineAccess.card.after')}</th>
              </tr>
            </thead>
            <tbody>
              {card.rows.map((row) => (
                <tr key={`${row.before}->${row.after}`} className="border-t border-border-muted">
                  <td className="px-2 py-1 font-mono text-[11px] text-text-muted">{row.before}</td>
                  <td className="px-2 py-1 font-mono text-[11px] text-text">{row.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onApproveOnce}
          className={[
            'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors',
            isElevated ? 'bg-danger hover:bg-danger/90' : 'bg-accent hover:bg-accent/90',
          ].join(' ')}
        >
          <Check className="h-4 w-4" />
          {t('machineAccess.approveOnce')}
        </button>
        <button
          type="button"
          onClick={onRefuse}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-muted px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-surface"
        >
          <X className="h-4 w-4" />
          {t('machineAccess.refuse')}
        </button>
      </div>
    </div>
  );
}