import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

describe('background quick-access setting (trayEnabled)', () => {
  it('defaults to enabled and is validated as boolean in the config store', () => {
    const store = read('src/main/config/config-store.ts');
    expect(store).toContain('trayEnabled: true');
    expect(store).toContain("trayEnabled: (v) => typeof v === 'boolean'");
    expect(store).toContain('toBoolean(raw.trayEnabled, defaultConfig.trayEnabled)');
    // importable via the plaintext config file, never secrets
    expect(store).toContain("'trayEnabled',");
  });

  it('declares the field on the shared AppConfig contract', () => {
    expect(read('src/shared/types.ts')).toContain('trayEnabled?: boolean;');
  });

  it('gates tray creation on the setting', () => {
    const index = read('src/main/index.ts');
    const start = index.indexOf('function setupTray() {');
    const end = index.indexOf('let windowToggleAccelerator', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const setup = index.slice(start, end);
    const gate = setup.indexOf("configStore.get('trayEnabled')");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(setup.indexOf('new Tray'));
  });

  it('startup and config.save both apply tray + shortcut through one helper', () => {
    const index = read('src/main/index.ts');
    expect(index).toContain('function applyBackgroundAccessSetting(enabled: boolean)');
    expect(index).toContain("applyBackgroundAccessSetting(configStore.get('trayEnabled'))");
    const save = index.match(/ipcMain\.handle\('config\.save'[\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(save).toContain("typeof newConfig.trayEnabled === 'boolean'");
    expect(save).toContain('applyBackgroundAccessSetting(newConfig.trayEnabled)');
    // the Alt+Space registration must no longer run unconditionally at startup
    expect(index).not.toMatch(/buildMacMenu\(\);\s*setupTray\(\);/);
  });

  it('exposes a toggle in general settings that persists via config.save', () => {
    const general = read('src/renderer/components/settings/SettingsGeneral.tsx');
    expect(general).toContain('handleToggleTray');
    expect(general).toContain('trayEnabled: next');
    expect(general).toContain("t('general.backgroundAccess')");
    expect(general).toContain('aria-pressed');
  });

  it('ships the i18n keys for every locale (parity test also enforces this)', () => {
    for (const locale of ['en', 'fr', 'zh']) {
      const dict = JSON.parse(read('src/renderer/i18n/locales/' + locale + '.json')) as {
        general?: Record<string, string>;
      };
      expect(dict.general?.backgroundAccess, locale + ' title').toBeTruthy();
      expect(dict.general?.backgroundAccessDesc, locale + ' description').toBeTruthy();
    }
  });
});
