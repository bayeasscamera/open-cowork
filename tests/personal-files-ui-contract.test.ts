import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('personal memory settings UI and IPC contracts', () => {
  it('exposes exactly four static, guarded channels with a shared renderer API', () => {
    const main = source('src/main/index.ts');
    const preload = source('src/preload/index.ts');
    for (const operation of ['list', 'read', 'history', 'restore']) {
      expect(main).toMatch(
        new RegExp(
          `ipcMain.handle\\(\\s*'personalFiles\\.${operation}',\\s*personalFilesHandler\\(`
        )
      );
      expect(preload).toContain(`ipcRenderer.invoke('personalFiles.${operation}'`);
    }
    expect(preload).toContain('satisfies PersonalFilesAPI');
    expect(preload).toContain('personalFiles: PersonalFilesAPI;');
    expect(main).not.toMatch(/'personalFiles\.(delete|write|create)'/);
    expect(source('src/main/memory/memory-service.ts')).toContain('() => this.personalHost?.owner');
  });

  it('places the viewer by personalization controls with confirmation, CAS and stale response guards', () => {
    const parent = source('src/renderer/components/settings/SettingsPersonalization.tsx');
    expect(parent.indexOf('<SettingsPersonalFiles />')).toBeGreaterThan(
      parent.indexOf("t('personalization.memorySectionTitle')")
    );
    expect(parent.indexOf('<SettingsPersonalFiles />')).toBeLessThan(
      parent.indexOf("t('personalization.instructionsTitle')")
    );
    const ui = source('src/renderer/components/settings/SettingsPersonalFiles.tsx');
    expect(ui.indexOf('window.confirm(')).toBeLessThan(ui.indexOf('personalFiles.restore('));
    expect(ui).toContain('expectedVersion: file.version');
    expect(ui).toContain('generation: revision.generation');
    expect(ui).toContain('revision: revision.revision');
    expect(ui).toContain('id !== requestId.current');
    expect(ui).toContain('requestId.current += 1');
    expect(ui).toContain('setFile(null)');
    expect(ui).toContain('role="alert"');
    expect(ui).not.toMatch(/dangerouslySetInnerHTML|showItemInFolder|openExternal|\.readFile\(/);
    expect(ui).not.toMatch(/content: revision.content|owner:/);
  });

  it('provides complete matching en/fr/zh labels and safe errors', () => {
    const locales = ['en', 'fr', 'zh'].map(
      (locale) =>
        JSON.parse(source(`src/renderer/i18n/locales/${locale}.json`)).personalFiles as Record<
          string,
          unknown
        >
    );
    const keys = Object.keys(locales[0]).sort();
    for (const locale of locales) {
      expect(Object.keys(locale).sort()).toEqual(keys);
      expect(Object.keys(locale.errors as object).sort()).toEqual([
        'failed',
        'forbidden',
        'invalid_input',
        'not_found',
        'unavailable',
        'version_conflict',
      ]);
      expect(locale.confirm).toContain('{{path}}');
      expect(locale.confirm).toContain('{{revision}}');
    }
  });
});
