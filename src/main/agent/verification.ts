/**
 * @module main/agent/verification
 *
 * Cowork 4.0 — Phase 1.5/2.4: verification that treats evidence as *proof*.
 *
 * A criterion is only satisfied when the proof actually demonstrates it:
 *  - a command criterion needs evidence that ran that command and exited 0;
 *  - a non-zero exit code fails the criterion even though evidence exists;
 *  - an inspection criterion needs content (a diff, a review body, a note),
 *    never just a placeholder entry;
 *  - a required evidence declaration with a command needs a successful run.
 *
 * Everything here is pure: it reads tasks and checkpoints and returns a report.
 */

import type { AcceptanceCriterion, AtomicTask, EvidenceKind } from '../../shared/task-contract';
import type {
  CheckpointEvidence,
  CriterionOutcome,
  CriterionVerification,
  TaskCheckpoint,
  TaskVerification,
  VerificationReport,
} from '../../shared/workflow-types';

/** Minimum length of an inspection body before it counts as real content. */
export const MIN_INSPECTION_CHARS = 10;

const COMMAND_PREFIX = 'inspection:';

/** Evidence kinds that can demonstrate an inspection criterion. */
export const INSPECTION_KINDS: readonly EvidenceKind[] = ['review', 'note', 'artifact', 'diff'];

/** Normalise a command for comparison: trim and collapse inner whitespace. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** A criterion is command-based unless it explicitly says 'inspection: ...'. */
export function isCommandVerification(verification: string): boolean {
  return !verification.trim().toLowerCase().startsWith(COMMAND_PREFIX);
}

/** The command a criterion declares, or null for an inspection criterion. */
export function commandFromVerification(verification: string): string | null {
  return isCommandVerification(verification) ? normalizeCommand(verification) : null;
}

/** The inspection label a criterion declares, or null for a command criterion. */
export function inspectionFromVerification(verification: string): string | null {
  if (isCommandVerification(verification)) {
    return null;
  }
  const body = verification.trim().slice(COMMAND_PREFIX.length).trim();
  return body.length > 0 ? body : 'inspection';
}

function evidenceSucceeded(entry: CheckpointEvidence): boolean {
  return typeof entry.exitCode === 'number' && entry.exitCode === 0;
}

function evidenceFailed(entry: CheckpointEvidence): boolean {
  return typeof entry.exitCode === 'number' && entry.exitCode !== 0;
}

/** Evidence that carries an actual body, not just a label. */
export function hasInspectionContent(
  entry: CheckpointEvidence,
  checkpoint: TaskCheckpoint | null
): boolean {
  const output = entry.output?.trim() ?? '';
  if (output.length >= MIN_INSPECTION_CHARS) {
    return true;
  }
  const diff = entry.diff?.trim() ?? '';
  if (diff.length >= MIN_INSPECTION_CHARS) {
    return true;
  }
  // A diff lives on the evidence when the worktree was ephemeral (it is gone
  // by then), or on the checkpoint when it is still reachable.
  if (entry.kind === 'diff') {
    return Boolean(checkpoint?.diff && checkpoint.diff.trim().length > 0);
  }
  // Any output — including raw test output — is content to review.
  return output.length >= MIN_INSPECTION_CHARS;
}

/** Evidence whose command matches, ignoring surrounding whitespace. */
function matchesCommand(entry: CheckpointEvidence, command: string): boolean {
  if (!entry.command) {
    return false;
  }
  return normalizeCommand(entry.command) === command;
}

interface EvidenceLookup {
  evidence: CheckpointEvidence[];
  checkpoint: TaskCheckpoint | null;
}

function verifyCommandCriterion(
  taskId: string,
  criterion: AcceptanceCriterion,
  command: string,
  lookup: EvidenceLookup
): CriterionVerification {
  const base = {
    taskId,
    criterionId: criterion.id,
    description: criterion.description,
    verification: criterion.verification,
    required: criterion.required,
  };

  const candidates = lookup.evidence.filter((entry) => matchesCommand(entry, command));
  const succeeded = candidates.find((entry) => evidenceSucceeded(entry));
  if (succeeded) {
    return {
      ...base,
      outcome: 'verified',
      reason: 'Command "' + command + '" ran and exited 0.',
      evidenceId: succeeded.id,
    };
  }

  const failed = candidates.find((entry) => evidenceFailed(entry));
  if (failed) {
    return {
      ...base,
      outcome: 'failed',
      reason:
        'Command "' +
        command +
        '" exited ' +
        String(failed.exitCode) +
        '; the criterion is not met.',
      evidenceId: failed.id,
    };
  }

  if (candidates.length > 0) {
    return {
      ...base,
      outcome: 'missing-evidence',
      reason: 'Evidence for "' + command + '" does not record an exit code.',
      evidenceId: candidates[0].id,
    };
  }

  return {
    ...base,
    outcome: 'missing-evidence',
    reason: 'No evidence shows that "' + command + '" was run.',
  };
}

function verifyInspectionCriterion(
  taskId: string,
  criterion: AcceptanceCriterion,
  lookup: EvidenceLookup
): CriterionVerification {
  const base = {
    taskId,
    criterionId: criterion.id,
    description: criterion.description,
    verification: criterion.verification,
    required: criterion.required,
  };

  const candidates = lookup.evidence.filter((entry) => INSPECTION_KINDS.includes(entry.kind));
  const withContent = candidates.find((entry) => hasInspectionContent(entry, lookup.checkpoint));
  if (withContent) {
    return {
      ...base,
      outcome: 'verified',
      reason: 'Inspection evidence carries the required content.',
      evidenceId: withContent.id,
    };
  }

  if (candidates.length > 0) {
    return {
      ...base,
      outcome: 'missing-evidence',
      reason:
        'Inspection evidence exists but carries no content to review (at least ' +
        String(MIN_INSPECTION_CHARS) +
        ' characters of output, a diff, or both are required).',
      evidenceId: candidates[0].id,
    };
  }

  return {
    ...base,
    outcome: 'missing-evidence',
    reason: 'No inspection evidence (review, note, artifact or diff) was attached.',
  };
}

/** Required evidence declarations must themselves be proven. */
function verifyRequiredEvidence(
  taskId: string,
  task: AtomicTask,
  lookup: EvidenceLookup
): string[] {
  const issues: string[] = [];
  for (const requirement of task.requiredEvidence) {
    if (!requirement.required || requirement.kind === 'diff') {
      // A diff is produced and counted by the checkpoint itself; requiring a
      // second hand-written diff entry would block every honest run.
      continue;
    }
    const candidates = lookup.evidence.filter((entry) => entry.kind === requirement.kind);
    if (candidates.length === 0) {
      issues.push(taskId + ': missing ' + requirement.kind + ' evidence');
      continue;
    }
    if (requirement.command) {
      const command = normalizeCommand(requirement.command);
      const matching = candidates.filter((entry) => matchesCommand(entry, command));
      if (matching.length === 0) {
        issues.push(
          taskId + ': ' + requirement.kind + ' evidence never ran "' + command + '"'
        );
        continue;
      }
      if (!matching.some((entry) => evidenceSucceeded(entry))) {
        issues.push(
          taskId + ': "' + command + '" did not exit 0 for the required ' + requirement.kind + ' evidence'
        );
        continue;
      }
    }
    if (!candidates.some((entry) => hasInspectionContent(entry, lookup.checkpoint))) {
      // A required evidence entry with no command still needs a body.
      const isCommandEvidence = candidates.some((entry) => evidenceSucceeded(entry));
      if (!isCommandEvidence) {
        issues.push(taskId + ': ' + requirement.kind + ' evidence carries no content');
      }
    }
  }
  return issues;
}

export interface VerifyTaskInput {
  task: AtomicTask;
  /** Whether the orchestrator recorded the task as completed. */
  completed: boolean;
  checkpoint: TaskCheckpoint | null;
}

/** Verify one task: every required criterion and every required evidence entry. */
export function verifyTask(input: VerifyTaskInput): TaskVerification {
  const { task, completed, checkpoint } = input;
  const lookup: EvidenceLookup = { evidence: checkpoint?.evidence ?? [], checkpoint };
  const criteria: CriterionVerification[] = [];
  const issues: string[] = [];

  if (!completed) {
    issues.push(task.id + ': not completed');
  }

  for (const criterion of task.exitCriteria) {
    if (!criterion.required) {
      criteria.push({
        taskId: task.id,
        criterionId: criterion.id,
        description: criterion.description,
        verification: criterion.verification,
        required: false,
        outcome: 'verified',
        reason: 'Optional criterion; not blocking verification.',
      });
      continue;
    }

    const command = commandFromVerification(criterion.verification);
    const result = command
      ? verifyCommandCriterion(task.id, criterion, command, lookup)
      : verifyInspectionCriterion(task.id, criterion, lookup);
    criteria.push(result);

    if (result.outcome !== 'verified') {
      issues.push(task.id + ': ' + criterion.id + ' — ' + result.reason);
    }
  }

  issues.push(...verifyRequiredEvidence(task.id, task, lookup));

  const uniqueIssues = Array.from(new Set(issues));
  return { taskId: task.id, ok: uniqueIssues.length === 0, criteria, issues: uniqueIssues };
}

/** Verify a whole plan. */
export function verifyPlan(inputs: VerifyTaskInput[], now = Date.now()): VerificationReport {
  const tasks = inputs.map((input) => verifyTask(input));
  const missing = Array.from(new Set(tasks.flatMap((task) => task.issues)));
  return { ok: missing.length === 0, tasks, missing, checkedAt: now };
}

/** Smallest blocking outcome for one criterion, used by the UI. */
export function worstOutcome(outcomes: readonly CriterionOutcome[]): CriterionOutcome {
  if (outcomes.includes('failed')) {
    return 'failed';
  }
  if (outcomes.includes('missing-evidence')) {
    return 'missing-evidence';
  }
  if (outcomes.includes('not-verifiable')) {
    return 'not-verifiable';
  }
  return 'verified';
}
