import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES = ['en', 'fr', 'zh'] as const;
const REQUIRED_KEYS = [
  'machineAccess.title',
  'machineAccess.approveOnce',
  'machineAccess.refuse',
  'machineAccess.emergencyStop',
  'machineAccess.autonomy.ask-always',
  'machineAccess.autonomy.read-free',
  'machineAccess.autonomy.extended-trust',
  'machineAccess.autonomy.allow-all',
  'machineAccess.autonomyWarning',
  'machineAccess.grantsTitle',
  'machineAccess.addFolder',
  'machineAccess.revoke',
  'machineAccess.appsTitle',
  'machineAccess.addApp',
  'machineAccess.permissionsTitle',
  'machineAccess.historyTitle',
  'machineAccess.undo',
  'machineAccess.stopTitle',
  'machineAccess.risk.ordinaire',
  'machineAccess.risk.dangereux',
  'machineAccess.risk.suspect',
  'machineAccess.card.what',
  'machineAccess.card.why',
  'machineAccess.card.worstCase',
  'machineAccess.card.undo',
  'machineAccess.card.origin',
  'machineAccess.card.reconfirmation',
  'settings.machineAccess',
  'settings.machineAccessDesc',
];

function readLocale(lang: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales', `${lang}.json`), 'utf-8')
  );
}

function lookup(obj: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

describe('machine access i18n', () => {
  for (const lang of LOCALES) {
    it(`${lang} has every machine-access key`, () => {
      const locale = readLocale(lang);
      const missing = REQUIRED_KEYS.filter((key) => {
        const value = lookup(locale, key);
        return value === undefined || value === null || String(value).length === 0;
      });
      expect(missing).toEqual([]);
    });
  }

  it('every locale exposes the same machineAccess key set', () => {
    const [en, fr, zh] = LOCALES.map(readLocale) as Array<Record<string, unknown>>;
    const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
          : [`${prefix}${k}`]
      );
    const enKeys = new Set(flatten(en['machineAccess'] as Record<string, unknown>));
    const frKeys = new Set(flatten(fr['machineAccess'] as Record<string, unknown>));
    const zhKeys = new Set(flatten(zh['machineAccess'] as Record<string, unknown>));
    expect([...frKeys].filter((k) => !enKeys.has(k))).toEqual([]);
    expect([...zhKeys].filter((k) => !enKeys.has(k))).toEqual([]);
    expect([...enKeys].filter((k) => !frKeys.has(k))).toEqual([]);
  });
});