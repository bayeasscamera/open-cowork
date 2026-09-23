import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const panel = read('src/renderer/components/ModelRoutingPanel.tsx');
const app = read('src/renderer/App.tsx');
const store = read('src/renderer/store/index.ts');
const preload = read('src/preload/index.ts');
const handlers = read('src/main/ipc/model-routing-handlers.ts');
const types = read('src/shared/model-routing-types.ts');

describe('model routing panel wiring', () => {
  it('renders the named profiles with capabilities and cost tier', () => {
    expect(panel).toContain('api.profiles()');
    expect(panel).toContain("t('modelRouting.profiles.cost', { tier: profile.costTier })");
    expect(panel).toContain("t('modelRouting.profiles.capability.' + key)");
    expect(types).toContain("export type ModelProfileId = 'fast' | 'balanced' | 'strong' | 'local';");
  });

  it('routes a task and shows the justification', () => {
    expect(panel).toContain('api.route(request)');
    expect(panel).toContain("t('modelRouting.route.taskKind.' + kind)");
    expect(panel).toContain('decision.reason');
    expect(panel).toContain('decision.fallbacks');
    expect(panel).toContain("t('modelRouting.route.confidential')");
  });

  it('shows the local benchmark and local providers', () => {
    expect(panel).toContain('api.benchmarks()');
    expect(panel).toContain('api.clearBenchmarks()');
    expect(panel).toContain('api.probeLocal()');
    expect(panel).toContain("t('modelRouting.local.kind.' + probe.kind)");
  });

  it('validates registry entries before download', () => {
    expect(panel).toContain('api.validateRegistry({');
    expect(panel).toContain('validation.valid');
    expect(panel).toContain("t('modelRouting.registry.suggested'");
  });

  it('is mounted from the app shell behind a store flag', () => {
    expect(app).toContain("import('./components/ModelRoutingPanel')");
    expect(app).toContain('modelRoutingVisible');
    expect(store).toContain('modelRoutingVisible: boolean;');
    expect(store).toContain('setModelRoutingVisible: (visible: boolean) => void;');
  });

  it('declares every model routing channel in the preload bridge', () => {
    const channelPattern = /'modelRouting\.([a-zA-Z]+)'/g;
    const handlerChannels = new Set<string>();
    for (const match of handlers.matchAll(channelPattern)) {
      handlerChannels.add(match[1]);
    }
    expect(handlerChannels.size).toBe(7);

    for (const channel of handlerChannels) {
      expect(preload, 'preload is missing modelRouting.' + channel).toContain(
        'modelRouting.' + channel
      );
    }
  });

  it('keeps the routing types shared so preload never imports main', () => {
    expect(preload).toContain("from '../shared/model-routing-types'");
    expect(preload).not.toContain("from '../main/");
    expect(types).toContain('export interface RoutingDecision');
    expect(types).toContain('export interface RegistryValidation');
  });
});
