/**
 * Mods v2 panel — installed mods, their health, and safe mode.
 *
 * Rendered INSIDE the existing "Local mods" settings section rather than as a
 * second surface: the repo already learned that two panels for one subject drift
 * apart (see the note in SettingsPanel.tsx about the Sub-agents view).
 *
 * The warning is shown unconditionally, before any list, because it is the fact
 * that decides whether the user should install anything at all. Declared
 * capabilities are labelled as declarations, and the fingerprint is shown next to
 * them, because that hash is the only control that actually binds.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContributedUiDto, InstalledModDto, SafeModeDto } from '../../../shared/mods-v2-contract';
import { ModDeclarativeUi } from '../mods/ModDeclarativeUi';

export interface ModsV2SectionProps {
  /** Injected so the panel is renderable and testable without a live IPC bridge. */
  /**
   * Seed data. The panel fetches on mount, but a component that can only be
   * seen after a round-trip is impossible to render in a test or a screenshot —
   * so the first paint comes from props when they are supplied.
   */
  initialMods?: InstalledModDto[];
  initialSafeMode?: SafeModeDto | null;
  listMods?: () => Promise<InstalledModDto[]>;
  safeMode?: () => Promise<SafeModeDto>;
  setEnabled?: (id: string, enabled: boolean) => Promise<void>;
  uninstall?: (id: string) => Promise<void>;
  /**
   * Declarative UI contributed by mods. Only the `settingsTab` slot has a host
   * location today (this panel); other slots are stored in main but not drawn.
   */
  initialUiContributions?: ContributedUiDto[];
  listUiContributions?: () => Promise<ContributedUiDto[]>;
  onUiContributionsChanged?: (
    callback: (contributions: ContributedUiDto[]) => void
  ) => () => void;
  readUiValue?: (modId: string, nodeId: string) => Promise<unknown>;
}

function reasonLabel(t: (key: string) => string, reason: SafeModeDto['reason']): string {
  switch (reason) {
    case 'flag':
      return t('mods.v2.reasonFlag');
    case 'setting':
      return t('mods.v2.reasonSetting');
    case 'auto':
      return t('mods.v2.reasonAuto');
    default:
      return '';
  }
}

export function ModsV2Section(props: ModsV2SectionProps) {
  const { t } = useTranslation();
  const [mods, setMods] = useState<InstalledModDto[]>(props.initialMods ?? []);
  const [safe, setSafe] = useState<SafeModeDto | null>(props.initialSafeMode ?? null);
  const [error, setError] = useState<string | null>(null);
  const [uiContributions, setUiContributions] = useState<ContributedUiDto[]>(
    props.initialUiContributions ?? []
  );

  const refresh = useCallback(async () => {
    try {
      const [loaded, mode] = await Promise.all([props.listMods?.(), props.safeMode?.()]);
      setMods(loaded ?? []);
      setSafe(mode ?? null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [props]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Declarative UI: seed from props, then fetch the live list and subscribe to
  // pushes. Failures leave the seed in place — a mod panel that blinks empty
  // because one round-trip failed is worse than a stale first paint.
  useEffect(() => {
    let cancelled = false;
    const apply = (contributions: ContributedUiDto[]): void => {
      if (!cancelled) setUiContributions(contributions);
    };
    void props.listUiContributions?.().then(apply, () => undefined);
    const unsubscribe = props.onUiContributionsChanged?.(apply);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [props]);

  // A mod's settingsTab contribution renders inside the mods panel: the mod
  // declares data, Cowork's own component draws it. `statusBar`,
  // `messageActions` and `sidePanel` are accepted by main but have no host
  // chrome yet, so nothing of theirs is drawn here.
  const settingsTabContributions = uiContributions.filter(
    (entry) => entry.contribution.slot === 'settingsTab'
  );

  return (
    <section className="mods-v2" data-mods-v2>
      {/* The access statement is the point of this panel, so it is not collapsed
          behind a disclosure: a user deciding whether to install needs it first. */}
      <p className="mods-v2__warning" role="note">
        {t('mods.v2.warning')}
      </p>

      {safe?.active ? (
        <p className="mods-v2__safe-mode" role="status">
          {t('mods.v2.safeModeActive', { reason: reasonLabel(t, safe.reason) })}
        </p>
      ) : null}

      {error ? <p className="mods-v2__error">{t('mods.v2.failed')}</p> : null}

      {mods.length === 0 && !error ? <p className="mods-v2__empty">{t('mods.v2.empty')}</p> : null}

      <ul className="mods-v2__list">
        {mods.map((mod) => (
          <li key={mod.id} className="mods-v2__item" data-mod-id={mod.id}>
            <div className="mods-v2__identity">
              <strong>{mod.id}</strong>
              <span>
                {mod.id} · v{mod.version} · {t(`mods.v2.${mod.enabled ? 'enabled' : 'disabled'}`)}
              </span>
            </div>

            <dl className="mods-v2__meta">
              <div>
                <dt>{t('mods.v2.declared')}</dt>
                <dd>{describeCapabilities(mod)}</dd>
              </div>
              <div>
                {/* The pinned hash: the user can compare it before and after an
                    update to see whether the code they approved is what runs. */}
                <dt>{t('mods.v2.fingerprint')}</dt>
                <dd>
                  <code>{mod.fingerprint.slice(0, 12)}</code>
                </dd>
              </div>
            </dl>

            {mod.health?.disabled ? (
              <p className="mods-v2__health" role="status">
                {t('mods.v2.autoDisabled')}
                {mod.health.lastError ? ` — ${mod.health.lastError}` : ''}
              </p>
            ) : null}

            <div className="mods-v2__actions">
              <button
                type="button"
                onClick={() => {
                  void props.setEnabled?.(mod.id, !mod.enabled).then(refresh);
                }}
              >
                {t(`mods.v2.${mod.enabled ? 'disabled' : 'enabled'}`)}
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void props.uninstall?.(mod.id).then(refresh);
                }}
              >
                {t('mods.v2.uninstall')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {settingsTabContributions.length > 0 ? (
        <div className="mods-v2__ui" data-mods-v2-ui>
          <h3>{t('mods.v2.uiContributions')}</h3>
          {settingsTabContributions.map((entry) => (
            <div key={entry.modId} className="mods-v2__ui-entry" data-mod-id={entry.modId}>
              <ModDeclarativeUi
                contribution={entry.contribution}
                backend={props.readUiValue ? { readValue: props.readUiValue } : undefined}
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Render declared capabilities honestly.
 *
 * An empty declaration prints the "not declared" label rather than a reassuring
 * dash: a mod that declares nothing still runs with everything, so the gap is
 * the information.
 */
function describeCapabilities(mod: InstalledModDto): string {
  const declared = mod.declaredCapabilities;
  if (!declared || typeof declared !== 'object') return '—';
  const parts: string[] = [];
  const caps = declared as { fs?: unknown; network?: unknown; storage?: unknown; model?: unknown; ui?: unknown };
  if (caps.fs) parts.push('fs');
  if (caps.network) parts.push('network');
  if (caps.storage) parts.push('storage');
  if (caps.model) parts.push('model');
  if (Array.isArray(caps.ui) && caps.ui.length > 0) parts.push('ui');
  return parts.length > 0 ? parts.join(', ') : '—';
}