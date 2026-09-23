import { describe, it, expect } from 'vitest';
import {
  buildApprovalRequest,
  describeApprovalRequest,
  evaluateApproval,
} from '../src/main/agent/approval-gate';
import { createDefaultPermissionPolicy } from '../src/main/agent/permission-policy';
import { createAtomicTask, createTaskContract } from '../src/shared/task-contract';

const criterion = (id: string, verification = 'npm test') => ({
  id,
  description: 'criterion ' + id,
  verification,
  required: true,
});

const evidence = { kind: 'test' as const, description: 'tests', command: 'npm test', required: true };

function buildContract(overrides: Record<string, unknown> = {}) {
  return createTaskContract({
    objective: 'Ship the feature',
    allowedFiles: ['src/**'],
    acceptanceCriteria: [criterion('c1')],
    expectedEvidence: [evidence],
    budget: { maxTokens: 100, estimatedCostUsd: 0.05 },
    ...overrides,
  });
}

function buildTask(overrides: Record<string, unknown> = {}) {
  return createAtomicTask({
    id: 't1',
    title: 'Implement',
    writeScope: ['src/a.ts'],
    exitCriteria: [criterion('c1')],
    requiredEvidence: [evidence],
    budget: { maxTokens: 100 },
    requestedCapabilities: ['read', 'write'],
    ...overrides,
  });
}

describe('approval-gate', () => {
  it('builds a clean approval request for a valid plan', () => {
    const request = buildApprovalRequest(buildContract(), [buildTask()], createDefaultPermissionPolicy('/ws'));

    expect(request.blockers).toEqual([]);
    expect(request.fileScope).toEqual(['src/a.ts']);
    expect(request.plannedCommands).toEqual(['npm test']);
    expect(request.requiresConfirmation).toContain('write');
    expect(request.estimatedCostUsd).toBeCloseTo(0.05);
    expect(request.riskLevel).toBe('low');
  });

  it('blocks when the contract has no verifiable criterion', () => {
    const contract = buildContract({
      acceptanceCriteria: [{ id: 'c1', description: 'looks fine', verification: '', required: true }],
    });
    const request = buildApprovalRequest(contract, [buildTask()], createDefaultPermissionPolicy('/ws'));
    expect(request.blockers.length).toBeGreaterThan(0);
  });

  it('blocks when a task writes outside the contract scope', () => {
    const request = buildApprovalRequest(
      buildContract({ allowedFiles: ['src/renderer/**'] }),
      [buildTask()],
      createDefaultPermissionPolicy('/ws')
    );
    expect(request.blockers.some((blocker) => blocker.includes('outside the contract scope'))).toBe(true);
  });

  it('blocks when a requested capability is forbidden by policy', () => {
    const policy = createDefaultPermissionPolicy('/ws');
    policy.rules = [{ id: 'write.forbidden', capability: 'write', decision: 'forbidden' }];
    const request = buildApprovalRequest(buildContract(), [buildTask()], policy);
    expect(request.blockers.some((blocker) => blocker.includes('forbidden'))).toBe(true);
  });

  it('refuses approval when blockers remain', () => {
    const request = buildApprovalRequest(
      buildContract({ objective: '' }),
      [buildTask()],
      createDefaultPermissionPolicy('/ws')
    );
    const outcome = evaluateApproval(request, { approved: true });
    expect(outcome.approved).toBe(false);
    expect(outcome.reasons[0]).toContain('Execution blocked');
  });

  it('approves a clean request and records rejection reasons', () => {
    const request = buildApprovalRequest(buildContract(), [buildTask()], createDefaultPermissionPolicy('/ws'));
    expect(evaluateApproval(request, { approved: true }).approved).toBe(true);
    const rejected = evaluateApproval(request, { approved: false, reason: 'too risky' });
    expect(rejected.approved).toBe(false);
    expect(rejected.reasons).toEqual(['too risky']);
  });

  it('describes the request for the audit log', () => {
    const request = buildApprovalRequest(buildContract(), [buildTask()], createDefaultPermissionPolicy('/ws'));
    const description = describeApprovalRequest(request);
    expect(description).toContain('1 task(s)');
    expect(description).toContain('risk low');
    expect(description).toContain('1 file(s)');
  });
});
