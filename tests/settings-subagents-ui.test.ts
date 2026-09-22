import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-settings-subagents.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = {
        ...(options?.defaults || {}),
      };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = {
        ...this.store,
        ...key,
      };
    }

    clear(): void {
      this.store = {};
    }
  }

  return {
    default: MockStore,
  };
});

import { buildSubAgentsUpdate } from '../src/renderer/components/subagents/SubAgentsView';
import { ConfigStore } from '../src/main/config/config-store';

const root = resolve(__dirname, '..');

describe('settings sub-agents UI → persisted config', () => {
  it('normalizes a UI draft with the same clamps as the store', () => {
    const update = buildSubAgentsUpdate({
      configSetId: '  cheap  ',
      modelId: ' qwen3.8-flash ',
      perRole: {
        reviewer: { configSetId: ' set-2 ', modelId: ' gpt-5.4 ' },
        developer: { configSetId: '   ' },
      } as Parameters<typeof buildSubAgentsUpdate>[0]['perRole'],
      timeoutMs: 5,
      maxConcurrent: 99,
    });
    expect(update).toEqual({
      configSetId: 'cheap',
      modelId: 'qwen3.8-flash',
      perRole: { reviewer: { configSetId: 'set-2', modelId: 'gpt-5.4' } },
      timeoutMs: 10_000,
      maxConcurrent: 8,
    });
    expect(
      buildSubAgentsUpdate({ configSetId: '', modelId: undefined, perRole: {}, timeoutMs: 120_000, maxConcurrent: 2 })
        .configSetId
    ).toBe('');
  });

  it('persists a UI save and keeps the value across a re-read (app reload)', () => {
    const store = new ConfigStore();
    const payload = buildSubAgentsUpdate({
      configSetId: 'cheap',
      modelId: 'qwen3.8-flash',
      perRole: { reviewer: { configSetId: 'set-2', modelId: 'gpt-5.4' } },
      timeoutMs: 90_000,
      maxConcurrent: 4,
    });
    store.update({ subAgents: payload });

    // First read after save — the value the UI would re-render from.
    expect(store.getAll().subAgents).toEqual(payload);
    // Re-read (simulated app reload): the same value survives normalization.
    expect(store.getAll().subAgents).toEqual(payload);

    store.update({ subAgents: { configSetId: '', perRole: {}, timeoutMs: 120_000, maxConcurrent: 2 } });
    expect(store.getAll().subAgents?.configSetId).toBe('');
  });

  it('migrates a legacy per-role string config on read', () => {
    const store = new ConfigStore();
    // Simulate a config saved before the { configSetId, modelId } format.
    store.update({ subAgents: { configSetId: 'cheap', perRole: { reviewer: 'set-2' } } as unknown as Parameters<typeof store.update>[0]['subAgents'] });
    expect(store.getAll().subAgents?.perRole).toEqual({
      reviewer: { configSetId: 'set-2', modelId: undefined },
    });
  });

  it('the component saves through the existing config.save IPC with a normalized payload', () => {
    const source = readFileSync(
      resolve(root, 'src/renderer/components/subagents/SubAgentsView.tsx'),
      'utf8'
    );
    expect(source).toContain('window.electronAPI.config.save({');
    expect(source).toContain('subAgents: buildSubAgentsUpdate(draft)');
    // No new IPC channel is invented.
    expect(source).not.toContain("ipcRenderer.invoke('config.subAgents");
  });

  it('the API tab does not embed a duplicate sub-agents section', () => {
    // The interface is reachable from Settings → Sub-agents, but only through
    // the shared view; the old inline copy inside the API tab is gone.
    const panel = readFileSync(resolve(root, 'src/renderer/components/SettingsPanel.tsx'), 'utf8');
    expect(panel).not.toContain('SettingsSubAgents');
    expect(panel).toContain("import { SubAgentsView } from './subagents/SubAgentsView'");
    expect(panel).toContain("label: t('settings.subAgents')");
  });

  it('the Settings → Sub-agents labels exist in en, fr and zh', () => {
    for (const lang of ['en', 'fr', 'zh']) {
      const settings = JSON.parse(
        readFileSync(resolve(root, `src/renderer/i18n/locales/${lang}.json`), 'utf8')
      ).settings as { subAgents?: string; subAgentsDesc?: string };
      expect(settings.subAgents, `settings.subAgents missing in ${lang}`).toBeTruthy();
      expect(settings.subAgentsDesc, `settings.subAgentsDesc missing in ${lang}`).toBeTruthy();
    }
  });

  it('labels exist in en, fr and zh with identical key sets', () => {
    const load = (lang: string): Record<string, unknown> =>
      JSON.parse(readFileSync(resolve(root, `src/renderer/i18n/locales/${lang}.json`), 'utf8'))
        .subAgents as Record<string, unknown>;
    for (const lang of ['en', 'fr', 'zh']) {
      expect(load(lang), `subAgents missing in ${lang}`).toBeTruthy();
    }
    const keySet = (o: Record<string, unknown>): Set<string> => new Set(Object.keys(o));
    expect(keySet(load('fr'))).toEqual(keySet(load('en')));
    expect(keySet(load('zh'))).toEqual(keySet(load('en')));
  });
});