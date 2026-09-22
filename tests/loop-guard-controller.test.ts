/**
 * Tests for the loop-guard controller extracted from run().
 *
 * The logger, the steering accessor and the two steer-message builders are
 * mocked so the decision policy, the abort sequencing and the exact log
 * strings are pinned; the real LoopGuard class is kept.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
  getPiSessionSteering: vi.fn(),
  buildHaltSteerMessage: vi.fn(() => 'HALT'),
  buildWarnSteerMessage: vi.fn(() => 'WARN'),
}));

vi.mock('../src/main/utils/logger', () => ({ logWarn: mocks.logWarn }));
vi.mock('../src/main/agent/pi-agent-access', () => ({
  getPiSessionSteering: mocks.getPiSessionSteering,
}));
vi.mock('../src/main/agent/agent-runner-loop-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/agent/agent-runner-loop-guard')>();
  return {
    ...actual,
    buildHaltSteerMessage: mocks.buildHaltSteerMessage,
    buildWarnSteerMessage: mocks.buildWarnSteerMessage,
  };
});

import {
  createLoopGuardController,
  type LoopGuardControllerDeps,
} from '../src/main/agent/loop-guard-controller';
import { LoopGuard, type LoopGuardDecision } from '../src/main/agent/agent-runner-loop-guard';

function makeDeps(over: Partial<LoopGuardControllerDeps> = {}) {
  const sendUserMessage = vi.fn(async () => undefined);
  mocks.getPiSessionSteering.mockReturnValue({ sendUserMessage });
  const deps: LoopGuardControllerDeps = {
    piSession: { id: 'pi' } as never,
    isAborted: vi.fn(() => false),
    emitAbort: vi.fn(),
    markAbortedByLoopGuard: vi.fn(),
    abort: vi.fn(),
    ...over,
  };
  return { deps, sendUserMessage };
}

const decision = (action: LoopGuardDecision['action']): LoopGuardDecision => ({
  action,
  reason: 'r',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildHaltSteerMessage.mockReturnValue('HALT');
  mocks.buildWarnSteerMessage.mockReturnValue('WARN');
});

describe('createLoopGuardController', () => {
  it('exposes a LoopGuard detector', () => {
    const { deps } = makeDeps();

    expect(createLoopGuardController(deps).loopGuard).toBeInstanceOf(LoopGuard);
  });

  it('ignores a none decision', () => {
    const { deps, sendUserMessage } = makeDeps();

    createLoopGuardController(deps).handleDecision(decision('none'), 'ctx');

    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(deps.emitAbort).not.toHaveBeenCalled();
    expect(deps.abort).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('ignores every decision once the turn is aborted', () => {
    const { deps, sendUserMessage } = makeDeps({ isAborted: vi.fn(() => true) });

    createLoopGuardController(deps).handleDecision(decision('hash_abort'), 'ctx');

    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(deps.emitAbort).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('logs the verdict and steers with the warn message', () => {
    const { deps, sendUserMessage } = makeDeps();

    createLoopGuardController(deps).handleDecision(decision('hash_warn'), 'ctx');

    expect(mocks.logWarn).toHaveBeenCalledWith('[LoopGuard] ctx: action=hash_warn reason=r');
    expect(mocks.getPiSessionSteering).toHaveBeenCalledWith(deps.piSession);
    expect(mocks.buildWarnSteerMessage).toHaveBeenCalledWith(decision('hash_warn'));
    expect(sendUserMessage).toHaveBeenCalledWith('WARN', { deliverAs: 'steer' });
  });

  it('steers with the halt message for a halt verdict', () => {
    const { deps, sendUserMessage } = makeDeps();

    createLoopGuardController(deps).handleDecision(decision('freq_halt'), 'ctx');

    expect(mocks.buildHaltSteerMessage).toHaveBeenCalledWith(decision('freq_halt'));
    expect(sendUserMessage).toHaveBeenCalledWith('HALT', { deliverAs: 'steer' });
  });

  it('emits the abort, marks it, then aborts — in that order', () => {
    const order: string[] = [];
    const { deps, sendUserMessage } = makeDeps({
      emitAbort: vi.fn(() => order.push('emit')),
      markAbortedByLoopGuard: vi.fn(() => order.push('mark')),
      abort: vi.fn(() => order.push('abort')),
    });

    createLoopGuardController(deps).handleDecision(decision('hash_abort'), 'ctx');

    expect(order).toEqual(['emit', 'mark', 'abort']);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('catches an abort() failure and logs it', () => {
    const boom = new Error('boom');
    const { deps } = makeDeps({
      abort: vi.fn(() => {
        throw boom;
      }),
    });

    createLoopGuardController(deps).handleDecision(decision('freq_abort'), 'ctx');

    expect(deps.emitAbort).toHaveBeenCalledTimes(1);
    expect(deps.markAbortedByLoopGuard).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith('[LoopGuard] abort error:', boom);
  });

  it('logs when the session exposes no steering', () => {
    const { deps } = makeDeps();
    mocks.getPiSessionSteering.mockReturnValue({});

    createLoopGuardController(deps).handleDecision(decision('hash_warn'), 'ctx');

    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[LoopGuard] piSession.sendUserMessage is not available; skipping steer'
    );
  });

  it('logs a rejected steer message', async () => {
    const boom = new Error('steer failed');
    const { deps, sendUserMessage } = makeDeps();
    sendUserMessage.mockRejectedValue(boom);

    createLoopGuardController(deps).handleDecision(decision('hash_warn'), 'ctx');
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.logWarn).toHaveBeenCalledWith('[LoopGuard] sendUserMessage(steer) failed:', boom);
  });

  it('logs when reading the steering accessor throws', () => {
    const boom = new Error('no internals');
    const { deps } = makeDeps();
    mocks.getPiSessionSteering.mockImplementation(() => {
      throw boom;
    });

    createLoopGuardController(deps).handleDecision(decision('hash_warn'), 'ctx');

    expect(mocks.logWarn).toHaveBeenCalledWith('[LoopGuard] sendUserMessage(steer) threw:', boom);
  });
});
