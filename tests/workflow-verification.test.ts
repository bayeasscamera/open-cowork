import { describe, it, expect } from 'vitest';
import {
  MIN_INSPECTION_CHARS,
  commandFromVerification,
  hasInspectionContent,
  inspectionFromVerification,
  isCommandVerification,
  normalizeCommand,
  verifyContractCriteria,
  verifyPlan,
  verifyTask,
  worstOutcome,
} from '../src/main/agent/verification';
import type { AtomicTask, EvidenceKind, TaskContract } from '../src/shared/task-contract';
import { createAtomicTask, createTaskContract } from '../src/shared/task-contract';
import type {
  CheckpointEvidence,
  NewCheckpointEvidence,
  TaskCheckpoint,
} from '../src/shared/workflow-types';

const criterion = (id: string, verification: string, required = true) => ({
  id,
  description: 'criterion ' + id,
  verification,
  required,
});

function makeContract(): TaskContract {
  return createTaskContract({
    objective: 'Ship it',
    allowedFiles: ['src/a.ts'],
    acceptanceCriteria: [criterion('c1', 'npm test')],
    expectedEvidence: [
      { kind: 'test' as EvidenceKind, description: 'tests', command: 'npm test', required: true },
    ],
    budget: { maxTokens: 100 },
  });
}

function makeTask(
  exitCriteria = [criterion('c1', 'npm test')],
  requiredEvidence: TaskContract['expectedEvidence'] = [
    { kind: 'test' as EvidenceKind, description: 'tests', command: 'npm test', required: true },
  ]
): AtomicTask {
  return createAtomicTask({
    id: 't1',
    title: 'Implement',
    writeScope: ['src/a.ts'],
    exitCriteria,
    requiredEvidence,
    budget: { maxTokens: 100 },
    requestedCapabilities: ['read', 'write'],
  });
}

function withIds(entries: NewCheckpointEvidence[]): CheckpointEvidence[] {
  return entries.map((entry, index) => ({ ...entry, id: 'evidence-' + index, recordedAt: 1 }));
}

function checkpoint(entries: NewCheckpointEvidence[], diff = ''): TaskCheckpoint {
  return {
    id: 'checkpoint-1',
    taskId: 't1',
    title: 'Implement',
    createdAt: 1,
    status: 'pending',
    files: [],
    baseRevision: null,
    diff,
    additions: 0,
    deletions: 0,
    evidence: withIds(entries),
  };
}

describe('verification helpers', () => {
  it('recognizes the inspection prefix', () => {
    expect(isCommandVerification('npm test')).toBe(true);
    expect(isCommandVerification('inspection:review diff')).toBe(false);
    expect(inspectionFromVerification('inspection:review diff')).toBe('review diff');
    expect(inspectionFromVerification('npm test')).toBeNull();
    expect(commandFromVerification('inspection:review')).toBeNull();
    expect(commandFromVerification('  npm   test  ')).toBe('npm test');
  });

  it('normalizes whitespace so equivalent commands match', () => {
    expect(normalizeCommand('  npm   run   test ')).toBe('npm run test');
    expect(normalizeCommand('')).toBe('');
  });

  it('ranks outcomes from worst to best', () => {
    expect(worstOutcome(['verified'])).toBe('verified');
    expect(worstOutcome(['verified', 'failed'])).toBe('failed');
    expect(worstOutcome(['verified', 'missing-evidence'])).toBe('missing-evidence');
    expect(worstOutcome(['not-verifiable', 'missing-evidence'])).toBe('missing-evidence');
    expect(worstOutcome([])).toBe('verified');
  });
});

describe('verifyTask', () => {
  it('verifies a required command criterion only when the proof exited 0', () => {
    const result = verifyTask({
      task: makeTask(),
      completed: true,
      checkpoint: checkpoint([
        { kind: 'test', description: 'npm test', command: 'npm test', exitCode: 0, output: 'ok' },
      ]),
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.criteria[0].outcome).toBe('verified');
    expect(result.criteria[0].evidenceId).toBe('evidence-0');
  });

  it('fails a required criterion when the proof command exited non-zero', () => {
    const result = verifyTask({
      task: makeTask(),
      completed: true,
      checkpoint: checkpoint([
        { kind: 'test', description: 'npm test', command: 'npm test', exitCode: 1, output: 'boom' },
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.criteria[0].outcome).toBe('failed');
    expect(result.issues.join(' ')).toContain('exited 1');
  });

  it('treats a present but unproven command as missing evidence, not success', () => {
    const result = verifyTask({
      task: makeTask(),
      completed: true,
      checkpoint: checkpoint([
        { kind: 'test', description: 'npm test', command: 'npm test', output: 'looks fine' },
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.criteria[0].outcome).toBe('missing-evidence');
    expect(result.criteria[0].reason).toContain('exit code');
  });

  it('ignores evidence for an unrelated command', () => {
    const result = verifyTask({
      task: makeTask(),
      completed: true,
      checkpoint: checkpoint([
        { kind: 'test', description: 'other', command: 'npm run lint', exitCode: 0, output: 'ok' },
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.criteria[0].outcome).toBe('missing-evidence');
  });

  it('accepts a verified inspection when the checkpoint carries a diff', () => {
    const result = verifyTask({
      task: makeTask([criterion('c1', 'inspection:diff')], [
        { kind: 'diff' as EvidenceKind, description: 'worktree diff', required: true },
      ]),
      completed: true,
      checkpoint: checkpoint(
        [{ kind: 'diff', description: 'worktree diff', diff: 'diff --git a/x b/x\n+added' }],
        'diff --git a/src/a.ts b/src/a.ts'
      ),
    });

    expect(result.ok).toBe(true);
    expect(result.criteria[0].outcome).toBe('verified');
  });

  it('accepts a diff carried by the evidence of an ephemeral worktree', () => {
    const result = verifyTask({
      task: makeTask([criterion('c1', 'inspection:diff')], []),
      completed: true,
      checkpoint: checkpoint([
        { kind: 'diff', description: 'worktree diff', diff: 'diff --git a/x b/x\n+added' },
      ]),
    });

    expect(result.ok).toBe(true);
    expect(result.criteria[0].outcome).toBe('verified');
  });

  it('rejects a diff inspection when the evidence carries nothing', () => {
    const result = verifyTask({
      task: makeTask([criterion('c1', 'inspection:diff')], []),
      completed: true,
      checkpoint: checkpoint([], 'diff --git a/src/a.ts b/src/a.ts'),
    });

    expect(result.ok).toBe(false);
    expect(result.criteria[0].outcome).toBe('missing-evidence');
    expect(result.criteria[0].reason).toContain('No inspection evidence');
  });

  it('rejects an inspection backed only by a title', () => {
    const result = verifyTask({
      task: makeTask([criterion('c1', 'inspection:review')], []),
      completed: true,
      checkpoint: checkpoint([{ kind: 'review', description: 'review done' }]),
    });

    expect(result.ok).toBe(false);
    expect(result.criteria[0].outcome).toBe('missing-evidence');
    expect(result.criteria[0].reason).toContain(String(MIN_INSPECTION_CHARS));
  });

  it('accepts an inspection backed by real prose', () => {
    const result = verifyTask({
      task: makeTask([criterion('c1', 'inspection:review')], []),
      completed: true,
      checkpoint: checkpoint([
        {
          kind: 'review',
          description: 'review',
          output: 'The handler validates the URL before opening it externally.',
        },
      ]),
    });

    expect(result.ok).toBe(true);
    expect(result.criteria[0].outcome).toBe('verified');
  });

  it('reports a missing checkpoint as missing evidence', () => {
    const result = verifyTask({ task: makeTask(), completed: true, checkpoint: null });

    expect(result.ok).toBe(false);
    expect(result.criteria[0].outcome).toBe('missing-evidence');
  });

  it('reports an incomplete task as an issue even when the proof exists', () => {
    const result = verifyTask({
      task: makeTask(),
      completed: false,
      checkpoint: checkpoint([
        { kind: 'test', description: 'npm test', command: 'npm test', exitCode: 0, output: 'ok' },
      ]),
    });

    expect(result.ok).toBe(false);
    expect(result.criteria[0].outcome).toBe('verified');
    expect(result.issues).toContain('t1: not completed');
  });

  it('does not block on an optional criterion', () => {
    const result = verifyTask({
      task: makeTask([criterion('c1', 'inspection:manual', false)], []),
      completed: true,
      checkpoint: checkpoint([]),
    });

    expect(result.ok).toBe(true);
    expect(result.criteria[0].outcome).toBe('verified');
    expect(result.criteria[0].required).toBe(false);
  });

  it('accepts any command criterion that really exited 0', () => {
    const result = verifyTask({
      task: makeTask([criterion('c1', 'git status --porcelain')], []),
      completed: true,
      checkpoint: checkpoint([
        {
          kind: 'test',
          description: 'git status',
          command: 'git status --porcelain',
          exitCode: 0,
          output: '',
        },
      ]),
    });

    expect(result.ok).toBe(true);
    expect(result.criteria[0].outcome).toBe('verified');
  });

  it('ignores a declared diff evidence requirement (the checkpoint provides it)', () => {
    const result = verifyTask({
      task: makeTask([criterion('c1', 'npm test')], [
        { kind: 'diff' as EvidenceKind, description: 'diff', required: true },
      ]),
      completed: true,
      checkpoint: checkpoint([
        { kind: 'test', description: 'npm test', command: 'npm test', exitCode: 0, output: 'ok' },
      ]),
    });

    expect(result.ok).toBe(true);
  });
});

describe('verifyPlan', () => {
  it('aggregates every task into one report', () => {
    const task = makeTask();
    const report = verifyPlan(
      [
        {
          task,
          completed: true,
          checkpoint: checkpoint([
            { kind: 'test', description: 'npm test', command: 'npm test', exitCode: 0, output: 'ok' },
          ]),
        },
        { task: { ...task, id: 't2' }, completed: false, checkpoint: null },
      ],
      1234
    );

    expect(report.ok).toBe(false);
    expect(report.checkedAt).toBe(1234);
    expect(report.tasks).toHaveLength(2);
    expect(report.missing).toContain('t2: not completed');
    expect(report.tasks[0].ok).toBe(true);
    expect(report.tasks[1].ok).toBe(false);
  });

  it('is ok when there is nothing to verify', () => {
    expect(verifyPlan([], 1).ok).toBe(true);
  });
});

describe('verifyContractCriteria', () => {
  const passing = {
    kind: 'test' as EvidenceKind,
    description: 'npm test',
    command: 'npm test',
    exitCode: 0,
    output: 'ok',
  };

  it('is empty without a contract or without criteria', () => {
    expect(verifyContractCriteria(null, [])).toEqual({ criteria: [], missing: [] });
    expect(verifyContractCriteria(createTaskContract({ objective: 'x' }), []).criteria).toEqual(
      []
    );
  });

  it('verifies a contract criterion proven by any task', () => {
    const result = verifyContractCriteria(makeContract(), [
      { task: makeTask(), completed: true, checkpoint: checkpoint([passing]) },
    ]);
    expect(result.missing).toEqual([]);
    expect(result.criteria).toEqual([
      expect.objectContaining({ taskId: 'contract', criterionId: 'c1', outcome: 'verified' }),
    ]);
  });

  it('reports a contract criterion no task ever proved', () => {
    const contract = createTaskContract({
      objective: 'Ship it',
      allowedFiles: ['src/a.ts'],
      acceptanceCriteria: [criterion('lint', 'npm run lint')],
      budget: { maxTokens: 100 },
    });

    const result = verifyContractCriteria(contract, [
      { task: makeTask(), completed: true, checkpoint: checkpoint([passing]) },
    ]);

    expect(result.missing).toEqual([
      'contract: lint — No evidence shows that "npm run lint" was run.',
    ]);
  });

  it('does not block on an optional contract criterion', () => {
    const contract = createTaskContract({
      objective: 'Ship it',
      allowedFiles: ['src/a.ts'],
      acceptanceCriteria: [criterion('lint', 'npm run lint', false)],
      budget: { maxTokens: 100 },
    });

    const result = verifyContractCriteria(contract, []);
    expect(result.missing).toEqual([]);
    expect(result.criteria[0].outcome).toBe('verified');
  });
});

describe('hasInspectionContent', () => {
  it('accepts a diff attached to the evidence itself', () => {
    expect(
      hasInspectionContent(
        {
          id: 'e1',
          kind: 'diff',
          description: 'diff',
          diff: 'diff --git a/x b/x',
          recordedAt: 1,
        },
        null
      )
    ).toBe(true);
  });

  it('rejects content below the minimum length', () => {
    expect(
      hasInspectionContent(
        { id: 'e1', kind: 'note', description: 'note', output: 'short', recordedAt: 1 },
        null
      )
    ).toBe(false);
  });
});
