import i18n from '../i18n/config';
import { useAppStore } from '../store';
import type { AppMenuState } from '../../shared/types';
import { buildAppMenuLabels } from './app-menu-labels';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export function buildAppMenuState(): AppMenuState {
  return {
    labels: buildAppMenuLabels((key) => i18n.t(key)),
    hasActiveSession: Boolean(useAppStore.getState().activeSessionId),
  };
}

/** Push the current menu labels + session state to the main process. */
export function syncAppMenu(): void {
  if (!isElectron) return;
  try {
    window.electronAPI.send({ type: 'appMenu.sync', payload: buildAppMenuState() });
  } catch {
    // Menu sync is best-effort: the bridge must never break the UI.
  }
}

/**
 * Keep the macOS application menu in step with the UI language and with the
 * active session (session-scoped entries are disabled without one). Returns
 * an unsubscribe function.
 */
export function startAppMenuSync(): () => void {
  syncAppMenu();
  const onLanguageChanged = (): void => syncAppMenu();
  i18n.on('languageChanged', onLanguageChanged);
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (state.activeSessionId !== previous.activeSessionId) syncAppMenu();
  });
  return () => {
    i18n.off('languageChanged', onLanguageChanged);
    unsubscribe();
  };
}
