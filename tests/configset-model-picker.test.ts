import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Contract: the two-level ConfigSet → model picker is a SINGLE shared
 * component used by BOTH screens (sub-agents settings AND the project edit
 * modal) — no duplicated logic that could drift apart.
 */

const root = resolve(__dirname, '..');
const picker = readFileSync(
  resolve(root, 'src/renderer/components/shared/ConfigSetModelPicker.tsx'),
  'utf8'
);
const subAgents = readFileSync(
  resolve(root, 'src/renderer/components/settings/SettingsSubAgents.tsx'),
  'utf8'
);
const projectsPanel = readFileSync(
  resolve(root, 'src/renderer/components/ProjectsPanel.tsx'),
  'utf8'
);

describe('ConfigSetModelPicker — one shared component, two screens', () => {
  it('exists as a shared component exposing the set enrichment helper', () => {
    expect(picker).toContain('export function ConfigSetModelPicker');
    expect(picker).toContain('export function buildConfigSetLites');
    // Two-level: a set select plus a model select fed by the chosen set.
    expect(picker).toContain('chosen.models.map');
  });

  it('SettingsSubAgents uses the shared picker (global + per-role) — no duplicated markup', () => {
    expect(subAgents).toContain("from '../shared/ConfigSetModelPicker'");
    const pickerUsages = subAgents.split('<ConfigSetModelPicker').length - 1;
    expect(pickerUsages).toBeGreaterThanOrEqual(2); // global sub-agents + per-role grid
    // The old inline two-select implementation is gone.
    expect(subAgents).not.toContain('chosenSet.models.map');
    expect(subAgents).not.toContain("const chosen = sets.find((set) => set.id === draft.configSetId)");
  });

  it('ProjectsPanel uses the SAME shared picker for the project model profile', () => {
    expect(projectsPanel).toContain("from './shared/ConfigSetModelPicker'");
    expect(projectsPanel).toContain('<ConfigSetModelPicker');
    // No separate second implementation of the model list in the panel.
    expect(projectsPanel).not.toContain('chosen.models.map');
  });

  it('DelegatedTasksPanel uses the SAME shared picker (3rd consumer, no new implementation)', () => {
    const panel = readFileSync(
      resolve(root, 'src/renderer/components/DelegatedTasksPanel.tsx'),
      'utf8'
    );
    expect(panel).toContain("from './shared/ConfigSetModelPicker'");
    expect(panel).toContain('<ConfigSetModelPicker');
    expect(panel).toContain('buildConfigSetLites');
    expect(panel).not.toContain('chosen.models.map');
  });
});

describe('project model pin — resolution wiring', () => {
  const agentRunner = readFileSync(
    resolve(root, 'src/main/agent/agent-runner.ts'),
    'utf8'
  );
  const projectContext = readFileSync(
    resolve(root, 'src/main/projects/project-context.ts'),
    'utf8'
  );

  it('the project resolution carries the pinned modelId', () => {
    expect(projectContext).toContain('configModelId: project.modelId');
  });

  it('the runner passes the pinned model to the projected ConfigSet config', () => {
    expect(agentRunner).toContain(
      'getConfigSetProjectedConfig(\n              projectContext.configSetId,\n              projectContext.configModelId ?? undefined\n            )'
    );
  });
});