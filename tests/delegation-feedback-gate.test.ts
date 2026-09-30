import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useAppStore } from '../src/renderer/store';
import { delegationToastEnabled } from '../src/renderer/utils/delegation-notices';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf-8');

/**
 * The completion feedback comes from three channels: the badge flash in the
 * dock, the in-app toast and the native notification. All three must honour
 * the single "Notify when a task finishes" delegation setting, otherwise a user
 * who switches notifications off still gets an animated badge.
 */
describe('delegation completion feedback gate', () => {
  const dock = read('src/renderer/components/PanelDock.tsx');
  const store = read('src/renderer/store/index.ts');
  const useIpc = read('src/renderer/hooks/useIPC.ts');
  const form = read('src/renderer/components/settings/DelegationSettingsForm.tsx');

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it('defaults to on, matching the main-process default', () => {
    expect(useAppStore.getState().notifyOnCompletion).toBe(true);
  });

  it('drives the toast gate from the store', () => {
    expect(delegationToastEnabled()).toBe(true);
    useAppStore.getState().setNotifyOnCompletion(false);
    expect(delegationToastEnabled()).toBe(false);
  });

  it('gates the badge flash on the same setting', () => {
    expect(dock).toContain('const notifyOnCompletion = useAppStore((s) => s.notifyOnCompletion)');
    expect(dock).toContain('if (!notifyOnCompletion) return;');
    // The flash effect re-evaluates when the setting changes.
    expect(dock).toContain('[taskKey, notifyOnCompletion]');
  });

  it('exposes the setting in the store with a single setter', () => {
    expect(store).toContain('notifyOnCompletion: boolean');
    expect(store).toContain('setNotifyOnCompletion: (enabled: boolean) => void');
    expect(store).toContain('setNotifyOnCompletion: (enabled) => set({ notifyOnCompletion: enabled })');
  });

  it('hydrates the setting at startup and refreshes it on save', () => {
    // Startup hydration, isolated so a failure cannot break config hydration.
    expect(useIpc).toContain('setNotifyOnCompletion(delegationSettings.settings.notifyOnCompletion)');
    expect(useIpc).toContain("console.warn('[useIPC] Failed to read delegation settings:'");
    // Saving in the settings form keeps the live gate in sync (no restart).
    expect(form).toContain('useAppStore.getState().setNotifyOnCompletion(result.settings.notifyOnCompletion)');
  });
});
