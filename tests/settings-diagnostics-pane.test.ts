/**
 * Source assertions for the Diagnostics page. The renderer test environment is
 * Node (no DOM), so these pin the wiring that types cannot prove: the page is a
 * real tab, it asks the main process for the report, it reuses the shared
 * settings ladder, and every string it renders exists in all shipped locales.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const pane = read('src/renderer/components/settings/SettingsDiagnostics.tsx');
const panel = read('src/renderer/components/SettingsPanel.tsx');
const preload = read('src/preload/index.ts');
const handlers = read('src/main/ipc/config-handlers.ts');
const shared = read('src/shared/health-report.ts');
const collector = read('src/main/utils/health-report-collector.ts');
const en = read('src/renderer/i18n/locales/en.json');
const fr = read('src/renderer/i18n/locales/fr.json');
const zh = read('src/renderer/i18n/locales/zh.json');

describe('diagnostics page', () => {
  it('is a real settings tab, not a floating panel', () => {
    expect(panel).toContain("import { SettingsDiagnostics } from './settings/SettingsDiagnostics';");
    expect(panel).toContain("| 'diagnostics'");
    expect(panel).toContain("'diagnostics',");
    expect(panel).toContain("tabs: ['diagnostics', 'logs', 'permissions', 'general']");
    expect(panel).toContain('<SettingsDiagnostics isActive={activeTab ===');
    expect(panel).toContain("t('settings.diagnostics')");
  });

  it('asks the main process for the report instead of guessing in the renderer', () => {
    expect(pane).toContain('api.diagnostics.report(activeSessionId ?? null)');
    expect(preload).toContain("ipcRenderer.invoke('diagnostics.report'");
    expect(handlers).toContain("ipcMain.handle(");
    expect(handlers).toContain("'diagnostics.report'");
    expect(handlers).toContain('collectHealthReport({ session, project })');
  });

  it('reuses the settings ladder the agent runner resolves with', () => {
    expect(pane).toContain("from '../../../shared/settings-levels'");
    expect(pane).toContain('resolveSettingsLadder({');
    expect(pane).toContain("t('settingsLevels.level.' + ladder.configSetLevel)");
  });

  it('renders one row per check with a status-driven icon and a fix', () => {
    expect(pane).toContain('report.checks.map((check: HealthCheck)');
    expect(pane).toContain('data-check={check.id}');
    expect(pane).toContain("t('diagnostics.check.' + check.id)");
    expect(pane).toContain("t('diagnostics.checkDetail.' + check.id)");
    expect(pane).toContain("t('diagnostics.fix.' + check.id)");
    expect(pane).toContain("t('diagnostics.overall.' + overall)");
  });

  it('exposes the existing bundle export, log folder and connection probe', () => {
    expect(pane).toContain('await api.logs.export()');
    expect(pane).toContain('api?.logs?.open?.()');
    expect(pane).toContain('await api.config.diagnose({');
    expect(pane).toContain("t('diagnostics.probeFail'");
  });

  it('never throws while diagnosing', () => {
    expect(shared).toContain('export function overallHealthStatus(');
    expect(shared).toContain('export function buildHealthChecks(');
    expect(collector).toContain('} catch {');
    // The collector must not await network probes: the page stays instant.
    expect(collector).not.toContain('fetch(');
  });

  it('checks the same six facts the classifier knows about', () => {
    for (const id of [
      'credentials',
      'model',
      'workspace',
      'sandbox',
      'storage',
      'native-tools',
    ]) {
      expect(shared).toContain("'" + id + "'");
    }
  });

  it('translates every new string in all shipped locales', () => {
    for (const locale of [en, fr, zh]) {
      expect(locale).toContain('"diagnostics"');
      expect(locale).toContain('"diagnosticsDesc"');
      expect(locale).toContain('"checkDetail"');
      expect(locale).toContain('"native-tools"');
      expect(locale).toContain('"bundleExported"');
      expect(locale).toContain('"probeFail"');
    }
  });
});
