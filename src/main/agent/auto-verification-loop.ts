/**
 * @module main/agent/auto-verification-loop
 *
 * Pilier 1 — Self-Verification Loop
 *
 * Automatically runs typecheck → targeted tests → lint after every agent edit.
 * Feeds errors back into agent context for autonomous repair.
 */

import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { log } from '../utils/logger';

const execAsync = promisify(exec);

export interface VerificationPhaseResult {
  passed: boolean;
  errors: string[];
}

export interface VerificationSummary {
  allPassed: boolean;
  typecheck: VerificationPhaseResult;
  tests: VerificationPhaseResult & { filesRun: string[] };
  lint: VerificationPhaseResult;
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTestFiles(touchedFiles: string[], projectRoot: string): string[] {
  const testsDir = path.join(projectRoot, 'tests');
  if (!fs.existsSync(testsDir)) return [];

  const candidates = new Set<string>();
  for (const file of touchedFiles) {
    const base = path.basename(file, path.extname(file));

    const direct = path.join(testsDir, `${base}.test.ts`);
    if (fs.existsSync(direct)) candidates.add(direct);

    const kebab = base.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`).replace(/^-/, '');
    const kebabTest = path.join(testsDir, `${kebab}.test.ts`);
    if (fs.existsSync(kebabTest)) candidates.add(kebabTest);
  }
  return Array.from(candidates);
}

// ---------------------------------------------------------------------------
// AutoVerificationLoop
// ---------------------------------------------------------------------------

export class AutoVerificationLoop {
  constructor(
    private readonly projectRoot: string = process.cwd(),
  ) {}

  async verify(touchedFiles: string[] = []): Promise<VerificationSummary> {
    const start = Date.now();
    log(`[AutoVerificationLoop] Verifying ${touchedFiles.length} touched file(s)…`);

    const summary: VerificationSummary = {
      allPassed: false,
      typecheck: { passed: false, errors: [] },
      tests: { passed: false, errors: [], filesRun: [] },
      lint: { passed: true, errors: [] },
      totalDurationMs: 0,
    };

    // Phase 1: TypeCheck
    summary.typecheck = await this.runTypecheck();
    if (!summary.typecheck.passed) {
      summary.totalDurationMs = Date.now() - start;
      return summary;
    }
    log('[AutoVerificationLoop] ✅ Typecheck passed');

    // Phase 2: Targeted tests
    const testFiles = resolveTestFiles(touchedFiles, this.projectRoot);
    const testResult = await this.runTests(testFiles);
    summary.tests = { ...testResult, filesRun: testFiles };
    if (!summary.tests.passed) {
      summary.totalDurationMs = Date.now() - start;
      return summary;
    }
    log(`[AutoVerificationLoop] ✅ Tests passed (${testFiles.length} file(s))`);

    // Phase 3: Lint (non-blocking, warning only)
    summary.lint = await this.runLint(touchedFiles);
    if (!summary.lint.passed) {
      log(`[AutoVerificationLoop] ⚠️  Lint warnings: ${summary.lint.errors.length}`);
    }

    summary.allPassed = true;
    summary.totalDurationMs = Date.now() - start;
    log(`[AutoVerificationLoop] ✅ All passed in ${summary.totalDurationMs}ms`);
    return summary;
  }

  private async runTypecheck(): Promise<VerificationPhaseResult> {
    try {
      await execAsync('npx tsc --noEmit', { cwd: this.projectRoot, timeout: 60_000 });
      return { passed: true, errors: [] };
    } catch (err: unknown) {
      const out = (err as { stdout?: string }).stdout ?? String(err);
      const errors = out.split('\n').filter((l) => l.includes('error TS')).slice(0, 20);
      return { passed: false, errors };
    }
  }

  private async runTests(testFiles: string[]): Promise<VerificationPhaseResult> {
    if (testFiles.length === 0) return { passed: true, errors: [] };
    try {
      const args = testFiles.map((f) => `"${f}"`).join(' ');
      await execAsync(`npx vitest run ${args}`, { cwd: this.projectRoot, timeout: 120_000 });
      return { passed: true, errors: [] };
    } catch (err: unknown) {
      const out = (err as { stdout?: string }).stdout ?? String(err);
      const errors = out.split('\n').filter((l) => /FAIL|AssertionError|Expected/.test(l)).slice(0, 20);
      return { passed: false, errors };
    }
  }

  private async runLint(touchedFiles: string[]): Promise<VerificationPhaseResult> {
    const tsFiles = touchedFiles.filter((f) => /\.(ts|tsx)$/.test(f));
    if (tsFiles.length === 0) return { passed: true, errors: [] };
    try {
      const args = tsFiles.map((f) => `"${f}"`).join(' ');
      await execAsync(`npx eslint ${args} --max-warnings 0`, { cwd: this.projectRoot, timeout: 30_000 });
      return { passed: true, errors: [] };
    } catch (err: unknown) {
      const out = (err as { stdout?: string }).stdout ?? String(err);
      const errors = out.split('\n').filter((l) => /error|warning/.test(l)).slice(0, 15);
      return { passed: false, errors };
    }
  }

  static formatSummary(s: VerificationSummary): string {
    const lines = [
      '=== Auto-Verification Report ===',
      `Typecheck : ${s.typecheck.passed ? '✅' : '❌ ' + s.typecheck.errors.slice(0, 3).join(' | ')}`,
      `Tests     : ${s.tests.passed ? '✅' : '❌ ' + s.tests.errors.slice(0, 3).join(' | ')} (${s.tests.filesRun.length} file(s))`,
      `Lint      : ${s.lint.passed ? '✅' : '⚠️  ' + s.lint.errors.slice(0, 2).join(' | ')}`,
      `Duration  : ${s.totalDurationMs}ms`,
      `Overall   : ${s.allPassed ? '✅ PASSED' : '❌ FAILED — fix errors above'}`,
    ];
    return lines.join('\n');
  }
}
