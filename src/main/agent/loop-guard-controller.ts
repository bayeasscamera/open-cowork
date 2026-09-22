/**
 * @module main/agent/loop-guard-controller
 *
 * Owns the per-turn runaway tool-call loop guard: it creates the LoopGuard
 * detector and the decision handler that reacts to a warn / halt / abort
 * verdict — surfacing the abort explanation, stopping the turn, or steering the
 * model back on track.
 *
 * Extracted from CoworkAgentRunner.run() so the policy and its exact log strings
 * are unit-testable without a runner instance. The effects that touch runner
 * state (message and trace emission, abort flag) are injected as callbacks.
 */
import type { AgentSession as PiAgentSession } from '@mariozechner/pi-coding-agent';
import { getPiSessionSteering } from './pi-agent-access';
import {
  LoopGuard,
  buildHaltSteerMessage,
  buildWarnSteerMessage,
  type LoopGuardDecision,
} from './agent-runner-loop-guard';
import { logWarn } from '../utils/logger';

export interface LoopGuardControllerDeps {
  piSession: PiAgentSession;
  /** True once the turn has been cancelled or aborted. */
  isAborted: () => boolean;
  /**
   * Publishes the abort explanation to the user and suppresses the generic
   * error that later paths would otherwise emit for the same turn.
   */
  emitAbort: (decision: LoopGuardDecision) => void;
  /** Marks the turn as aborted by the loop guard (before aborting it). */
  markAbortedByLoopGuard: () => void;
  /** Aborts the in-flight turn. */
  abort: () => void;
}

export interface LoopGuardController {
  loopGuard: LoopGuard;
  handleDecision: (decision: LoopGuardDecision, context: string) => void;
}

export function createLoopGuardController(deps: LoopGuardControllerDeps): LoopGuardController {
  // Two layers: hash of whole tool-call group (window=20, warn=3/halt=5/abort=8)
  //             + per-tool frequency (warn=30/halt=50/abort=80).
  const loopGuard = new LoopGuard();

  const handleDecision = (decision: LoopGuardDecision, context: string): void => {
    if (decision.action === 'none' || deps.isAborted()) return;
    logWarn(`[LoopGuard] ${context}: action=${decision.action} reason=${decision.reason}`);

    if (decision.action === 'hash_abort' || decision.action === 'freq_abort') {
      // Always surface the loop-guard explanation, even if an earlier error
      // already set hasEmittedError — the user must see why the session stopped.
      deps.emitAbort(decision);
      try {
        // Mark BEFORE calling abort() so the AbortError handler in the outer
        // catch can distinguish a loop-guard abort from a user cancel and skip
        // the "Cancelled" trace overwrite.
        deps.markAbortedByLoopGuard();
        deps.abort();
      } catch (abortErr) {
        logWarn('[LoopGuard] abort error:', abortErr);
      }
      return;
    }

    const steerText =
      decision.action === 'hash_halt' || decision.action === 'freq_halt'
        ? buildHaltSteerMessage(decision)
        : buildWarnSteerMessage(decision);
    // fire-and-forget: SDK queues the steering message for the next turn
    try {
      const sessionSteering = getPiSessionSteering(deps.piSession);
      if (typeof sessionSteering.sendUserMessage === 'function') {
        Promise.resolve(sessionSteering.sendUserMessage(steerText, { deliverAs: 'steer' })).catch(
          (err: unknown) => {
            logWarn('[LoopGuard] sendUserMessage(steer) failed:', err);
          }
        );
      } else {
        logWarn('[LoopGuard] piSession.sendUserMessage is not available; skipping steer');
      }
    } catch (steerErr) {
      logWarn('[LoopGuard] sendUserMessage(steer) threw:', steerErr);
    }
  };

  return { loopGuard, handleDecision };
}
