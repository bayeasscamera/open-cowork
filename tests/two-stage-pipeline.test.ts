import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The mock factory runs at import time, so the userData root is created
// lazily on the first getPath call — after module-level bindings exist.
let testRoot = '';

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      if (!testRoot) testRoot = mkdtempSync(join(tmpdir(), 'cowork-pipeline-'));
      return testRoot;
    },
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import {
  DEFAULT_PIPELINE_MODE,
  MIN_REFINE_DRAFT_CHARS,
  MIN_REFINE_REQUEST_CHARS,
  buildRefinePrompt,
  buildRefineSystemPrompt,
  buildDraftDetailText,
  decideTwoStage,
  isPipelineMode,
  isTrivialRequest,
  mergeTokenUsage,
  normalizePipelineMode,
  runTwoStagePipeline,
  shouldArmTwoStage,
  shouldRefineDraft,
} from '../src/main/projects/two-stage-pipeline';
import { initDatabase, closeDatabase, getDatabase } from '../src/main/db/database';
import { createProjectStore } from '../src/main/projects/project-store';
import { resolveProjectContext } from '../src/main/projects/project-context';

// Real better-sqlite3 database at the mocked userData root.
initDatabase();
const workdir = join(testRoot, 'workdir');
mkdirSync(workdir, { recursive: true });

afterAll(() => {
  closeDatabase();
  rmSync(testRoot, { recursive: true, force: true });
});

const SUBSTANTIAL_REQUEST =
  'Analyse le cahier des charges du lot 1 et propose un plan de réponse détaillé.';
const DRAFT = 'x'.repeat(MIN_REFINE_DRAFT_CHARS + 50);

describe('pipeline mode normalization', () => {
  it('defaults to single for anything that is not two-stage', () => {
    expect(DEFAULT_PIPELINE_MODE).toBe('single');
    expect(normalizePipelineMode(undefined)).toBe('single');
    expect(normalizePipelineMode(null)).toBe('single');
    expect(normalizePipelineMode('')).toBe('single');
    expect(normalizePipelineMode('two-pass')).toBe('single');
    expect(normalizePipelineMode('single')).toBe('single');
    expect(normalizePipelineMode('two-stage')).toBe('two-stage');
    expect(isPipelineMode('two-stage')).toBe(true);
    expect(isPipelineMode('nope')).toBe(false);
  });
});

describe('arming the two-stage pipeline', () => {
  it('never arms when the project runs in single mode', () => {
    const decision = shouldArmTwoStage({
      mode: 'single',
      userRequest: SUBSTANTIAL_REQUEST,
      hasRefineModel: true,
    });
    expect(decision).toEqual({ run: false, reason: 'mode-off' });
  });

  it('never arms without a refine ConfigSet — no silent half-pipeline', () => {
    const decision = shouldArmTwoStage({
      mode: 'two-stage',
      userRequest: SUBSTANTIAL_REQUEST,
      hasRefineModel: false,
    });
    expect(decision).toEqual({ run: false, reason: 'missing-refine-model' });
  });

  it('skips trivial or conversational requests', () => {
    for (const request of ['merci', 'OK continue', '  ', 'oui', 'thanks!', 'vas-y']) {
      const decision = shouldArmTwoStage({
        mode: 'two-stage',
        userRequest: request,
        hasRefineModel: true,
      });
      expect(decision.run).toBe(false);
      expect(decision.reason).toBe('trivial-request');
    }
  });

  it('arms a substantial request in two-stage mode', () => {
    const decision = shouldArmTwoStage({
      mode: 'two-stage',
      userRequest: SUBSTANTIAL_REQUEST,
      hasRefineModel: true,
    });
    expect(decision).toEqual({ run: true, reason: 'ok' });
  });

  it('classifies requests conservatively (only obvious acknowledgements)', () => {
    expect(isTrivialRequest('merci')).toBe(true);
    expect(isTrivialRequest('Merci beaucoup, continue comme ça sur le lot 2')).toBe(false);
    expect(isTrivialRequest('a'.repeat(MIN_REFINE_REQUEST_CHARS))).toBe(false);
    expect(isTrivialRequest('a'.repeat(MIN_REFINE_REQUEST_CHARS - 1))).toBe(true);
  });
});

describe('refining a draft', () => {
  it('refuses an empty draft and a short draft', () => {
    expect(shouldRefineDraft('')).toEqual({ run: false, reason: 'no-draft' });
    expect(shouldRefineDraft('   ')).toEqual({ run: false, reason: 'no-draft' });
    expect(shouldRefineDraft('trop court')).toEqual({ run: false, reason: 'short-draft' });
  });

  it('refines a substantial draft', () => {
    expect(shouldRefineDraft(DRAFT)).toEqual({ run: true, reason: 'ok' });
  });

  it('combines both gates in decideTwoStage', () => {
    expect(
      decideTwoStage({
        mode: 'single',
        userRequest: SUBSTANTIAL_REQUEST,
        hasRefineModel: true,
        draftText: DRAFT,
      }).reason
    ).toBe('mode-off');
    expect(
      decideTwoStage({
        mode: 'two-stage',
        userRequest: 'merci',
        hasRefineModel: true,
        draftText: DRAFT,
      }).reason
    ).toBe('trivial-request');
    expect(
      decideTwoStage({
        mode: 'two-stage',
        userRequest: SUBSTANTIAL_REQUEST,
        hasRefineModel: true,
        draftText: 'court',
      }).reason
    ).toBe('short-draft');
    expect(
      decideTwoStage({
        mode: 'two-stage',
        userRequest: SUBSTANTIAL_REQUEST,
        hasRefineModel: true,
        draftText: DRAFT,
      })
    ).toEqual({ run: true, reason: 'ok' });
  });
});

describe('refine prompts carry both the request and the draft', () => {
  it('states the draft is to be reviewed, not rewritten', () => {
    const systemPrompt = buildRefineSystemPrompt();
    expect(systemPrompt).toContain('do not rewrite it from scratch unless it is actually wrong');
    // The prompt is wrapped across lines; assert on the flattened text.
    expect(systemPrompt.replace(/\s+/g, ' ')).toContain('no mention that a draft existed');
  });

  it('embeds the raw request and the raw draft', () => {
    const prompt = buildRefinePrompt({ userRequest: SUBSTANTIAL_REQUEST, draftText: DRAFT });
    expect(prompt).toContain('<request>');
    expect(prompt).toContain(SUBSTANTIAL_REQUEST);
    expect(prompt).toContain('<draft>');
    expect(prompt).toContain(DRAFT);
    expect(prompt).toContain('do not rewrite from scratch unless necessary');
  });
});

describe('runTwoStagePipeline', () => {
  it('returns the draft untouched when the decision says not to run', async () => {
    let called = false;
    const result = await runTwoStagePipeline({
      decision: { run: false, reason: 'trivial-request' },
      userRequest: 'merci',
      draftText: DRAFT,
      refine: async () => {
        called = true;
        return { text: 'jamais' };
      },
    });
    expect(called).toBe(false);
    expect(result).toEqual({ finalText: DRAFT, usedFallback: false });
  });

  it('presents the refined text and reports its usage', async () => {
    const result = await runTwoStagePipeline({
      decision: { run: true, reason: 'ok' },
      userRequest: SUBSTANTIAL_REQUEST,
      draftText: DRAFT,
      refine: async () => ({ text: '  version finalisée  ', usage: { input: 120, output: 340 } }),
    });
    expect(result.finalText).toBe('version finalisée');
    expect(result.usedFallback).toBe(false);
    expect(result.usage).toEqual({ input: 120, output: 340 });
  });

  it('falls back to the draft when the refine model throws — never a silent block', async () => {
    const result = await runTwoStagePipeline({
      decision: { run: true, reason: 'ok' },
      userRequest: SUBSTANTIAL_REQUEST,
      draftText: DRAFT,
      refine: async () => {
        throw new Error('rate limit');
      },
    });
    expect(result.finalText).toBe(DRAFT);
    expect(result.usedFallback).toBe(true);
    expect(result.refineError).toBe('rate limit');
  });

  it('falls back when the refine model answers with nothing', async () => {
    const result = await runTwoStagePipeline({
      decision: { run: true, reason: 'ok' },
      userRequest: SUBSTANTIAL_REQUEST,
      draftText: DRAFT,
      refine: async () => ({ text: '   ' }),
    });
    expect(result.finalText).toBe(DRAFT);
    expect(result.usedFallback).toBe(true);
    expect(result.refineError).toContain('empty');
  });
});

describe('cost transparency and draft accessibility', () => {
  it('merges both passes into a single usage figure', () => {
    expect(mergeTokenUsage({ input: 10, output: 20 }, { input: 5, output: 7 })).toEqual({
      input: 15,
      output: 27,
    });
    expect(mergeTokenUsage(undefined, { input: 5, output: 7 })).toEqual({ input: 5, output: 7 });
    expect(mergeTokenUsage({ input: 1, output: 2 }, undefined)).toEqual({ input: 1, output: 2 });
    expect(mergeTokenUsage(undefined, undefined)).toBeUndefined();
  });

  it('labels the draft detail with both stages and keeps the draft text', () => {
    const detail = buildDraftDetailText({
      draftText: 'premier jet',
      draftLabel: 'openai/gpt-5-mini',
      refineLabel: 'anthropic/claude-opus-4',
    });
    expect(detail).toContain('1/2');
    expect(detail).toContain('openai/gpt-5-mini');
    expect(detail).toContain('anthropic/claude-opus-4');
    expect(detail).toContain('premier jet');
  });
});

describe('ProjectStore persistence of the pipeline configuration', () => {
  it('defaults to single mode with empty slots', () => {
    const store = createProjectStore(getDatabase());
    const project = store.create({ name: 'Défaut', workdir });
    expect(project.pipelineMode).toBe('single');
    expect(project.draftConfigSetId).toBeNull();
    expect(project.draftModelId).toBeNull();
    expect(project.refineConfigSetId).toBeNull();
    expect(project.refineModelId).toBeNull();
  });

  it('persists a two-stage configuration across a read-back', () => {
    const store = createProjectStore(getDatabase());
    const created = store.create({
      name: 'Pipeline',
      workdir,
      configSetId: 'set-main',
      modelId: 'modele-principal',
      pipelineMode: 'two-stage',
      draftConfigSetId: 'set-rapide',
      draftModelId: 'petit-modele',
      refineConfigSetId: 'set-fort',
      refineModelId: 'grand-modele',
    });

    const loaded = store.get(created.id);
    expect(loaded?.pipelineMode).toBe('two-stage');
    expect(loaded?.draftConfigSetId).toBe('set-rapide');
    expect(loaded?.draftModelId).toBe('petit-modele');
    expect(loaded?.refineConfigSetId).toBe('set-fort');
    expect(loaded?.refineModelId).toBe('grand-modele');
    // The single-mode selection survives alongside the pipeline slots.
    expect(loaded?.configSetId).toBe('set-main');
    expect(loaded?.modelId).toBe('modele-principal');
  });

  it('normalizes an unknown mode and clears slots on update', () => {
    const store = createProjectStore(getDatabase());
    const project = store.create({
      name: 'Nettoyage',
      workdir,
      pipelineMode: 'two-stage',
      refineConfigSetId: 'set-fort',
    });
    const updated = store.update(project.id, {
      // Defensive: a corrupted/legacy value must degrade to single mode.
      pipelineMode: 'two-passes' as never,
      refineConfigSetId: null,
      draftModelId: null,
    });
    expect(updated.pipelineMode).toBe('single');
    expect(updated.refineConfigSetId).toBeNull();
    expect(updated.draftModelId).toBeNull();
  });
});

describe('resolveProjectContext exposes the pipeline configuration', () => {
  const stub = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'p1',
      name: 'Projet',
      description: null,
      workdir: '/w',
      configSetId: null,
      modelId: null,
      pipelineMode: 'single',
      draftConfigSetId: null,
      draftModelId: null,
      refineConfigSetId: null,
      refineModelId: null,
      instructions: null,
      archived: false,
      referenceFiles: [],
      createdAt: 0,
      updatedAt: 0,
      ...overrides,
    }) as never;

  it('degrades a project without pipeline to single mode', () => {
    const resolution = resolveProjectContext('s-none', { getForSession: () => undefined });
    expect(resolution.pipelineMode).toBe('single');
    expect(resolution.refineConfigSetId).toBeNull();
  });

  it('surfaces the draft and refine slots of a two-stage project', () => {
    const resolution = resolveProjectContext('s1', {
      getForSession: () =>
        stub({
          pipelineMode: 'two-stage',
          draftConfigSetId: 'set-rapide',
          draftModelId: 'petit',
          refineConfigSetId: 'set-fort',
          refineModelId: 'grand',
        }),
    });
    expect(resolution.pipelineMode).toBe('two-stage');
    expect(resolution.draftConfigSetId).toBe('set-rapide');
    expect(resolution.draftModelId).toBe('petit');
    expect(resolution.refineConfigSetId).toBe('set-fort');
    expect(resolution.refineModelId).toBe('grand');
  });

  it('normalizes a corrupted mode read from the database', () => {
    const resolution = resolveProjectContext('s2', {
      getForSession: () => stub({ pipelineMode: 'legacy-value' }),
    });
    expect(resolution.pipelineMode).toBe('single');
  });
});
