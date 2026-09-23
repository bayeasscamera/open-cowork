/**
 * The settings ladder pane is source-asserted (the renderer test environment is
 * Node, with no DOM). The point of these assertions is the wiring that a type
 * check cannot prove: that the panel and the agent runner resolve settings with
 * the SAME pure module, so what the user reads is what actually runs.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const pane = read('src/renderer/components/SettingsLevelsPane.tsx');
const panel = read('src/renderer/components/ControlCenterPanel.tsx');
const runner = read('src/main/agent/agent-runner.ts');
const preload = read('src/preload/index.ts');
const sessionManager = read('src/main/session/session-manager.ts');
const handler = read('src/main/ipc/client-event-handler.ts');
const en = read('src/renderer/i18n/locales/en.json');
const fr = read('src/renderer/i18n/locales/fr.json');
const zh = read('src/renderer/i18n/locales/zh.json');

describe('settings ladder pane', () => {
  it('resolves with the shared module the agent runner also uses', () => {
    expect(pane).toContain("from '../../shared/settings-levels'");
    expect(pane).toContain('resolveSettingsLadder({');
    expect(runner).toContain("from '../../shared/settings-levels'");
    expect(runner).toContain('resolveSettingsLadder({');
  });

  it('reads the session, its project and the global config from the store', () => {
    expect(pane).toContain('useAppStore((s) => s.appConfig)');
    expect(pane).toContain('useAppStore((s) => s.sessions)');
    expect(pane).toContain('useAppStore((s) => s.projects)');
    expect(pane).toContain('activeConfigSetId: appConfig?.activeConfigSetId ??');
    expect(pane).toContain('session?.configSetId ?? null');
    expect(pane).toContain('project.configSetId');
  });

  it('renders one row per level and flags the deciding level', () => {
    expect(pane).toContain('ladder.levels.map((state, index)');
    expect(pane).toContain('data-level={state.level}');
    expect(pane).toContain('state.decidesConfigSet');
    expect(pane).toContain('state.decidesModel');
    expect(pane).toContain("return 'settingsLevels.level.' + level;");
  });

  it('surfaces resolution warnings instead of hiding them', () => {
    expect(pane).toContain('ladder.warnings.length > 0');
    expect(pane).toContain("t('settingsLevels.warning.' + warning.code");
  });

  it('pins and clears the session override through the preload bridge', () => {
    expect(pane).toContain('api.setConfigOverride(sessionId, configSetId, modelId)');
    expect(pane).toContain('void apply(null, null)');
    expect(preload).toContain("type: 'session.setConfigOverride'");
    expect(preload).toContain("'session.setConfigOverride': true");
    expect(sessionManager).toContain('setConfigOverride(');
    expect(handler).toContain("case 'session.setConfigOverride'");
  });

  it('offers the else-inherit placeholder of the level below', () => {
    expect(pane).toContain('session: null');
    expect(pane).toContain('inherited.model');
    expect(pane).toContain("t('settingsLevels.inheritOption')");
  });

  it('is mounted from the control center as its own tab', () => {
    expect(panel).toContain("'settings'");
    expect(panel).toContain('<SettingsLevelsPane sessionId={sessionId} />');
    expect(panel).toContain('t(' + "'" + 'controlCenter.tab.' + "'" + ' + candidate)');
  });

  it('translates every new string in all shipped locales', () => {
    for (const locale of [en, fr, zh]) {
      expect(locale).toContain('"settingsLevels"');
      expect(locale).toContain('"overrideHint"');
      expect(locale).toContain('"unknown-config-set"');
      expect(locale).toContain('"no-config-set"');
      expect(locale).toContain('"settings":');
    }
  });
});
