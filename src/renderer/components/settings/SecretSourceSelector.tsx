/**
 * Settings -> Secret source: choose where a ConfigSet's API key comes from.
 *
 * The default, `local`, keeps the key in the encrypted config store. Bitwarden
 * and 1Password instead store only a REFERENCE here; the real secret is read
 * from the manager's CLI at call time and is never written to disk.
 *
 * The component owns the parts a settings page needs and the resolver does
 * not: choosing a source, typing the reference, probing the CLI for presence
 * and lock state, and explaining clearly when the CLI is missing.
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, RefreshCw, ShieldCheck, Vault } from 'lucide-react';
import {
  SECRET_SOURCE_PRECEDENCE,
  type SecretSourceConfig,
  type SecretSourceKind,
  type SecretSourceProbe,
} from '../../../shared/secret-source';
import { referenceHint } from '../../../shared/secret-source';
import { SettingsContentSection } from './shared';

interface SecretSourceSelectorProps {
  configSetId: string;
  configSetName: string;
  /** Current selection for this ConfigSet; undefined means `local`. */
  value: SecretSourceConfig | undefined;
  onChange: (next: SecretSourceConfig | undefined) => void;
}

const KIND_LABEL: Record<SecretSourceKind, string> = {
  local: 'secrets.sourceLocal',
  bitwarden: 'secrets.sourceBitwarden',
  '1password': 'secrets.sourceOnePassword',
};

/** Render a probe result as a tone + message, never leaking anything sensitive. */
function probeTone(
  probe: SecretSourceProbe | null
): { tone: 'ok' | 'warn' | 'fail' | 'idle'; messageKey?: string; message?: string } {
  if (!probe) return { tone: 'idle' };
  if (!probe.installed) return { tone: 'fail', messageKey: 'secrets.cliMissing' };
  if (!probe.unlocked) return { tone: 'warn', messageKey: 'secrets.vaultLocked' };
  return { tone: 'ok', messageKey: 'secrets.vaultReady' };
}

export function SecretSourceSelector({
  configSetId,
  configSetName,
  value,
  onChange,
}: SecretSourceSelectorProps) {
  const { t } = useTranslation();
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

  const selectedKind: SecretSourceKind = value?.kind ?? 'local';
  const [probe, setProbe] = useState<SecretSourceProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [testState, setTestState] = useState<{ ok: boolean; detail: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const runProbe = useCallback(async () => {
    if (selectedKind === 'local' || !api) {
      setProbe(null);
      return;
    }
    setProbing(true);
    try {
      const result = await api.secrets.probeSource(selectedKind);
      setProbe(result);
    } catch {
      setProbe({ installed: false, unlocked: false, detail: t('secrets.probeFailed') });
    } finally {
      setProbing(false);
    }
  }, [api, selectedKind, t]);

  // Re-probe whenever the selected source changes so the unlock hint is current.
  useEffect(() => {
    void runProbe();
  }, [runProbe]);

  const selectKind = (kind: SecretSourceKind) => {
    setTestState(null);
    if (kind === 'local') {
      onChange(undefined);
      return;
    }
    // Preserve the reference when switching between managers only if it is
    // still valid for the new source; otherwise start clean.
    const keepReference =
      value && value.kind !== 'local' && value.reference.trim() ? value.reference.trim() : '';
    onChange({ kind, driver: 'cli', reference: keepReference });
  };

  const updateReference = (reference: string) => {
    onChange({ kind: selectedKind, driver: 'cli', reference });
    setTestState(null);
  };

  const testConnection = async () => {
    if (!api) return;
    setTesting(true);
    try {
      setTestState(await api.secrets.testConfigSet(configSetId));
    } catch {
      setTestState({ ok: false, detail: t('secrets.testFailed') });
    } finally {
      setTesting(false);
    }
  };

  const tone = probeTone(probe);

  return (
    <SettingsContentSection
      title={t('secrets.title')}
      description={t('secrets.description')}
    >
      {/* Source picker */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {SECRET_SOURCE_PRECEDENCE.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => selectKind(kind)}
            aria-pressed={selectedKind === kind}
            className={`px-3 py-2 rounded-lg text-sm transition-colors border text-left ${
              selectedKind === kind
                ? 'border-accent bg-accent/10 text-accent font-medium'
                : 'border-border-muted text-text-secondary hover:border-border hover:text-text-primary'
            }`}
          >
            <span className="flex items-center gap-2">
              {kind === 'local' ? (
                <KeyRound className="w-3.5 h-3.5" />
              ) : (
                <Vault className="w-3.5 h-3.5" />
              )}
              {t(KIND_LABEL[kind])}
            </span>
          </button>
        ))}
      </div>

      {/* External source detail */}
      {selectedKind !== 'local' && (
        <div className="space-y-3 rounded-lg border border-border-muted p-3">
          <p className="text-xs leading-5 text-text-muted">
            {t('secrets.referenceFor', { set: configSetName })}
          </p>

          <input
            id={`secret-reference-${configSetId}`}
            type="text"
            value={value?.reference ?? ''}
            onChange={(e) => updateReference(e.target.value)}
            placeholder={t('secrets.referencePlaceholder', {
              hint: referenceHint(selectedKind),
            })}
            spellCheck={false}
            autoComplete="off"
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all font-mono text-sm"
          />

          {/* Probe status: presence and lock state of the manager CLI */}
          <div className="flex flex-wrap items-center gap-2">
            {probing ? (
              <span className="flex items-center gap-1.5 text-xs text-text-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('secrets.probing')}
              </span>
            ) : (
              <>
                {tone.tone === 'ok' && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {t('secrets.vaultReady')}
                  </span>
                )}
                {tone.tone === 'warn' && (
                  <span className="flex items-center gap-1.5 text-xs text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {t('secrets.vaultLocked')}
                  </span>
                )}
                {tone.tone === 'fail' && (
                  <span className="flex items-center gap-1.5 text-xs text-red-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {t('secrets.cliMissing')}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void runProbe()}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-surface-active text-text-secondary hover:text-text-primary transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  {t('secrets.retry')}
                </button>
              </>
            )}
          </div>

          {probe?.detail && tone.tone !== 'ok' && (
            <p className="text-xs leading-5 text-text-muted">{probe.detail}</p>
          )}

          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={testing || !value?.reference.trim()}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-40 hover:bg-accent/90 transition-colors"
          >
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            {t('secrets.test')}
          </button>

          {testState && (
            <p
              className={`text-xs leading-5 ${testState.ok ? 'text-emerald-400' : 'text-red-400'}`}
              role="status"
            >
              {testState.detail}
            </p>
          )}

          <p className="text-xs leading-5 text-text-muted">{t('secrets.neverStored')}</p>
        </div>
      )}
    </SettingsContentSection>
  );
}
