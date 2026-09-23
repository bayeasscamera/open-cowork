/**
 * @module main/agent/teammate-tool
 *
 * The OPT-IN `ask_teammate` tool (team mode) and the one-shot responder that
 * answers on a teammate's behalf.
 *
 * Trigger principle engraved in the tool description and in the sub-agent
 * system prompt: `ask_teammate` is for a BLOCKING need only. In every other
 * case the sub-agent must make a reasonable assumption, state it in its final
 * report and keep working. The tool is added to a sub-agent's palette ONLY when
 * team mode is explicitly enabled on the plan, so a standard swarm is byte-for-
 * byte the same DAG as before.
 *
 * The responder deliberately runs as an independent one-shot model call rather
 * than injecting a message into the target's live session: it never interrupts
 * the target's own thread, never races its next model turn, and its cost is
 * trivially attributable (exactly one model call per answered question).
 */

import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type { AppConfig } from '../config/config-store';
import type { AgentTask } from './multi-agent-coordinator';
import { runPiAiOneShot } from './sdk-one-shot';
import {
  askTeammate,
  MAX_TEAMMATE_CALLS_PER_TASK,
  type TeammateResponder,
  type TeammateTeam,
} from './teammate-bus';

export const ASK_TEAMMATE_TOOL_NAME = 'ask_teammate';

/** Trigger principle — kept verbatim so tests and the prompt cannot drift. */
export const ASK_TEAMMATE_TRIGGER_RULE =
  "N'utilise ask_teammate que si tu ne peux PAS continuer sans cette information précise. " +
  "Dans tous les autres cas, fais une hypothèse raisonnable, signale-la dans ton rapport final, et continue ta tâche.";

export const TEAMMATE_ANSWER_SYSTEM_PROMPT =
  'You are a teammate sub-agent inside a collaborative swarm. Another teammate is blocked and ' +
  'asks you ONE precise question. Answer it from what you already know about the shared work; be ' +
  'concise, factual and immediately usable (max 10 lines). If you do not know, say so and name the ' +
  'reasonable assumption they should take. NEVER ask a question back: this is a one-shot answer, ' +
  'there is no follow-up dialogue.';

export interface AskTeammateToolOptions {
  team: TeammateTeam;
  /** Role of the asking sub-agent. */
  role: string;
  /** Task id of the asking sub-agent (drives the hard call limit). */
  taskId: string;
  /** Roles that can be asked; an empty list exposes a free-form role field. */
  targetRoles: string[];
  /** Deadline override (defaults to the bus default, 30s). */
  timeoutMs?: number;
}

/**
 * Build the `ask_teammate` custom tool for one sub-agent session. The tool
 * always resolves — a timeout, an unknown target or an exhausted quota returns
 * an instruction to continue with the best judgment instead of failing the
 * task.
 */
export function buildAskTeammateTool(options: AskTeammateToolOptions): AgentRuntimeCustomTool {
  const targetRoleParam = options.targetRoles.length
    ? Type.Union(options.targetRoles.map((role) => Type.Literal(role)))
    : Type.String();
  return {
    name: ASK_TEAMMATE_TOOL_NAME,
    label: 'Ask a teammate one blocking question',
    description:
      'Ask ANOTHER sub-agent of this swarm ONE question when — and only when — you cannot ' +
      'complete your task without that precise information. ' +
      `At most ${MAX_TEAMMATE_CALLS_PER_TASK} questions per task, one question / one answer, no dialogue: ` +
      'a follow-up counts as a second (and last) question. ' +
      'If you can continue with a reasonable assumption, DO NOT use this tool: make the assumption, ' +
      'state it in your final report and keep working. ' +
      'If nobody answers within 30 seconds, continue with your best judgment and state the assumption. ' +
      ASK_TEAMMATE_TRIGGER_RULE,
    parameters: Type.Object({
      target_role: targetRoleParam,
      question: Type.String({
        description:
          'The single, precise question you are blocked on. Include the minimum context needed for ' +
          'the teammate to answer without reading your mind.',
      }),
    }),
    execute: async (_toolCallId, params) => {
      const asked = params as { target_role?: string; question?: string };
      const targetRole = (asked.target_role ?? '').trim();
      const question = (asked.question ?? '').trim();
      if (!targetRole || !question) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'ask_teammate requires a target_role and a non-empty question.',
            },
          ],
          details: { ok: false, status: 'invalid' },
        };
      }
      const exchange = await askTeammate(options.team, {
        fromRole: options.role,
        fromTaskId: options.taskId,
        targetRole,
        question,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      const prefix =
        exchange.status === 'answered'
          ? `Answer from the "${targetRole}" teammate:`
          : exchange.status === 'limit'
            ? 'Question NOT sent (teammate question limit reached):'
            : exchange.status === 'timeout'
              ? `No answer from the "${targetRole}" teammate within the deadline:`
              : `No "${targetRole}" teammate is available:`;
      return {
        content: [
          {
            type: 'text' as const,
            text: `${prefix}
${exchange.answer}`,
          },
        ],
        details: {
          ok: exchange.status === 'answered',
          status: exchange.status,
          exchangeId: exchange.id,
          modelCalls: exchange.modelCalls,
        },
      };
    },
  };
}

export interface TeammateResponderOptions {
  /** Task of the teammate who will answer (its role/title/prompt). */
  task: AgentTask;
  /** Config the answer must run with (same profile as the target task). */
  config: AppConfig;
  /** Live slice of the target's output so far, injected for grounding. */
  getContext: () => string;
}

/**
 * Build the responder used when the target reaches a task boundary. It runs a
 * dedicated one-shot model call on the target's behalf — the target's own
 * session is never touched.
 */
export function buildTeammateResponder(options: TeammateResponderOptions): TeammateResponder {
  return async (question, context) => {
    const liveContext = options.getContext().slice(0, 4000);
    const prompt = [
      `Another teammate ("${context.askedByRole}") is blocked and asks you:`,
      question,
      '',
      '## Your own role in this swarm',
      `You are the ${options.task.role}. Your task: ${options.task.title}.`,
      options.task.prompt.slice(0, 1500),
      '',
      '## What you have produced so far',
      liveContext || '(nothing yet)',
      '',
      'Answer the question directly and concisely (max 10 lines). Do not ask anything back.',
    ].join('\n');
    const result = await runPiAiOneShot(prompt, TEAMMATE_ANSWER_SYSTEM_PROMPT, options.config, {
      temperature: 0.2,
      maxTokens: 700,
      signal: context.signal,
    });
    return result.text.trim();
  };
}
