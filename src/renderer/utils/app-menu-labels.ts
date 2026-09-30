import type { AppMenuLabels } from '../../shared/types';
import { WORKSPACE_PANELS } from '../../shared/workspace-panels';

/** Minimal translate signature — keeps this builder pure and unit-testable. */
export type TranslateFn = (key: string) => string;

/**
 * Builds the localized application-menu labels from the i18n catalogues.
 *
 * The main process has no i18n runtime, so the renderer resolves the strings
 * and pushes them over the `appMenu.sync` client event. Pure on purpose: the
 * i18n instance and the Electron bridge stay at the call site.
 */
export function buildAppMenuLabels(t: TranslateFn): AppMenuLabels {
  const panelNames: Record<string, string> = {};
  for (const panel of WORKSPACE_PANELS) {
    panelNames[panel.id] = t(panel.menuLabelKey);
  }
  return {
    preferences: t('appMenu.preferences'),
    edit: t('appMenu.edit'),
    view: t('appMenu.view'),
    panels: t('appMenu.panels'),
    window: t('appMenu.window'),
    newSession: t('appMenu.newSession'),
    settings: t('appMenu.settings'),
    panelNames,
  };
}
