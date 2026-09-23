/**
 * @module main/agent/proof-runner
 *
 * Cowork 4.0 — Phase 1.5: the workflow must not take the agent's word for it.
 * Every command a task declared as proof is re-run by the main process and its
 * real exit code is recorded. A non-zero exit code fails the criterion even
 * though "evidence" exists.
 */

import { exec } from 'node:child_process';
import type { AtomicTask } from '../../shared/task-contract';
import { commandFromVerification } from './verification';

export const DEFAULT_PROOF_TIMEOUT_MS = 300_000;
export const MAX_PROOF_OUTPUT_CHARS = 20_000;

export interface ProofCommandResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

export type ProofRunner = (
  command: string,
  cwd: string,
  timeoutMs?: number
) => Promise<ProofCommandResult>;

/** Every command a task declared, deduplicated and in a stable order. */
export function declaredCommands(task: AtomicTask): string[] {
  const commands: string[] = [];
  const push = (candidate: string | null | undefined): void => {
    if (!candidate) {
      return;
    }
    const trimmed = candidate.trim();
    if (trimmed.length > 0 && !commands.includes(trimmed)) {
      commands.push(trimmed);
    }
  };
  for (const criterion of task.exitCriteria) {
    push(commandFromVerification(criterion.verification));
  }
  for (const evidence of task.requiredEvidence) {
    push(evidence.command);
  }
  return commands;
}

function truncate(text: string): string {
  if (text.length <= MAX_PROOF_OUTPUT_CHARS) {
    return text;
  }
  return text.slice(text.length - MAX_PROOF_OUTPUT_CHARS);
}

/** Real shell runner used in production; never rejects. */
export function createShellProofRunner(): ProofRunner {
  return (command, cwd, timeoutMs = DEFAULT_PROOF_TIMEOUT_MS) =>
    new Promise<ProofCommandResult>((resolve) => {
      exec(
        command,
        { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          const combined = [stdout, stderr].filter((part) => part && part.length > 0).join('\n');
          const timedOut = Boolean(error && (error as { killed?: boolean }).killed);
          const exitCode =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? ((error as { code: number }).code as number)
              : error
                ? 1
                : 0;
          resolve({ exitCode, output: truncate(combined), timedOut });
        }
      );
    });
}
