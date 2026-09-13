/**
 * @module main/agent/self-healing-runner
 * v3.6+: Autonomous Closed-Loop Self-Healing Engine (Auto-test, Error Extraction, Auto-fix)
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TestExecutionResult {
  passed: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  extractedErrors: string[];
}

export interface HealingIteration {
  iteration: number;
  testResult: TestExecutionResult;
  proposedFix?: string;
  status: 'fixed' | 'retrying' | 'failed';
}

export class SelfHealingRunner {
  private maxIterations: number;

  constructor(maxIterations: number = 3) {
    this.maxIterations = maxIterations;
  }

  public async runTestCommand(command: string, cwd: string): Promise<TestExecutionResult> {
    try {
      const { stdout, stderr } = await execAsync(command, { cwd });
      return {
        passed: true,
        command,
        stdout,
        stderr,
        exitCode: 0,
        extractedErrors: [],
      };
    } catch (err: any) {
      const stdout = err.stdout || '';
      const stderr = err.stderr || err.message || '';
      const extractedErrors = this.parseErrors(stdout + '\n' + stderr);
      return {
        passed: false,
        command,
        stdout,
        stderr,
        exitCode: err.code || 1,
        extractedErrors,
      };
    }
  }

  public parseErrors(output: string): string[] {
    const errorLines: string[] = [];
    const lines = output.split('\n');
    for (const line of lines) {
      if (
        line.toLowerCase().includes('error:') ||
        line.toLowerCase().includes('fail') ||
        line.includes('TS2') ||
        line.includes('TypeError') ||
        line.includes('SyntaxError')
      ) {
        errorLines.push(line.trim());
      }
    }
    return errorLines.slice(0, 10);
  }

  public async executeHealingLoop(
    testCommand: string,
    cwd: string,
    applyFixCallback: (errors: string[]) => Promise<string>
  ): Promise<{ resolved: boolean; iterations: HealingIteration[] }> {
    const iterations: HealingIteration[] = [];

    for (let i = 1; i <= this.maxIterations; i++) {
      const testRes = await this.runTestCommand(testCommand, cwd);
      if (testRes.passed) {
        iterations.push({
          iteration: i,
          testResult: testRes,
          status: 'fixed',
        });
        return { resolved: true, iterations };
      }

      const fixDescription = await applyFixCallback(testRes.extractedErrors);
      iterations.push({
        iteration: i,
        testResult: testRes,
        proposedFix: fixDescription,
        status: i === this.maxIterations ? 'failed' : 'retrying',
      });
    }

    return { resolved: false, iterations };
  }
}
