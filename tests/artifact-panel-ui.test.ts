import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const panel = read('src/renderer/components/ArtifactPanel.tsx');
const contextPanel = read('src/renderer/components/ContextPanel.tsx');
const preload = read('src/preload/index.ts');
const contract = read('src/shared/artifact-contract.ts');

const locales = {
  en: JSON.parse(read('src/renderer/i18n/locales/en.json')),
  fr: JSON.parse(read('src/renderer/i18n/locales/fr.json')),
  zh: JSON.parse(read('src/renderer/i18n/locales/zh.json')),
} as Record<string, { artifacts: Record<string, string> }>;

describe('artifact panel', () => {
  it('is mounted in the context panel with the active session', () => {
    expect(contextPanel).toContain('<ArtifactPanel');
    expect(contextPanel).toContain('sessionId={activeSessionId}');
    expect(contextPanel).toContain('scope={artifactScope}');
  });

  it('reads through the declared preload surface', () => {
    expect(panel).toContain('window.electronAPI?.artifacts?.persistent');
    for (const channel of [
      'artifacts.persistent.list',
      'artifacts.persistent.get',
      'artifacts.persistent.versions',
      'artifacts.persistent.version',
      'artifacts.persistent.delete',
    ]) {
      expect(preload).toContain(`ipcRenderer.invoke('${channel}'`);
    }
  });

  it('keeps the listing free of content, since the panel loads it on demand', () => {
    // Content belongs in the explicit read; shipping it with the list would
    // pull every version's body into the renderer for no reason.
    expect(contract).toContain('Metadata only, as listed in the panel');
    expect(panel).toContain('await api.list(sessionId, scope)');
  });

  it('surfaces a refused deletion instead of assuming it worked', () => {
    expect(panel).toContain("result.error === 'confirmation_denied'");
    expect(panel).toContain('artifacts.deleteFailed');
  });

  it('shows when an earlier version is being viewed, not just the current one', () => {
    expect(panel).toContain('const isHistorical =');
    expect(panel).toContain('artifacts.viewingHistory');
  });
});

/**
 * Deliberately identical across locales: the product uses the English word in
 * French UI copy already ("workspace", "Modal", "Copié" alongside it), and
 * inventing a French rendering would name something the codebase never calls it.
 */
const VERBATIM_KEYS = new Set(['title', 'versionLabel', 'source']);

describe('artifact UI translations', () => {
  const used = [...new Set([...panel.matchAll(/t\('artifacts\.([A-Za-z]+)'/g)].map((m) => m[1]))];

  it('uses a meaningful number of strings', () => {
    expect(used.length).toBeGreaterThanOrEqual(10);
  });

  it('defines every key it uses, in all three locales', () => {
    for (const [name, bundle] of Object.entries(locales)) {
      for (const key of used) {
        expect(bundle.artifacts[key], `${name} is missing artifacts.${key}`).toBeTruthy();
      }
    }
  });

  it('leaves no French or Chinese string identical to English', () => {
    for (const key of used) {
      if (VERBATIM_KEYS.has(key)) continue;
      expect(locales.fr.artifacts[key], `fr.artifacts.${key} untranslated`).not.toBe(
        locales.en.artifacts[key]
      );
      expect(locales.zh.artifacts[key], `zh.artifacts.${key} untranslated`).not.toBe(
        locales.en.artifacts[key]
      );
    }
  });

  it('keeps the verbatim keys present rather than accidentally dropped', () => {
    for (const key of VERBATIM_KEYS) {
      expect(locales.en.artifacts[key]).toBeTruthy();
      expect(locales.fr.artifacts[key]).toBeTruthy();
      expect(locales.zh.artifacts[key]).toBeTruthy();
    }
  });

  it('interpolates the version number in every language', () => {
    for (const key of ['versionLabel', 'viewingHistory']) {
      for (const [name, bundle] of Object.entries(locales)) {
        expect(bundle.artifacts[key], `${name}.${key}`).toContain('{{version}}');
      }
    }
  });
});