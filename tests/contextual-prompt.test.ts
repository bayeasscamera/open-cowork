/**
 * Tests for the contextual prompt assembly extracted from run().
 *
 * Cold-start history, background-delegation blocks, the OpenJev router and the
 * logger are all mocked so every branch and the exact prompt composition can be
 * pinned without Electron, the agent SDK or a live System One endpoint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  logCtx: vi.fn(),
  buildColdStartHistoryPreamble: vi.fn(),
  takePendingDelegationResults: vi.fn(),
  describeRunningDelegations: vi.fn(),
  evaluateRoutingSignal: vi.fn(),
  formatRoutingHint: vi.fn(),
}));

vi.mock('../src/main/utils/logger', () => ({ log: mocks.log, logCtx: mocks.logCtx }));
vi.mock('../src/main/agent/cold-start-history', () => ({
  buildColdStartHistoryPreamble: mocks.buildColdStartHistoryPreamble,
}));
vi.mock('../src/main/agent/background-delegations', () => ({
  takePendingDelegationResults: mocks.takePendingDelegationResults,
  describeRunningDelegations: mocks.describeRunningDelegations,
}));
vi.mock('../src/main/agent/openjev-router', () => ({
  evaluateRoutingSignal: mocks.evaluateRoutingSignal,
  formatRoutingHint: mocks.formatRoutingHint,
}));

import {
  assembleContextualPrompt,
  type AssembleContextualPromptDeps,
} from '../src/main/agent/contextual-prompt';
import type { Message } from '../src/shared/types';

const PREAMBLE = 'SUMMARY\n\nhello';

function makeDeps(over: Partial<AssembleContextualPromptDeps> = {}): AssembleContextualPromptDeps {
  return {
    prompt: 'hello',
    existingMessages: [] as Message[],
    contextWindow: 128000,
    provider: 'anthropic',
    sessionId: 'session-1',
    isColdStart: true,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildColdStartHistoryPreamble.mockReturnValue(null);
  mocks.takePendingDelegationResults.mockReturnValue('');
  mocks.describeRunningDelegations.mockReturnValue('');
  mocks.formatRoutingHint.mockReturnValue('');
});

describe('assembleContextualPrompt', () => {
  it('returns the raw prompt when a cold start has no history preamble', async () => {
    const result = await assembleContextualPrompt(makeDeps());

    expect(result).toBe('hello');
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.logCtx).not.toHaveBeenCalled();
    expect(mocks.buildColdStartHistoryPreamble).toHaveBeenCalledWith({
      prompt: 'hello',
      messages: [],
      contextWindow: 128000,
      provider: 'anthropic',
    });
  });

  it('injects the cold-start preamble and logs the exact budget summary', async () => {
    mocks.buildColdStartHistoryPreamble.mockReturnValue({
      prompt: PREAMBLE,
      injectedCount: 3,
      totalCount: 7,
      charBudget: 1000,
      charCount: 250,
      charsPerToken: 4,
    });

    const result = await assembleContextualPrompt(makeDeps());

    expect(result).toBe(PREAMBLE);
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Cold start: injecting',
      3,
      'of',
      7,
      'history messages (budget:',
      1000,
      'chars, used:',
      250,
      ', charsPerToken:',
      '4.00',
      ')'
    );
  });

  it('logs session reuse on a warm start and leaves the prompt untouched', async () => {
    const result = await assembleContextualPrompt(makeDeps({ isColdStart: false }));

    expect(result).toBe('hello');
    expect(mocks.buildColdStartHistoryPreamble).not.toHaveBeenCalled();
    expect(mocks.logCtx).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Reusing existing SDK session for:',
      'session-1'
    );
  });

  it('prepends a trimmed extension prefix', async () => {
    const result = await assembleContextualPrompt(
      makeDeps({ isColdStart: false, extensionPromptPrefix: '  SYSTEM RULES  ' })
    );

    expect(result).toBe('SYSTEM RULES\n\nhello');
  });

  it('ignores a blank extension prefix', async () => {
    const result = await assembleContextualPrompt(
      makeDeps({ isColdStart: false, extensionPromptPrefix: '   ' })
    );

    expect(result).toBe('hello');
  });

  it('appends finished delegation results then running markers', async () => {
    mocks.takePendingDelegationResults.mockReturnValue('DONE');
    mocks.describeRunningDelegations.mockReturnValue('RUNNING');

    const result = await assembleContextualPrompt(makeDeps({ isColdStart: false }));

    expect(result).toBe('hello\n\nDONE\n\nRUNNING');
    expect(mocks.takePendingDelegationResults).toHaveBeenCalledWith('session-1');
    expect(mocks.describeRunningDelegations).toHaveBeenCalledWith('session-1');
  });

  it('skips empty delegation blocks', async () => {
    const result = await assembleContextualPrompt(makeDeps({ isColdStart: false }));

    expect(result).toBe('hello');
  });

  it('does not evaluate routing when OpenJev is absent or disabled', async () => {
    const absent = await assembleContextualPrompt(makeDeps({ isColdStart: false }));
    const disabled = await assembleContextualPrompt(
      makeDeps({ isColdStart: false, openjev: { enabled: false, baseUrl: 'http://x' } })
    );

    expect(absent).toBe('hello');
    expect(disabled).toBe('hello');
    expect(mocks.evaluateRoutingSignal).not.toHaveBeenCalled();
    expect(mocks.formatRoutingHint).not.toHaveBeenCalled();
  });

  it('appends the OpenJev hint and logs the verdict metrics', async () => {
    mocks.evaluateRoutingSignal.mockResolvedValue({
      needsSwarm: 0.8,
      complexity: 0.5,
      confidence: 0.9,
      latencyMs: 42,
    });
    mocks.formatRoutingHint.mockReturnValue('HINT');

    const result = await assembleContextualPrompt(
      makeDeps({ isColdStart: false, openjev: { enabled: true, baseUrl: 'http://x' } })
    );

    expect(result).toBe('hello\n\nHINT');
    expect(mocks.evaluateRoutingSignal).toHaveBeenCalledWith('hello', {
      enabled: true,
      baseUrl: 'http://x',
    });
    const firstArg = String(mocks.log.mock.calls[0][0]);
    expect(firstArg).toContain('[OpenJev] prompt="hello"');
    expect(firstArg).toContain('swarm=0.80 complexity=0.50');
    expect(firstArg).toContain('confidence=0.90 latency=42ms');
    expect(firstArg).toContain('hint injected');
  });

  it('logs an unreachable System One and a skipped hint when there is no verdict', async () => {
    mocks.evaluateRoutingSignal.mockResolvedValue(null);

    const result = await assembleContextualPrompt(
      makeDeps({ isColdStart: false, openjev: { enabled: true, baseUrl: 'http://x' } })
    );

    expect(result).toBe('hello');
    const firstArg = String(mocks.log.mock.calls[0][0]);
    expect(firstArg).toContain('no verdict (unreachable/timeout) after');
    expect(firstArg).toContain('hint skipped');
  });

  it('truncates the routing log excerpt to 80 characters', async () => {
    mocks.evaluateRoutingSignal.mockResolvedValue(null);
    const long = 'x'.repeat(200);

    await assembleContextualPrompt(
      makeDeps({
        prompt: long,
        isColdStart: false,
        openjev: { enabled: true, baseUrl: 'http://x' },
      })
    );

    const firstArg = String(mocks.log.mock.calls[0][0]);
    expect(firstArg).toContain('prompt="' + 'x'.repeat(80) + '"');
    expect(firstArg).not.toContain('x'.repeat(81));
  });

  it('composes prefix, delegation and routing blocks in the historical order', async () => {
    mocks.buildColdStartHistoryPreamble.mockReturnValue({
      prompt: PREAMBLE,
      injectedCount: 1,
      totalCount: 1,
      charBudget: 10,
      charCount: 5,
      charsPerToken: 2,
    });
    mocks.takePendingDelegationResults.mockReturnValue('DONE');
    mocks.describeRunningDelegations.mockReturnValue('RUNNING');
    mocks.evaluateRoutingSignal.mockResolvedValue({
      needsSwarm: 1,
      complexity: 1,
      confidence: 1,
      latencyMs: 1,
    });
    mocks.formatRoutingHint.mockReturnValue('HINT');

    const result = await assembleContextualPrompt(
      makeDeps({
        extensionPromptPrefix: 'SYS',
        openjev: { enabled: true, baseUrl: 'http://x' },
      })
    );

    expect(result).toBe('SYS\n\n' + PREAMBLE + '\n\nDONE\n\nRUNNING\n\nHINT');
  });
});
