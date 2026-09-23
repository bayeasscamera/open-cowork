import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const panel = read('src/renderer/components/ProjectMemoryPanel.tsx');
const app = read('src/renderer/App.tsx');
const store = read('src/renderer/store/index.ts');
const preload = read('src/preload/index.ts');
const handlers = read('src/main/ipc/project-memory-handlers.ts');
const types = read('src/shared/project-memory-types.ts');

describe('project memory panel wiring', () => {
  it('renders the four memory layers from the shared constant', () => {
    expect(panel).toContain('MEMORY_LAYERS.map');
    expect(panel).toContain("t('projectMemory.layer.' + candidate)");
    expect(types).toContain("'rules',");
    expect(types).toContain("'decisions',");
    expect(types).toContain("'task-state',");
    expect(types).toContain("'errors',");
  });

  it('lets the user add, delete, purge and preview entries', () => {
    expect(panel).toContain('api.upsert(sessionId');
    expect(panel).toContain('api.remove(sessionId, item.id)');
    expect(panel).toContain('purgeExpired(sessionId)');
    expect(panel).toContain('api.preview(sessionId');
  });

  it('shows provenance and expiry for every entry', () => {
    expect(panel).toContain('item.provenance.source');
    expect(panel).toContain('item.provenance.reference');
    expect(panel).toContain('item.provenance.locator');
    expect(panel).toContain("t('projectMemory.noExpiry')");
    expect(panel).toContain("t('projectMemory.expires'");
  });

  it('is mounted from the app shell behind a store flag', () => {
    expect(app).toContain("import('./components/ProjectMemoryPanel')");
    expect(app).toContain('memoryPanelVisible');
    expect(store).toContain('memoryPanelVisible: boolean;');
    expect(store).toContain('setMemoryPanelVisible: (visible: boolean) => void;');
  });

  it('declares every project memory channel in the preload bridge', () => {
    const channelPattern = /'projectMemory\.([a-zA-Z]+)'/g;
    const handlerChannels = new Set<string>();
    for (const match of handlers.matchAll(channelPattern)) {
      handlerChannels.add(match[1]);
    }
    expect(handlerChannels.size).toBe(8);

    for (const channel of handlerChannels) {
      expect(preload, 'preload is missing projectMemory.' + channel).toContain(
        'projectMemory.' + channel
      );
    }
  });

  it('keeps the memory types shared so preload never imports main', () => {
    expect(preload).toContain("from '../shared/project-memory-types'");
    expect(preload).not.toContain("from '../main/");
  });
});
