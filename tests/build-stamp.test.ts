import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf-8');

/**
 * Guard against shipping a feature that exists in git but never reached the
 * installed app: the running build must be able to report its own revision.
 */
describe('build staleness guard', () => {
  it('bakes the built revision into the bundle at build time', () => {
    const vite = read('vite.config.ts');
    expect(vite).toContain('__BUILD_SHA__');
    expect(vite).toContain('__BUILD_TIME__');
    expect(vite).toContain('git rev-parse --short HEAD');
    expect(vite).toContain('GITHUB_SHA');
  });

  it('declares the injected globals for TypeScript', () => {
    const env = read('src/renderer/vite-env.d.ts');
    expect(env).toContain('declare const __BUILD_SHA__: string;');
    expect(env).toContain('declare const __BUILD_TIME__: string;');
  });

  it('surfaces the build stamp in Settings > General', () => {
    const general = read('src/renderer/components/settings/SettingsGeneral.tsx');
    expect(general).toContain('__BUILD_SHA__');
    expect(general).toContain('__BUILD_TIME__');
    expect(general).toContain("t('general.systemBuild')");
  });

  it('all locales declare the build label', () => {
    for (const locale of ['en', 'fr', 'zh']) {
      const dict = JSON.parse(read(`src/renderer/i18n/locales/${locale}.json`)) as {
        general?: { systemBuild?: string };
      };
      expect(dict.general?.systemBuild, `missing general.systemBuild in ${locale}`).toBeTruthy();
    }
  });
});
