import { describe, it, expect } from 'vitest';
import {
  createTaskContract,
  createDefaultApprovalPolicy,
  decisionForCapability,
  isContractExecutable,
  isWorkflowMode,
  maxRisk,
  validateTaskContract,
  WORKFLOW_MODE_CAPABILITIES,
  createAtomicTask,
} from '../src/shared/task-contract';

const validCriteria = [
  { id: 'c1', description: 'tests pass', verification: 'npm test', required: true },
];

const validEvidence = [
  { kind: 'test' as const, description: 'unit tests', command: 'npm test', required: true },
];

describe('task-contract', () => {
  it('creates an execute contract with mode-implied capabilities', () => {
    const contract = createTaskContract({
      objective: 'Fix the parser',
      allowedFiles: ['src/parser.ts'],
      acceptanceCriteria: validCriteria,
      expectedEvidence: validEvidence,
      budget: { maxTokens: 1000 },
    });

    expect(contract.mode).toBe('execute');
    expect(contract.requestedCapabilities).toEqual(['read', 'write', 'shell']);
    expect(contract.approvalPolicy.requireExplicitScope).toBe(true);
  });

  it('flags a missing objective and missing criteria', () => {
    const contract = createTaskContract({ objective: '   ' });
    const issues = validateTaskContract(contract);
    const codes = issues.map((issue) => issue.code);

    expect(codes).toContain('missing-objective');
    expect(codes).toContain('no-acceptance-criteria');
    expect(codes).toContain('empty-allowed-files');
  });

  it('rejects a non-verifiable acceptance criterion', () => {
    const contract = createTaskContract({
      objective: 'Do something',
      allowedFiles: ['src/a.ts'],
      acceptanceCriteria: [{ id: 'c1', description: 'looks good', verification: '', required: true }],
      expectedEvidence: validEvidence,
      budget: { maxTokens: 10 },
    });

    const issues = validateTaskContract(contract);
    expect(issues.some((issue) => issue.code === 'non-verifiable-criterion')).toBe(true);
    expect(isContractExecutable(contract).executable).toBe(false);
  });

  it('forbids the write capability in explore mode', () => {
    const contract = createTaskContract({
      objective: 'Audit only',
      mode: 'explore',
      allowedFiles: ['src/a.ts'],
      acceptanceCriteria: validCriteria,
      expectedEvidence: validEvidence,
      budget: { maxTokens: 10 },
      requestedCapabilities: ['read', 'write'],
    });

    const issues = validateTaskContract(contract);
    expect(issues.some((issue) => issue.code === 'mode-cannot-write')).toBe(true);
  });

  it('accepts a fully specified contract', () => {
    const contract = createTaskContract({
      objective: 'Fix the parser',
      allowedFiles: ['src/parser.ts'],
      acceptanceCriteria: validCriteria,
      expectedEvidence: validEvidence,
      budget: { maxTokens: 1000, maxDurationMs: 1000, maxToolCalls: 5 },
    });

    expect(isContractExecutable(contract)).toEqual({ executable: true, issues: [] });
  });

  it('resolves capability decisions from overrides then default', () => {
    const policy = createDefaultApprovalPolicy();
    expect(decisionForCapability(policy, 'read')).toBe('auto');
    expect(decisionForCapability(policy, 'outside-workspace')).toBe('forbidden');
    expect(decisionForCapability(policy, 'browser')).toBe('confirm');
  });

  it('exposes mode capabilities and guards mode parsing', () => {
    expect(WORKFLOW_MODE_CAPABILITIES.explore.write).toBe(false);
    expect(WORKFLOW_MODE_CAPABILITIES.execute.write).toBe(true);
    expect(isWorkflowMode('plan')).toBe(true);
    expect(isWorkflowMode('nope')).toBe(false);
  });

  it('orders risk levels', () => {
    expect(maxRisk('low', 'high')).toBe('high');
    expect(maxRisk('medium', 'low')).toBe('medium');
  });

  it('creates atomic tasks with safe defaults', () => {
    const task = createAtomicTask({ id: 't1', title: 'Do it' });
    expect(task.role).toBe('implementer');
    expect(task.riskLevel).toBe('low');
    expect(task.parallelizable).toBe(true);
    expect(task.dependsOn).toEqual([]);
  });
});
