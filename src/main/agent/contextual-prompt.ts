/**
 * @module main/agent/contextual-prompt
 *
 * Assembles the contextual prompt handed to a pi session for a single turn:
 * the cold-start history preamble, an extension-supplied prompt prefix, the
 * async delegation results and the optional OpenJev routing hint.
 *
 * Extracted from CoworkAgentRunner.run() so the assembly is unit-testable
 * without Electron or the agent SDK. The caller keeps ownership of the session
 * lifecycle and of the resolved model context window.
 */
import { evaluateRoutingSignal, formatRoutingHint, type OpenJevConfig } from './openjev-router';
import { takePendingDelegationResults, describeRunningDelegations } from './background-delegations';
import { buildColdStartHistoryPreamble } from './cold-start-history';
import { log, logCtx } from '../utils/logger';
import type { Message } from '../../shared/types';

export interface AssembleContextualPromptDeps {
  /** Raw user prompt for this turn. */
  prompt: string;
  /** Persisted conversation history — only consumed on a cold start. */
  existingMessages: Message[];
  /** Already-resolved context window of the active model. */
  contextWindow: number;
  /** Provider id used to size the cold-start history budget. */
  provider: string;
  /** Session id, used for delegation bookkeeping and the session-reuse log. */
  sessionId: string;
  /** True when no cached SDK session exists and history must be injected. */
  isColdStart: boolean;
  /** Optional prefix supplied by an extension beforeSessionRun hook. */
  extensionPromptPrefix?: string;
  /** Optional OpenJev routing config (off by default). */
  openjev?: OpenJevConfig;
}

/**
 * Build the prompt actually sent to piSession.prompt().
 *
 * Composition order is unchanged from the historical inline code:
 * cold-start history, extension prefix (prepended), finished delegation
 * results, running-delegation markers, then the OpenJev routing hint.
 */
export async function assembleContextualPrompt(
  deps: AssembleContextualPromptDeps
): Promise<string> {
  let contextualPrompt = deps.prompt;
  if (deps.isColdStart) {
    // Cold start: inject recent history into the prompt. The rebuild itself
    // lives in cold-start-history so it is unit-testable without Electron or
    // the SDK; only the logging stays here.
    const preamble = buildColdStartHistoryPreamble({
      prompt: deps.prompt,
      messages: deps.existingMessages,
      contextWindow: deps.contextWindow,
      provider: deps.provider,
    });

    if (preamble) {
      contextualPrompt = preamble.prompt;
      log(
        '[CoworkAgentRunner] Cold start: injecting',
        preamble.injectedCount,
        'of',
        preamble.totalCount,
        'history messages (budget:',
        preamble.charBudget,
        'chars, used:',
        preamble.charCount,
        ', charsPerToken:',
        preamble.charsPerToken.toFixed(2),
        ')'
      );
    }
  } else {
    // Reusing session — SDK already has the full conversation context
    logCtx('[CoworkAgentRunner] Reusing existing SDK session for:', deps.sessionId);
  }
  if (deps.extensionPromptPrefix?.trim()) {
    contextualPrompt = `${deps.extensionPromptPrefix.trim()}\n\n${contextualPrompt}`;
  }

  // Async delegation: append results of finished background tasks (once)
  // and mark still-running ones, so the main agent can keep the user
  // informed without blocking on the delegation.
  const delegationResults = takePendingDelegationResults(deps.sessionId);
  if (delegationResults) {
    contextualPrompt = `${contextualPrompt}\n\n${delegationResults}`;
  }
  const runningDelegations = describeRunningDelegations(deps.sessionId);
  if (runningDelegations) {
    contextualPrompt = `${contextualPrompt}\n\n${runningDelegations}`;
  }

  // OpenJev routing hint (optional, OFF by default): a lightweight
  // System One call evaluates whether the swarm is warranted. Never
  // blocking — any failure degrades to no hint, behavior unchanged.
  if (deps.openjev?.enabled) {
    const routingStarted = Date.now();
    const verdict = await evaluateRoutingSignal(deps.prompt, deps.openjev);
    const hint = formatRoutingHint(verdict);
    if (hint) {
      contextualPrompt = `${contextualPrompt}\n\n${hint}`;
    }
    log(
      `[OpenJev] prompt="${deps.prompt.slice(0, 80)}" → ` +
        (verdict
          ? `swarm=${verdict.needsSwarm.toFixed(2)} complexity=${verdict.complexity.toFixed(2)} ` +
            `confidence=${verdict.confidence.toFixed(2)} latency=${verdict.latencyMs}ms`
          : `no verdict (unreachable/timeout) after ${Date.now() - routingStarted}ms`) +
        ` → hint ${hint ? 'injected' : 'skipped'}`
    );
  }

  return contextualPrompt;
}
