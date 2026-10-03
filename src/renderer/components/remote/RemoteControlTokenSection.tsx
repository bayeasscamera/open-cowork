/**
 * RemoteControlTokenSection — the credential guarding the generic remote control
 * plane (`/status` and `/ws`), independent of channel pairing.
 *
 * The stored secret is never rendered here: this component only reports whether
 * one is provisioned. Rotation returns the new value exactly once, so it is
 * shown in a copy-once panel and then dropped from component state. Re-rotating
 * invalidates the previous token immediately on the running listener, so it asks
 * for confirmation first.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, RefreshCw, Copy, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface Props {
  /** Whether a control token is currently provisioned (never the value). */
  hasToken: boolean;
  /** A tunnel puts the gateway on the public internet, so the token is mandatory. */
  tunnelEnabled: boolean;
  /** Provision a new token; resolves to the plaintext value, or null on failure. */
  onRotate: () => Promise<string | null>;
  onCopy: (text: string) => void;
}

export function RemoteControlTokenSection({ hasToken, tunnelEnabled, onRotate, onCopy }: Props) {
  const { t } = useTranslation();
  const [isRotating, setIsRotating] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  async function handleRotate() {
    if (isRotating) return;
    setIsRotating(true);
    try {
      const token = await onRotate();
      setIssuedToken(token);
    } finally {
      setIsRotating(false);
      setIsConfirming(false);
    }
  }

  const needsToken = tunnelEnabled && !hasToken;

  return (
    <div className="p-6 rounded-[2rem] border border-border-subtle bg-background/60 space-y-4">
      <div className="flex items-start gap-3">
        <KeyRound className="w-5 h-5 text-text-secondary flex-shrink-0 mt-0.5" />
        <div>
          <h3 className="text-lg font-medium text-text-primary">{t('remote.controlTokenTitle')}</h3>
          <p className="text-sm text-text-secondary mt-1">{t('remote.controlTokenDesc')}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm">
        {hasToken ? (
          <>
            <CheckCircle2 className="w-4 h-4 text-success flex-shrink-0" />
            <span className="text-success">{t('remote.controlTokenConfigured')}</span>
          </>
        ) : (
          <>
            <AlertTriangle className="w-4 h-4 text-text-muted flex-shrink-0" />
            <span className="text-text-muted">{t('remote.controlTokenMissing')}</span>
          </>
        )}
      </div>

      {needsToken && (
        <div className="p-3 rounded-xl bg-warning/10 border border-warning/30 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
          <span className="text-sm text-warning">{t('remote.controlTokenRequiredWarning')}</span>
        </div>
      )}

      {issuedToken && (
        <div className="p-4 rounded-xl bg-surface-hover border border-accent/40 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-accent flex-shrink-0" />
            <span className="text-sm text-text-primary">{t('remote.controlTokenIssuedTitle')}</span>
          </div>
          <code className="block w-full px-3 py-2 bg-background rounded-lg text-xs font-mono text-text-primary break-all select-all">
            {issuedToken}
          </code>
          <p className="text-xs text-warning">{t('remote.controlTokenIssuedWarning')}</p>
          <div className="flex gap-2">
            <button
              onClick={() => onCopy(issuedToken)}
              className="flex items-center gap-2 px-3 py-1.5 bg-accent hover:bg-accent/90 text-white rounded-lg text-xs font-medium transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
              {t('remote.controlTokenCopy')}
            </button>
            <button
              onClick={() => setIssuedToken(null)}
              className="px-3 py-1.5 text-text-secondary hover:text-text-primary rounded-lg text-xs font-medium transition-colors"
            >
              {t('remote.controlTokenDismiss')}
            </button>
          </div>
        </div>
      )}

      {isConfirming ? (
        <div className="flex items-center gap-2">
          <button
            onClick={handleRotate}
            disabled={isRotating}
            className="flex items-center gap-2 px-4 py-2 bg-error hover:bg-error/90 text-white rounded-xl text-sm font-medium transition-colors disabled:opacity-50"
          >
            {isRotating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {t('remote.controlTokenConfirmRotate')}
          </button>
          <button
            onClick={() => setIsConfirming(false)}
            className="px-4 py-2 text-text-secondary hover:text-text-primary rounded-xl text-sm font-medium transition-colors"
          >
            {t('remote.controlTokenCancel')}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setIsConfirming(true)}
          className="flex items-center gap-2 px-4 py-2 bg-surface-hover hover:bg-surface-active border border-border text-text-primary rounded-xl text-sm font-medium transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          {hasToken ? t('remote.controlTokenRotate') : t('remote.controlTokenGenerate')}
        </button>
      )}
    </div>
  );
}