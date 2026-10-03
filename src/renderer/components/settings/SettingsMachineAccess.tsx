import { useCallback, useState } from 'react';
import { FolderPlus, Trash2, ShieldAlert, OctagonX, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FolderGrant, AutonomyLevel } from '@main/machine-access/types';
import type { MachineAccessHistoryEntry, MachineAccessPermissionState } from '@renderer/types';

export interface SettingsMachineAccessProps {
  grants: FolderGrant[];
  autonomy: AutonomyLevel;
  /** Default autonomy for projects without an explicit pin. */
  allowedApps: string[];
  permissions: MachineAccessPermissionState[];
  /**
   * Journal rows. Typed by the contract rather than the journal class so the
   * renderer depends on the wire shape, not on the main-process module.
   */
  history: MachineAccessHistoryEntry[];
  /** UI-only wiring: the main process owns the real behaviour. */
  onAddGrant: () => void;
  onRevokeGrant: (id: string) => void;
  onChangeAutonomy: (level: AutonomyLevel) => void;
  onAddApp: () => void;
  onRemoveApp: (name: string) => void;
  onUndoBatch: (batchId: string) => void;
  onEmergencyStop: () => void;
  /** Null when another application already owns the accelerator. */
  emergencyShortcut: string | null;
}

const AUTONOMY_LEVELS: AutonomyLevel[] = [
  'ask-always',
  'read-free',
  'extended-trust',
  'allow-all',
];

const RISK_STYLES: Record<string, string> = {
  ordinaire: 'text-text-muted',
  dangerous: 'text-amber-500',
  suspect: 'text-orange-500',
};

function riskClass(level: string): string {
  return RISK_STYLES[level] ?? 'text-text-muted';
}

/**
 * Settings → Machine access. Single surface for the view (no duplicated
 * panel elsewhere), built on the app design system.
 */
export function SettingsMachineAccess(props: SettingsMachineAccessProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const run = useCallback((fn: () => void) => {
    setBusy(true);
    try {
      fn();
    } finally {
      setBusy(false);
    }
  }, []);

  const batches = Array.from(new Set(props.history.map((op) => op.batchId)));

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-border-muted bg-surface/60 p-5">
        <div className="mb-1 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-text-muted" />
          <h3 className="text-sm font-semibold text-text">{t('machineAccess.autonomyTitle')}</h3>
        </div>
        <p className="mb-3 text-xs text-text-muted">{t('machineAccess.autonomyHint')}</p>
        <div className="flex flex-col gap-2">
          {AUTONOMY_LEVELS.map((level) => (
            <label key={level} className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="machine-autonomy"
                checked={props.autonomy === level}
                onChange={() => run(() => props.onChangeAutonomy(level))}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium text-text">{t(`machineAccess.autonomy.${level}`)}</span>
                {(level === 'extended-trust' || level === 'allow-all') && (
                  <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-500">
                    {t('machineAccess.autonomyWarning')}
                  </span>
                )}
                <span className="block text-xs text-text-muted">
                  {t(`machineAccess.autonomyHint.${level}`)}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-3 text-xs text-text-muted">{t('machineAccess.alwaysApprovalReminder')}</p>
      </section>

      <section className="rounded-2xl border border-border-muted bg-surface/60 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">{t('machineAccess.grantsTitle')}</h3>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(props.onAddGrant)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            <FolderPlus className="h-4 w-4" />
            {t('machineAccess.addFolder')}
          </button>
        </div>
        {props.grants.length === 0 ? (
          <p className="text-sm text-text-muted">{t('machineAccess.noGrants')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {props.grants.map((grant) => (
              <li
                key={grant.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border-muted px-3 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-text">{grant.path}</span>
                  <span className="block text-[11px] text-text-muted">
                    {t(`machineAccess.access.${grant.access}`)} · {t(`machineAccess.scope.${grant.scope}`)}
                    {grant.expiresAt ? ` · ${t('machineAccess.expires')}` : ''}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => run(() => props.onRevokeGrant(grant.id))}
                  title={t('machineAccess.revoke')}
                  className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-border-muted bg-surface/60 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text">{t('machineAccess.appsTitle')}</h3>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(props.onAddApp)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-muted px-3 py-1.5 text-xs font-medium text-text transition-colors hover:bg-surface disabled:opacity-50"
          >
            <FolderOpen className="h-4 w-4" />
            {t('machineAccess.addApp')}
          </button>
        </div>
        {props.allowedApps.length === 0 ? (
          <p className="text-sm text-text-muted">{t('machineAccess.noApps')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {props.allowedApps.map((app) => (
              <li
                key={app}
                className="inline-flex items-center gap-2 rounded-full border border-border-muted px-3 py-1 text-xs text-text"
              >
                {app}
                <button
                  type="button"
                  onClick={() => run(() => props.onRemoveApp(app))}
                  title={t('machineAccess.remove')}
                  className="text-text-muted hover:text-danger"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {props.permissions.length > 0 && (
        <section className="rounded-2xl border border-border-muted bg-surface/60 p-5">
          <h3 className="mb-3 text-sm font-semibold text-text">
            {t('machineAccess.permissionsTitle')}
          </h3>
          <ul className="flex flex-col gap-2">
            {props.permissions.map((permission) => (
              <li key={permission.permission} className="flex items-center justify-between gap-3">
                <span className="text-sm text-text">
                  {t(`machineAccess.permission.${permission.permission}`)}
                  <span className="block text-xs text-text-muted">{permission.explanation}</span>
                </span>
                <span
                  className={
                    permission.granted
                      ? 'text-xs font-medium text-accent'
                      : 'text-xs font-medium text-amber-500'
                  }
                >
                  {permission.granted
                    ? t('machineAccess.granted')
                    : permission.known
                      ? t('machineAccess.missing')
                      : t('machineAccess.unknown')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-border-muted bg-surface/60 p-5">
        <h3 className="mb-3 text-sm font-semibold text-text">{t('machineAccess.historyTitle')}</h3>
        {batches.length === 0 ? (
          <p className="text-sm text-text-muted">{t('machineAccess.noHistory')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {batches.slice(-20).reverse().map((batchId) => {
              const ops = props.history.filter((op) => op.batchId === batchId);
              return (
                <li
                  key={batchId}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border-muted px-3 py-2"
                >
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="block text-text">
                      {t('machineAccess.batchSummary', {
                        count: ops.length,
                        type: ops[0]?.type ?? '',
                      })}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-text-muted">
                      {ops[0]?.source}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => run(() => props.onUndoBatch(batchId))}
                    className="rounded-lg border border-border-muted px-3 py-1 text-xs text-text transition-colors hover:bg-surface"
                  >
                    {t('machineAccess.undo')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-danger/40 bg-danger/5 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-text">{t('machineAccess.stopTitle')}</h3>
            <p className="mt-1 text-xs text-text-muted">
              {t('machineAccess.stopHint')}
              {props.emergencyShortcut ? ` (${props.emergencyShortcut})` : ''}
            </p>
            {!props.emergencyShortcut && (
              <p className="mt-1 text-xs text-amber-500">{t('machineAccess.shortcutUnavailable')}</p>
            )}
          </div>
          <button
            type="button"
            onClick={props.onEmergencyStop}
            className={[
              'inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors',
              riskClass('dangerous'),
              'bg-danger hover:bg-danger/90',
            ].join(' ')}
          >
            <OctagonX className="h-4 w-4" />
            {t('machineAccess.emergencyStop')}
          </button>
        </div>
      </section>
    </div>
  );
}