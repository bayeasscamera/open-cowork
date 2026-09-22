import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: vi.fn(),
  createReadTool: vi.fn(() => ({})),
  createWriteTool: vi.fn(() => ({})),
  createEditTool: vi.fn(() => ({})),
  createFindTool: vi.fn(() => ({})),
  createGrepTool: vi.fn(() => ({})),
  createLsTool: vi.fn(() => ({})),
  DefaultResourceLoader: vi.fn(function (this: unknown) {
    return { reload: vi.fn() };
  }),
  SessionManager: { inMemory: vi.fn() },
  SettingsManager: { inMemory: vi.fn() },
  AuthStorage: { create: vi.fn(() => ({ setRuntimeApiKey: vi.fn() })) },
  ModelRegistry: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({ getModel: vi.fn() }));

vi.mock('../src/main/config/config-store', () => ({
  configStore: { getAll: vi.fn() },
  normalizeSubAgentsConfig: vi.fn(() => ({
    configSetId: '',
    perRole: {},
    timeoutMs: 120_000,
    maxConcurrent: 2,
  })),
}));

vi.mock('../src/main/utils/logger', () => ({
  log: mocks.log,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

vi.mock('../src/main/events/renderer-sender', () => ({ sendToRenderer: vi.fn() }));

let testRoot = '';
vi.mock('electron', () => ({
  app: { getPath: () => testRoot, getVersion: () => '0.0.0-test', isPackaged: false },
}));

import {
  startDelegation,
  takePendingDelegationResults,
  awaitResearchCrossVerification,
  getResearchCrossCheck,
  listDelegations,
  subAgentGate,
  initBackgroundDelegations,
  __resetDelegationsForTest,
} from '../src/main/agent/background-delegations';
import type { SubAgentSessionArgs, SubAgentSessionResult } from '../src/main/agent/swarm-runner';

const dirs: string[] = [];
const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cowork-research-xv-'));
  dirs.push(testRoot);
  initBackgroundDelegations(testRoot);
  __resetDelegationsForTest();
  subAgentGate.reset();
  subAgentGate.setMax(2);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const testConfig = {
  provider: 'custom',
  customProtocol: 'openai',
  apiKey: 'k',
  model: 'test-model',
  subAgents: { configSetId: '', perRole: {}, timeoutMs: 5000, maxConcurrent: 2 },
} as unknown as NonNullable<Parameters<typeof startDelegation>[0]['getConfig']> extends never
  ? never
  : ReturnType<NonNullable<Parameters<typeof startDelegation>[0]['getConfig']>>;

function reportOutput(title: string, finding: string): string {
  return [
    '## Summary',
    `${title} done`,
    '## Findings',
    finding,
    '## Assumptions',
    'none',
    '## Limits',
    'none',
    '## Modified files',
    'none',
  ].join('\n');
}

/** A launcher that answers delegations AND the cross-check task differently. */
function makeLauncher(crossCheckOutput: string) {
  const launches: SubAgentSessionArgs[] = [];
  const launchSession = vi.fn(async (args: SubAgentSessionArgs): Promise<SubAgentSessionResult> => {
    launches.push(args);
    if (args.task.id.startsWith('research-cross-check-')) {
      return { output: crossCheckOutput, modifiedFiles: [] };
    }
    const title = args.task.title;
    return {
      output: reportOutput(title, `${title} states its own figures`),
      modifiedFiles: [],
      tokenUsage: { input: 10, output: 5 },
    };
  });
  return { launchSession, launches };
}

async function flushUntil(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('condition never became true');
}

describe('research cross-verification — Zone 2 (parallel delegations)', () => {
  it('surfaces a factual contradiction explicitly instead of merging it', async () => {
    const contradiction = [
      '### CONTRADICTION',
      'TOPIC: 2026 market size',
      'SOURCE_A: Report A',
      'CLAIM_A: $4B',
      'SOURCE_B: Report B',
      'CLAIM_B: $9B',
      'PREFERRED: Report B',
      'RATIONALE: published later with primary data',
    ].join('\n');
    const { launchSession, launches } = makeLauncher(contradiction);

    startDelegation({
      sessionId: 'x1',
      cwd: testRoot,
      title: 'Report A',
      prompt: 'Research the 2026 electric vehicle market size',
      crossVerify: true,
      launchSession,
      getConfig: () => testConfig,
    });
    startDelegation({
      sessionId: 'x1',
      cwd: testRoot,
      title: 'Report B',
      prompt: 'Research the 2026 electric vehicle market size',
      crossVerify: true,
      launchSession,
      getConfig: () => testConfig,
    });

    await flushUntil(() => getResearchCrossCheck('x1')?.status === 'done');
    await awaitResearchCrossVerification('x1');

    const block = takePendingDelegationResults('x1');
    // Both original reports are still delivered verbatim…
    expect(block).toContain('Report A');
    expect(block).toContain('Report B');
    // …AND the contradiction is surfaced, never silently merged.
    expect(block).toContain('<research_cross_verification>');
    expect(block).toContain('CONTRADICTIONS');
    expect(block).toContain('Report A: $4B');
    expect(block).toContain('Report B: $9B');
    expect(block).toContain('preferred (most recent/authoritative): Report B');

    // Cost: exactly ONE extra model call, on a dedicated cross-check task.
    const crossCalls = launches.filter((l) => l.task.id.startsWith('research-cross-check-'));
    expect(crossCalls).toHaveLength(1);
    expect(getResearchCrossCheck('x1')?.result?.modelCalls).toBe(1);

    // Delivered once — no duplicate cross-verification block on the next turn.
    expect(takePendingDelegationResults('x1')).toBe('');
  });

  it('adds NO model call when crossVerification is off (default)', async () => {
    const { launchSession, launches } = makeLauncher('NONE');
    startDelegation({
      sessionId: 'x2',
      cwd: testRoot,
      title: 'A',
      prompt: 'p',
      launchSession,
      getConfig: () => testConfig,
    });
    startDelegation({
      sessionId: 'x2',
      cwd: testRoot,
      title: 'B',
      prompt: 'p',
      launchSession,
      getConfig: () => testConfig,
    });
    await flush();
    await flush();

    expect(listDelegations('x2').every((d) => d.status === 'completed')).toBe(true);
    expect(launches.filter((l) => l.task.id.startsWith('research-cross-check-'))).toHaveLength(0);
    expect(getResearchCrossCheck('x2')).toBeUndefined();
    // Reports still delivered, just without a cross-check block.
    const block = takePendingDelegationResults('x2');
    expect(block).toContain('A');
    expect(block).not.toContain('research_cross_verification');
  });

  it('does not cross-check a single flagged report (needs at least two sources)', async () => {
    const { launchSession, launches } = makeLauncher('NONE');
    startDelegation({
      sessionId: 'x3',
      cwd: testRoot,
      title: 'Only one',
      prompt: 'p',
      crossVerify: true,
      launchSession,
      getConfig: () => testConfig,
    });
    await flush();
    await flush();
    expect(launches.filter((l) => l.task.id.startsWith('research-cross-check-'))).toHaveLength(0);
    expect(getResearchCrossCheck('x3')).toBeUndefined();
  });

  it('reports no contradiction block when the cross-check answers NONE', async () => {
    const { launchSession } = makeLauncher('NONE');
    startDelegation({
      sessionId: 'x4',
      cwd: testRoot,
      title: 'A',
      prompt: 'Research the electric vehicle market size',
      crossVerify: true,
      launchSession,
      getConfig: () => testConfig,
    });
    startDelegation({
      sessionId: 'x4',
      cwd: testRoot,
      title: 'B',
      prompt: 'Research the electric vehicle market share',
      crossVerify: true,
      launchSession,
      getConfig: () => testConfig,
    });
    await flushUntil(() => getResearchCrossCheck('x4')?.status === 'done');
    const block = takePendingDelegationResults('x4');
    expect(block).toContain('A');
    expect(block).not.toContain('<research_cross_verification>');
  });

  it('does NOT cross-check flagged reports on clearly different subjects', async () => {
    const { launchSession, launches } = makeLauncher('NONE');
    startDelegation({
      sessionId: 'x6',
      cwd: testRoot,
      title: 'Kubernetes costs',
      prompt: 'Research Kubernetes cluster cost optimization',
      crossVerify: true,
      launchSession,
      getConfig: () => testConfig,
    });
    startDelegation({
      sessionId: 'x6',
      cwd: testRoot,
      title: 'Chip market',
      prompt: 'Research the 2026 semiconductor market size',
      crossVerify: true,
      launchSession,
      getConfig: () => testConfig,
    });
    await flush();
    await flush();
    await flush();

    // Both flagged, but no shared subject → no wasteful verification call.
    expect(launches.filter((l) => l.task.id.startsWith('research-cross-check-'))).toHaveLength(0);
    expect(getResearchCrossCheck('x6')).toBeUndefined();
    const block = takePendingDelegationResults('x6');
    expect(block).toContain('Kubernetes costs');
    expect(block).toContain('Chip market');
  });

  it('a failed cross-check never loses the reports nor throws', async () => {
    const launchSession = vi.fn(async (args: SubAgentSessionArgs): Promise<SubAgentSessionResult> => {
      if (args.task.id.startsWith('research-cross-check-')) {
        throw new Error('verification provider down');
      }
      return { output: reportOutput(args.task.title, 'own figures'), modifiedFiles: [] };
    });
    startDelegation({
      sessionId: 'x5',
      cwd: testRoot,
      title: 'A',
      prompt: 'Research the electric vehicle market size',
      crossVerify: true,
      launchSession,
      getConfig: () => testConfig,
    });
    startDelegation({
      sessionId: 'x5',
      cwd: testRoot,
      title: 'B',
      prompt: 'Research the electric vehicle market share',
      crossVerify: true,
      launchSession,
      getConfig: () => testConfig,
    });
    await flushUntil(() => getResearchCrossCheck('x5')?.status === 'failed');
    const block = takePendingDelegationResults('x5');
    expect(block).toContain('A');
    expect(block).toContain('B');
  });
});
