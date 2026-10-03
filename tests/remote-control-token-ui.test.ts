import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const panel = read('src/renderer/components/RemoteControlPanel.tsx');
const section = read('src/renderer/components/remote/RemoteControlTokenSection.tsx');

const locales = {
  en: read('src/renderer/i18n/locales/en.json'),
  fr: read('src/renderer/i18n/locales/fr.json'),
  zh: read('src/renderer/i18n/locales/zh.json'),
};

const translationKeyUsages = (source: string): string[] =>
  [...source.matchAll(/t\('(remote\.controlToken[A-Za-z]*)'\)/g)].map((m) => m[1]);

/**
 * Every literal `remote.*` key the panel can end up resolving, in both forms it
 * uses: a direct `t('remote.x')` call, and a `setError`/`setSuccess` banner key
 * that is only resolved later through `t(banner.key)`. Missing the second form
 * is what let a nonexistent key reach the UI as raw text.
 */
const allRemoteKeyUsages = (source: string): string[] => [
  ...[...source.matchAll(/t\('(remote\.[A-Za-z0-9_.]+)'\)/g)].map((m) => m[1]),
  ...[...source.matchAll(/set(?:Error|Success)\(\{\s*key:\s*'(remote\.[A-Za-z0-9_.]+)'/g)].map(
    (m) => m[1]
  ),
];

describe('remote control token UI', () => {
  it('is wired into the panel with presence-only state', () => {
    expect(panel).toContain('<RemoteControlTokenSection');
    expect(panel).toContain('hasToken={hasControlToken}');
    expect(panel).toContain('tunnelEnabled={tunnelEnabled}');
    expect(panel).toContain('onRotate={rotateControlToken}');
  });

  it('never hands the stored secret to the view as a value', () => {
    // Every read of the token must be a boolean coercion: the panel may know
    // whether one exists, never what it is.
    const reads = panel.match(/[^\n]*remoteControlToken[^\n]*/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    for (const line of reads) {
      expect(line).toContain('!!');
    }
    // The panel must not forward a raw token into any rendered prop.
    expect(panel).not.toMatch(/=\{\s*configResult\.gateway\?\.auth\?\.remoteControlToken\s*\}/);
  });

  it('surfaces the issued token once, then lets it be dismissed', () => {
    expect(section).toContain('const token = await onRotate();');
    expect(section).toContain('setIssuedToken(token);');
    expect(section).toContain('onClick={() => setIssuedToken(null)}');
    // Rotation invalidates the previous token immediately, so it must confirm first.
    expect(section).toContain('isConfirming');
  });

  it('warns when a tunnel is enabled without a token, because start-up then fails', () => {
    expect(section).toContain('const needsToken = tunnelEnabled && !hasToken;');
    expect(section).toContain('remote.controlTokenRequiredWarning');
  });

  it('translates every control-token string in all three locales', () => {
    const used = [...new Set(translationKeyUsages(section))];
    expect(used.length).toBeGreaterThanOrEqual(10);

    for (const [name, raw] of Object.entries(locales)) {
      const bundle = JSON.parse(raw) as { remote: Record<string, string> };
      for (const key of used) {
        const leaf = key.replace('remote.', '');
        expect(bundle.remote[leaf], `${name} is missing ${key}`).toBeTruthy();
      }
    }
  });

  it('does not leave French copy identical to English for the new keys', () => {
    const en = (JSON.parse(locales.en) as { remote: Record<string, string> }).remote;
    const fr = (JSON.parse(locales.fr) as { remote: Record<string, string> }).remote;
    const zh = (JSON.parse(locales.zh) as { remote: Record<string, string> }).remote;
    for (const key of Object.keys(en).filter((k) => k.startsWith('controlToken'))) {
      expect(fr[key], `fr.controlToken${key} untranslated`).not.toBe(en[key]);
      expect(zh[key], `zh.controlToken${key} untranslated`).not.toBe(en[key]);
    }
  });

  it('resolves every literal remote key the panel and section render', () => {
    // Guards against shipping a raw key to the user. Dynamic lookups such as
    // t(error.key) are not literal and are deliberately out of scope.
    const used = new Set([...allRemoteKeyUsages(section), ...allRemoteKeyUsages(panel)]);
    expect(used.size).toBeGreaterThanOrEqual(15);

    for (const [name, raw] of Object.entries(locales)) {
      const bundle = JSON.parse(raw) as { remote: Record<string, string> };
      for (const key of used) {
        expect(bundle.remote[key.replace('remote.', '')], `${name} is missing ${key}`).toBeTruthy();
      }
    }
  });

  it('classifies the transport with the same shared rule the main process enforces', () => {
    // The label must not be computed independently of the policy, or the UI can
    // claim a transport is safe while main refuses (or the reverse).
    expect(section).toContain("from '../../../shared/remote-transport'");
    expect(section).toContain('classifyRemoteTransport({ bind, tunnelEnabled })');
    expect(section).toContain('requiresInsecureBindingAcknowledgement(transport)');
  });
});