import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Copy, Check, RefreshCw, Loader2 } from 'lucide-react';
import type { A2AStatus } from '../../../shared/types';
import { copyTextToClipboard } from '../../utils/clipboard';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

/**
 * Agent-to-Agent server section (opt-in).
 *
 * Exposes this app as an A2A agent over loopback HTTP behind a bearer token.
 * Tasks run non-interactively under a read-only tool lockdown, so enabling
 * this never grants write or shell access to the network — the card says so
 * and the server enforces it.
 */
export function A2ASection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<A2AStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isToggling, setIsToggling] = useState(false);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectron) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    window.electronAPI.a2a
      .getStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isElectron) return null;

  const toggle = async () => {
    if (!status || isToggling) return;
    setIsToggling(true);
    setError(null);
    try {
      const next = await window.electronAPI.a2a.setEnabled(!status.enabled);
      setStatus(next);
      if (!next.enabled) setFreshToken(null);
    } catch {
      setError(t('a2a.toggleFailed'));
    } finally {
      setIsToggling(false);
    }
  };

  const regenerate = async () => {
    setIsToggling(true);
    setError(null);
    try {
      const { token, status: next } = await window.electronAPI.a2a.regenerateToken();
      setStatus(next);
      setFreshToken(token);
      setCopied(false);
    } catch {
      setError(t('a2a.regenerateFailed'));
    } finally {
      setIsToggling(false);
    }
  };

  const copyToken = async () => {
    if (!freshToken) return;
    if (await copyTextToClipboard(freshToken)) {
      setCopied(true);
    } else {
      setError(t('a2a.copyFailed'));
    }
  };

  return (
    <div className="rounded-2xl border border-border-muted bg-surface/60 p-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-accent" />
          <h3 className="text-base font-semibold">{t('a2a.title')}</h3>
        </div>
        <button
          type="button"
          onClick={toggle}
          disabled={isLoading || isToggling || !status}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {isToggling ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : status?.enabled ? (
            t('a2a.disable')
          ) : (
            t('a2a.enable')
          )}
        </button>
      </div>
      <p className="mb-3 text-sm text-text-muted">{t('a2a.desc')}</p>
      {error && (
        <p className="mb-3 rounded-lg bg-error/10 px-3 py-2 text-sm text-error">{error}</p>
      )}

      {isLoading || !status ? (
        <p className="text-sm text-text-muted">{t('a2a.loading')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-1 text-sm">
            <span>
              <span className="text-text-muted">{t('a2a.endpoint')}: </span>
              <code className="rounded bg-surface px-1.5 py-0.5 font-mono">{status.url}</code>
            </span>
            <span>
              <span className="text-text-muted">{t('a2a.state')}: </span>
              {status.enabled
                ? status.running
                  ? t('a2a.running')
                  : t('a2a.enabledNotRunning')
                : t('a2a.disabled')}
            </span>
            {status.hasToken && (
              <span>
                <span className="text-text-muted">{t('a2a.token')}: </span>
                <code className="rounded bg-surface px-1.5 py-0.5 font-mono">
                  {status.tokenPreview}
                </code>
              </span>
            )}
          </div>

          {freshToken && (
            <div className="mt-3 rounded-lg border border-accent/40 bg-accent/10 p-3">
              <p className="mb-1 text-sm font-medium">{t('a2a.newTokenOnce')}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-surface px-2 py-1 font-mono text-xs">
                  {freshToken}
                </code>
                <button
                  type="button"
                  onClick={copyToken}
                  className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface hover:text-text"
                  title={t('a2a.copyToken')}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
          )}

          {status.enabled && (
            <button
              type="button"
              onClick={regenerate}
              disabled={isToggling}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border-muted px-3 py-1.5 text-sm text-text-muted transition-colors hover:text-text disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              {t('a2a.regenerate')}
            </button>
          )}
        </>
      )}
    </div>
  );
}
