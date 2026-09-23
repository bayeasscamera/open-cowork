import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const panel = read('src/renderer/components/EvalPanel.tsx');
const en = JSON.parse(read('src/renderer/i18n/locales/en.json'));
const fr = JSON.parse(read('src/renderer/i18n/locales/fr.json'));
const zh = JSON.parse(read('src/renderer/i18n/locales/zh.json'));

describe('reference-scenario evaluation pane', () => {
  it('summarizes the latest suite instead of only listing versions', () => {
    expect(panel).toContain('const latest = history.length > 0 ? history[history.length - 1] : null;');
    expect(panel).toContain("t('evalPanel.summary.title', { version: latest.version })");
    expect(panel).toContain("t('evalPanel.summary.successRate', { percent: asPercent(latest.summary.successRate) })");
    expect(panel).toContain("t('evalPanel.summary.avgTurns', { value: latest.summary.avgTurns.toFixed(1) })");
    expect(panel).toContain("t('evalPanel.summary.avgCost', { value: asUsd(latest.summary.avgCostUsd) })");
    expect(panel).toContain("t('evalPanel.summary.regressionRate'");
    expect(panel).toContain("t('evalPanel.summary.humanInterventionRate'");
  });

  it('reports per-scenario success, cost, regressions and interventions', () => {
    expect(panel).toContain('latest.records.map((record) => (');
    expect(panel).toContain("t('evalPanel.kind.' + record.kind)");
    expect(panel).toContain("t('evalPanel.records.turns', { value: record.metrics.turns })");
    expect(panel).toContain("t('evalPanel.records.regressions', { value: record.metrics.regressions })");
    expect(panel).toContain('value: record.metrics.humanInterventions');
    expect(panel).toContain('{record.error &&');
  });

  it('flags a regression when the candidate is worse on a tracked axis', () => {
    expect(panel).toContain('delta.noRegression ?');
    expect(panel).toContain("t('evalPanel.delta.noRegression')");
    expect(panel).toContain("t('evalPanel.delta.regression')");
    expect(panel).toContain('const asDelta = (value: number): string =>');
    expect(panel).toContain('deltaClass(delta.successRate)');
    expect(panel).toContain('deltaClass(delta.avgCostUsd)');
  });

  it('surfaces routing validation failures with their violations', () => {
    expect(panel).toContain('routing.outcomes.map((outcome) => (');
    expect(panel).toContain("t('evalPanel.routing.failed', { count: failingCases })");
    expect(panel).toContain("t('evalPanel.routing.violations', { count: outcome.violations.length })");
    expect(panel).toContain('outcome.violations.length > 0');
  });

  it('reports that benchmark execution is unavailable instead of faking a green suite', () => {
    expect(panel).toContain("t('evalPanel.unavailable')");
    expect(panel).toContain('err instanceof Error ? err.message : String(err)');
    expect(panel).toContain("t('evalPanel.empty')");
  });

  it('keeps comparison disabled until two suites exist', () => {
    expect(panel).toContain('disabled={!api || history.length < 2}');
    expect(panel).toContain('disabled={!api || history.length === 0}');
  });

  it('declares every evaluation string in all three locales', () => {
    const keys = [
      'title',
      'hint',
      'run',
      'running',
      'compare',
      'validateRouting',
      'clear',
      'empty',
      'unavailable',
      'version',
      'versionPlaceholder',
      'cleared',
    ];
    for (const key of keys) {
      expect(en.evalPanel[key], 'en.evalPanel.' + key).toBeTruthy();
      expect(fr.evalPanel[key], 'fr.evalPanel.' + key).toBeTruthy();
      expect(zh.evalPanel[key], 'zh.evalPanel.' + key).toBeTruthy();
    }
    for (const kind of ['bugfix', 'multi-file-feature', 'security-audit', 'long-task', 'session-resume']) {
      expect(en.evalPanel.kind[kind], 'en.evalPanel.kind.' + kind).toBeTruthy();
      expect(fr.evalPanel.kind[kind], 'fr.evalPanel.kind.' + kind).toBeTruthy();
      expect(zh.evalPanel.kind[kind], 'zh.evalPanel.kind.' + kind).toBeTruthy();
    }
    expect(en.controlCenter.tab.evals).toBe('Evals');
    expect(fr.controlCenter.tab.evals).toBeTruthy();
    expect(zh.controlCenter.tab.evals).toBeTruthy();
  });
});
