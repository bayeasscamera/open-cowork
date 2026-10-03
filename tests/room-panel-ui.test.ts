import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const panel = read('src/renderer/components/RoomPanel.tsx');
const contextPanel = read('src/renderer/components/ContextPanel.tsx');
const preload = read('src/preload/index.ts');

const locales = {
  en: JSON.parse(read('src/renderer/i18n/locales/en.json')),
  fr: JSON.parse(read('src/renderer/i18n/locales/fr.json')),
  zh: JSON.parse(read('src/renderer/i18n/locales/zh.json')),
} as Record<string, { rooms: Record<string, string> }>;

describe('room panel', () => {
  it('is mounted in the context panel with the active session', () => {
    expect(contextPanel).toContain('<RoomPanel');
    expect(contextPanel).toContain('sessionId={activeSessionId}');
  });

  it('reads through the declared preload surface', () => {
    for (const channel of ['rooms.list', 'rooms.detail', 'rooms.postMessage', 'rooms.delete']) {
      expect(preload).toContain(`ipcRenderer.invoke('${channel}'`);
    }
  });

  it('loads a transcript on demand rather than with the list', () => {
    // The list is metadata; pulling every transcript would make opening the
    // panel scale with the number of runs rather than the number of rooms.
    expect(panel).toContain('await api.list(sessionId, scope)');
    expect(panel).toContain('const detail = await api.detail(sessionId, roomId)');
  });

  it('surfaces a refused deletion instead of assuming it worked', () => {
    expect(panel).toContain("result.error === 'confirmation_denied'");
    expect(panel).toContain('rooms.deleteFailed');
  });

  it('shows the cost of an exchange, so a room reads as a record too', () => {
    expect(panel).toContain('m.modelCalls > 0');
    expect(panel).toContain('rooms.modelCalls');
  });

  it('marks an unanswered question rather than presenting it as answered', () => {
    expect(panel).toContain("m.status !== 'answered'");
  });
});

describe('room UI translations', () => {
  const used = [...new Set([...panel.matchAll(/t\(\s*'rooms\.([A-Za-z_]+)'/g)].map((m) => m[1]))];

  it('uses a meaningful number of strings', () => {
    expect(used.length).toBeGreaterThanOrEqual(12);
  });

  it('defines every key it uses, in all three locales', () => {
    for (const [name, bundle] of Object.entries(locales)) {
      for (const key of used) {
        expect(bundle.rooms[key], `${name} is missing rooms.${key}`).toBeTruthy();
      }
    }
  });

  /**
   * Identical by design: the product uses these words verbatim in French and
   * Chinese UI copy, and translating a label the rest of the codebase does not
   * translate would name something it never calls it.
   */
  const VERBATIM_KEYS = new Set(['title', 'scopeProject', 'kind_note']);

  it('leaves no French or Chinese string identical to English', () => {
    for (const key of used) {
      if (VERBATIM_KEYS.has(key)) continue;
      expect(locales.fr.rooms[key], `fr.rooms.${key} untranslated`).not.toBe(locales.en.rooms[key]);
      expect(locales.zh.rooms[key], `zh.rooms.${key} untranslated`).not.toBe(locales.en.rooms[key]);
    }
  });

  it('defines a label for every message kind and status it renders', () => {
    // The panel builds these keys dynamically from the stored value, so a
    // missing one would render as raw text rather than a word.
    for (const kind of ['question', 'answer', 'note']) {
      for (const [name, bundle] of Object.entries(locales)) {
        expect(bundle.rooms[`kind_${kind}`], `${name}.kind_${kind}`).toBeTruthy();
      }
    }
    for (const status of ['answered', 'timeout', 'unavailable', 'limit']) {
      for (const [name, bundle] of Object.entries(locales)) {
        expect(bundle.rooms[`status_${status}`], `${name}.status_${status}`).toBeTruthy();
      }
    }
  });
});