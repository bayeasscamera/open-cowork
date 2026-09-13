import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const localesDir = path.resolve(process.cwd(), 'src/renderer/i18n/locales');

type Dict = Record<string, string | Dict>;

function loadLocale(name: string): Dict {
  return JSON.parse(fs.readFileSync(path.join(localesDir, `${name}.json`), 'utf8'));
}

function flatten(dict: Dict, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dict)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out[fullKey] = value;
    } else {
      Object.assign(out, flatten(value, fullKey));
    }
  }
  return out;
}

describe('i18n locale parity', () => {
  const locales = fs
    .readdirSync(localesDir)
    .filter(file => file.endsWith('.json'))
    .map(file => path.basename(file, '.json'));

  it('has at least en and fr locales', () => {
    expect(locales).toContain('en');
    expect(locales).toContain('fr');
  });

  it('all locales share the exact same key set', () => {
    const flatKeys = locales.map(locale => ({
      locale,
      keys: new Set(Object.keys(flatten(loadLocale(locale)))),
    }));
    const reference = flatKeys[0];
    for (const { locale, keys } of flatKeys.slice(1)) {
      const missingInLocale = [...reference.keys].filter(key => !keys.has(key));
      const extraInLocale = [...keys].filter(key => !reference.keys.has(key));
      expect(
        missingInLocale,
        `${locale} is missing keys present in ${reference.locale}`
      ).toEqual([]);
      expect(
        extraInLocale,
        `${locale} has keys absent from ${reference.locale}`
      ).toEqual([]);
    }
  });

  it('interpolation placeholders match across locales', () => {
    const placeholderPattern = /\{\{(\w+)\}\}/g;
    const flattenedLocales = locales.map(locale => ({
      locale,
      entries: flatten(loadLocale(locale)),
    }));
    const reference = flattenedLocales[0];
    for (const { locale, entries } of flattenedLocales.slice(1)) {
      for (const [key, value] of Object.entries(reference.entries)) {
        const expected = [...value.matchAll(placeholderPattern)]
          .map(match => match[1])
          .sort()
          .join(',');
        const actual = [...(entries[key] ?? '').matchAll(placeholderPattern)]
          .map(match => match[1])
          .sort()
          .join(',');
        expect(actual, `${locale} placeholder mismatch for key ${key}`).toEqual(expected);
      }
    }
  });
});
