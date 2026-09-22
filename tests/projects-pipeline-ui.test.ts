import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * UI source contracts for the project two-stage pipeline toggle.
 *
 * The picker itself is exercised functionally in tests/configset-model-picker.test.ts;
 * these assertions pin the WIRING that cannot be unit-rendered without a full
 * Electron renderer harness:
 *  - single mode keeps exactly the historical single picker,
 *  - two-stage mode renders two distinct slots (draft + refinement),
 *  - both slots reuse ConfigSetModelPicker instead of duplicating selection logic,
 *  - every new string exists in the three maintained locales.
 */

const root = process.cwd();
const panel = readFileSync(
  resolve(root, 'src/renderer/components/ProjectsPanel.tsx'),
  'utf8'
);

function readLocale(locale: string): Record<string, Record<string, string>> {
  return JSON.parse(
    readFileSync(resolve(root, `src/renderer/i18n/locales/${locale}.json`), 'utf8')
  );
}

const PIPELINE_KEYS = [
  'pipelineEnable',
  'pipelineEnableHint',
  'pipelineDraftConfigSet',
  'pipelineDraftModel',
  'pipelineDraftNone',
  'pipelineRefineConfigSet',
  'pipelineRefineModel',
  'pipelineRefineNone',
  'pipelineCostHint',
  'pipelineRefineRequired',
];

describe('project pipeline UI wiring', () => {
  it('renders the historical single picker when the pipeline is off', () => {
    expect(panel).toContain('pipelineEnabled ? (');
    // The else-branch is the untouched single selection.
    expect(panel).toContain(
      `value={{ configSetId: configSetId, modelId: configModelId || undefined }}`
    );
    expect(panel).toContain(`emptyLabel={t('projects.configSetNone')}`);
  });

  it('renders two distinct slots when the pipeline is on', () => {
    expect(panel).toContain('draftConfigSetId');
    expect(panel).toContain('refineConfigSetId');
    expect(panel).toContain(`configSetLabel={t('projects.pipelineDraftConfigSet')}`);
    expect(panel).toContain(`configSetLabel={t('projects.pipelineRefineConfigSet')}`);
  });

  it('reuses ConfigSetModelPicker for every slot — no duplicated selection logic', () => {
    const pickerUses = panel.match(/<ConfigSetModelPicker/g) ?? [];
    expect(pickerUses.length).toBe(3); // single + draft + refinement
    expect(panel).toContain(
      "import { buildConfigSetLites, ConfigSetModelPicker } from './shared/ConfigSetModelPicker';"
    );
  });

  it('seeds both slots from the single selection when enabling the pipeline', () => {
    const flat = panel.replace(/\s+/g, ' ');
    expect(flat).toContain('setDraftConfigSetId((prev) => prev || configSetId);');
    expect(flat).toContain('setRefineConfigSetId((prev) => prev || configSetId);');
    expect(flat).toContain('setPipelineMode(');
  });

  it('refuses to save a pipeline without a refinement ConfigSet', () => {
    expect(panel).toContain('const pipelineInvalid = pipelineEnabled && !refineConfigSetId;');
    expect(panel).toContain(`setError(t('projects.pipelineRefineRequired'))`);
  });

  it('sends the pipeline fields on create and update', () => {
    expect(panel).toContain('pipelineMode,');
    expect(panel).toContain('draftConfigSetId: draftConfigSetId || null,');
    expect(panel).toContain('refineModelId: refineModelId || undefined,');
  });

  it('keeps every pipeline string translated in en, fr and zh', () => {
    for (const locale of ['en', 'fr', 'zh']) {
      const projects = readLocale(locale).projects;
      for (const key of PIPELINE_KEYS) {
        expect(projects[key], `${locale}: projects.${key}`).toBeTruthy();
      }
    }
  });
});
