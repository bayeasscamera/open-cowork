/**
 * @module main/agent/tdd-orchestrator
 *
 * Pilier 3 — TDD Loop (Test-Driven Development Orchestrator)
 *
 * Implements the Red → Green → Refactor cycle:
 * 1. RED   : Generate test file that describes the feature. Run → expect failure.
 * 2. GREEN : Generate implementation code to pass the tests. Run → expect pass.
 * 3. REFACTOR: Optionally suggest improvements without breaking tests.
 *
 * Exposed as a ToolDefinition: `run_tdd_cycle`
 */

import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { log, logError } from '../utils/logger';
import { runPiAiOneShot } from './sdk-one-shot';
import { configStore } from '../config/config-store';

const execAsync = promisify(exec);

export type TddPhase = 'red' | 'green' | 'refactor' | 'failed';

export interface TddCycleResult {
  feature: string;
  phase: TddPhase;
  testFilePath: string;
  implFilePath: string;
  testOutput: string;
  suggestion?: string;
  durationMs: number;
}

const TEST_GENERATION_PROMPT = `You are a senior TypeScript engineer implementing Test-Driven Development.
Given a feature description, generate a Vitest test file that:
1. Imports the module-under-test from a sensible path (e.g. ../src/main/... or ../src/shared/...)
2. Contains describe + it blocks with concrete assertions
3. Tests edge cases (null, empty, error)
4. Uses NO mocks unless absolutely required

Return ONLY the TypeScript test file content, no markdown fences.`;

const IMPL_GENERATION_PROMPT = `You are a senior TypeScript engineer.
Given a failing Vitest test file, generate the minimal implementation that makes ALL tests pass.
Return ONLY the TypeScript implementation file content, no markdown fences.`;

async function runTests(testFile: string, cwd: string): Promise<{ passed: boolean; output: string }> {
  try {
    const { stdout } = await execAsync(`npx vitest run "${testFile}"`, { cwd, timeout: 60_000 });
    return { passed: true, output: stdout };
  } catch (err: unknown) {
    const out = (err as { stdout?: string }).stdout ?? String(err);
    return { passed: false, output: out };
  }
}

export class TddOrchestrator {
  constructor(private readonly projectRoot: string = process.cwd()) {}

  async runCycle(featureDescription: string): Promise<TddCycleResult> {
    const start = Date.now();
    const slug = featureDescription
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 40);

    const testFilePath = path.join(this.projectRoot, 'tests', `tdd-${slug}.test.ts`);
    const implFilePath = path.join(this.projectRoot, 'src', 'main', 'agent', `tdd-${slug}.ts`);
    const appConfig = configStore.getAll();

    log(`[TddOrchestrator] 🔴 RED phase — generating tests for: "${featureDescription}"`);

    // --- RED phase: generate test ---
    let testContent: string;
    try {
      const resp = await runPiAiOneShot(
        `Feature to test:\n${featureDescription}\n\nImpl file will be at: ${implFilePath}`,
        TEST_GENERATION_PROMPT,
        appConfig,
        { temperature: 0.2 }
      );
      testContent = resp.text.trim();
    } catch (err) {
      logError('[TddOrchestrator] Failed to generate test:', err);
      return { feature: featureDescription, phase: 'failed', testFilePath, implFilePath, testOutput: String(err), durationMs: Date.now() - start };
    }

    fs.writeFileSync(testFilePath, testContent, 'utf-8');

    const redResult = await runTests(testFilePath, this.projectRoot);
    if (redResult.passed) {
      log('[TddOrchestrator] ⚠️  Tests passed before implementation — may be trivially true');
    } else {
      log('[TddOrchestrator] ✅ RED confirmed — tests fail as expected');
    }

    // --- GREEN phase: generate implementation ---
    log(`[TddOrchestrator] 🟢 GREEN phase — generating implementation`);
    let implContent: string;
    try {
      const resp = await runPiAiOneShot(
        `Failing test file:\n\`\`\`typescript\n${testContent}\n\`\`\`\n\nFailing output:\n${redResult.output.slice(0, 2000)}\n\nGenerate implementation at: ${implFilePath}`,
        IMPL_GENERATION_PROMPT,
        appConfig,
        { temperature: 0.1 }
      );
      implContent = resp.text.trim();
    } catch (err) {
      logError('[TddOrchestrator] Failed to generate implementation:', err);
      return { feature: featureDescription, phase: 'failed', testFilePath, implFilePath, testOutput: redResult.output, durationMs: Date.now() - start };
    }

    fs.writeFileSync(implFilePath, implContent, 'utf-8');

    const greenResult = await runTests(testFilePath, this.projectRoot);

    if (!greenResult.passed) {
      log('[TddOrchestrator] ❌ GREEN failed — tests still failing after implementation');
      return {
        feature: featureDescription,
        phase: 'failed',
        testFilePath,
        implFilePath,
        testOutput: greenResult.output,
        suggestion: 'Review the implementation at ' + implFilePath + ' and fix the failing assertions.',
        durationMs: Date.now() - start,
      };
    }

    log('[TddOrchestrator] ✅ GREEN — all tests pass!');

    // --- REFACTOR phase: static suggestion ---
    const suggestion = `Implementation at ${implFilePath} passes all tests. Consider:\n1. Extracting helper functions if > 50 lines\n2. Adding JSDoc to exported symbols\n3. Moving to the correct module directory`;

    return {
      feature: featureDescription,
      phase: 'refactor',
      testFilePath,
      implFilePath,
      testOutput: greenResult.output,
      suggestion,
      durationMs: Date.now() - start,
    };
  }
}
