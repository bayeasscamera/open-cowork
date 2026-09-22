/**
 * @module main/agent/openjev-router
 *
 * Lightweight routing signal from a local OpenJev "System One" decision
 * server (POST /v1/systemone: {state, questions} → typed answers with
 * probabilities). Used ONLY as a hint injected into the main agent's prompt:
 * it never blocks, never short-circuits generation, and degrades to null on
 * any failure (service down, timeout, malformed response). Every decision is
 * logged (prompt → verdict → injected) so routing quality is auditable.
 *
 * Audited against the real server code (openjev/api.py): request shape is
 * {state: string, model: string, questions: {key: {type: 'noul'|'choice'|'score', ...}}};
 * response is {model, answers: Record<key, {noul?|choice?|score?, confidence}>, usage}.
 */

import { logWarn } from '../utils/logger';

export interface OpenJevConfig {
  enabled: boolean;
  baseUrl: string;
}

interface OpenJevVerdict {
  /** Probability that the request genuinely needs the multi-agent swarm. */
  needsSwarm: number;
  /** Expected complexity: 0 = trivial, 1 = moderate, 2 = complex. */
  complexity: number;
  /** Confidence of the swarm answer (1 = certain, 0 = uniform). */
  confidence: number;
  /** Wall-clock cost of the OpenJev call itself, in ms. */
  latencyMs: number;
}

const ROUTING_TIMEOUT_MS = 1500;
const STATE_MAX_CHARS = 2000;

async function postSystemOne(
  baseUrl: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openjev-latest', ...body }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Ask OpenJev whether this user request needs the multi-agent swarm and how
 * complex it is. Returns null when OpenJev is disabled, unreachable, slow, or
 * answers off-schema — the caller then behaves exactly as before.
 */
export async function evaluateRoutingSignal(
  userPrompt: string,
  config: OpenJevConfig
): Promise<OpenJevVerdict | null> {
  if (!config.enabled || !config.baseUrl) return null;
  const startedAt = Date.now();
  try {
    const response = await postSystemOne(
      config.baseUrl,
      {
        state: userPrompt.slice(0, STATE_MAX_CHARS),
        questions: {
          needs_swarm: {
            type: 'noul',
            instructions:
              'Does answering this well require MULTIPLE specialized roles or parallel work streams (architecture + implementation + review), rather than one direct answer?',
          },
          complexity: {
            type: 'score',
            instructions: 'How much coordinated multi-step work does this request involve?',
            criteria: ['trivial one-liner', 'moderate multi-step', 'complex multi-role'],
          },
        },
      },
      ROUTING_TIMEOUT_MS
    );
    const latencyMs = Date.now() - startedAt;
    if (!response) {
      logWarn(`[OpenJev] No answer in ${latencyMs}ms — routing hint skipped (non-blocking)`);
      return null;
    }
    const answers = response.answers as
      | Record<string, { noul?: number; choice?: unknown; score?: number; confidence?: number }>
      | undefined;
    const needsSwarm = num(answers?.needs_swarm?.noul);
    const complexity = num(answers?.complexity?.score);
    const confidence = num(answers?.needs_swarm?.confidence);
    if (needsSwarm === undefined || complexity === undefined) return null;
    return {
      needsSwarm,
      complexity,
      confidence: confidence ?? 0,
      latencyMs,
    };
  } catch (err) {
    logWarn('[OpenJev] Routing evaluation failed (non-blocking):', err);
    return null;
  }
}

/** Format the verdict as the injected routing-hint block ('' when none). */
export function formatRoutingHint(verdict: OpenJevVerdict | null): string {
  if (!verdict) return '';
  const leaning =
    verdict.needsSwarm >= 0.7
      ? 'a multi-role swarm is LIKELY warranted'
      : verdict.needsSwarm <= 0.3
        ? 'a direct answer is LIKELY sufficient — prefer not to use the swarm'
        : 'the need for a swarm is UNCLEAR';
  return (
    `<routing_hint source="openjev">\n` +
    `Lightweight pre-routing evaluation of this request (advisory only, you decide): ` +
    `probability the swarm is warranted: ${verdict.needsSwarm.toFixed(2)} (confidence ${verdict.confidence.toFixed(2)}), ` +
    `expected complexity: ${verdict.complexity.toFixed(2)} (0 trivial — 2 complex). ` +
    `Assessment: ${leaning}.\n` +
    `</routing_hint>`
  );
}