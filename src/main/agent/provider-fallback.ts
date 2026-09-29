/**
 * @module main/agent/provider-fallback
 *
 * Provider fallback for the chat run loop.
 *
 * A rate limit (HTTP 429) or a gateway 5xx is a *routable* failure: the turn
 * produced nothing the user can keep, so replaying the same request on the
 * next configured ConfigSet is strictly better than ending the turn with a
 * dead-end error banner. This module owns the decision — which ConfigSets are
 * eligible, and whether a given failure may be retried on another one.
 *
 * It is deliberately a pure policy layer with no Electron, no pi-ai and no
 * config-store dependency, so the routing rules can be unit-tested directly and
 * the agent runner only has to supply the candidate list and observe the result.
 *
 * Safety rule that shapes the whole module: a turn is only replayed when NO
 * tool ran. Once a tool has executed, the workspace has already been mutated
 * and replaying the prompt would re-apply those side effects. Callers therefore
 * pass the tool-execution count observed during the failed attempt; a non-zero
 * count makes the failure terminal regardless of its kind.
 */

import type { AppConfig } from '../config/config-store';
import { classifyTerminalError, type TerminalErrorCode } from './agent-runner-message-end';

/** Failures that justify replaying the turn on a different ConfigSet. */
const ROUTABLE_ERROR_CODES: ReadonlySet<TerminalErrorCode> = new Set<TerminalErrorCode>([
  'rate_limited',
  'server_error',
  'network_error',
]);

export interface FallbackCandidate {
  /** Id of the ConfigSet this candidate would route to. */
  configSetId: string;
  /** Human-readable label used in the "switching provider" notice. */
  label: string;
  /** The projected config for that set — carries its own provider/credentials. */
  config: AppConfig;
}

export interface BuildFallbackCandidatesInput {
  /** Every configured ConfigSet, in declaration order. */
  configSets: readonly { id: string; name: string }[];
  /** The set that already failed; never re-proposed as a fallback. */
  failedConfigSetId: string;
  /** Resolve a set id into its projected config; undefined when unknown. */
  projectSet: (configSetId: string) => AppConfig | undefined;
  /** Only sets with usable credentials can actually serve a request. */
  hasUsableCredentials: (config: AppConfig) => boolean;
  /** Optional cap so a broken setup cannot fan out over 20 sets. */
  maxCandidates?: number;
}

/** Default cap: two alternatives is enough to survive one bad gateway. */
const DEFAULT_MAX_CANDIDATES = 2;

/**
 * Build the ordered list of ConfigSets to try after the current one failed.
 *
 * Order is stable (declaration order) so a fallback run is reproducible and
 * the user sees the same provider on every retry of the same turn.
 */
export function buildFallbackCandidates(
  input: BuildFallbackCandidatesInput
): FallbackCandidate[] {
  const maxCandidates = Math.max(0, input.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  if (maxCandidates === 0) {
    return [];
  }

  const candidates: FallbackCandidate[] = [];
  const seen = new Set<string>([input.failedConfigSetId]);

  for (const set of input.configSets) {
    if (candidates.length >= maxCandidates) {
      break;
    }
    if (seen.has(set.id)) {
      continue;
    }
    seen.add(set.id);

    const config = input.projectSet(set.id);
    // A set that cannot serve a request (no key, or Ollama without a model)
    // would only burn a turn on another dead-end error.
    if (!config || !input.hasUsableCredentials(config)) {
      continue;
    }
    candidates.push({ configSetId: set.id, label: set.name, config });
  }

  return candidates;
}

export interface ShouldFallbackInput {
  /** Machine-readable kind of the failure that ended the turn. */
  errorCode: TerminalErrorCode;
  /** Tool executions observed during the failed attempt. */
  toolExecutions: number;
  /** False when the user cancelled or the run was aborted — never replay those. */
  aborted?: boolean;
}

/**
 * Decide whether a failed turn may be replayed on another ConfigSet.
 *
 * Replay requires a routable failure, zero tool side-effects, and a turn that
 * was not aborted. The tool condition is the load-bearing one: it is what keeps
 * a rate limit from silently re-running side effects.
 */
export function shouldFallbackToProvider(input: ShouldFallbackInput): boolean {
  if (input.aborted) {
    return false;
  }
  if (input.toolExecutions > 0) {
    return false;
  }
  return ROUTABLE_ERROR_CODES.has(input.errorCode);
}

/** Classify a raw terminal error string into the same kind the runner uses. */
export function classifyForFallback(errorText: string): TerminalErrorCode {
  return classifyTerminalError(errorText);
}
