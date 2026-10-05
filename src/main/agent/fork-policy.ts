/**
 * @module main/agent/fork-policy
 *
 * Policy for the `fork` delegation mode.
 *
 * A fork is a sub-agent that INHERITS the parent's ConfigSet and model instead
 * of picking one from the delegation palette, and receives a snapshot of the
 * conversation so far. The reason is prompt-cache reuse: a child on the same
 * model with the same prefix reuses the parent's cache instead of paying to
 * re-establish it, which is where most of a fork's cost would otherwise go.
 *
 * All three refusals are explicit and all three are decided here, so the caller
 * cannot accidentally launch a fork that a preset forbids or that exceeds the
 * hierarchy cap. Nothing in this module launches anything.
 */

import { MAX_DELEGATION_DEPTH } from './delegation-limits';
import type { Message } from '../../shared/types';

/** Why a fork was refused. `null` reasons are the success case. */
export type ForkRefusal =
  | 'preset_forbids_fork'
  | 'depth_cap'
  | 'no_parent_model'
  | 'no_parent_config_set';

export interface ForkDecisionOk {
  allowed: true;
  /** ConfigSet the child must use — the parent's, never a palette pick. */
  configSetId: string;
  /** Model the child must use — the parent's. */
  modelId: string;
  /** Conversation snapshot handed to the child. */
  snapshot: Message[];
}

export interface ForkDecisionRefused {
  allowed: false;
  reason: ForkRefusal;
  /** User-facing explanation; names what to change. */
  message: string;
}

export type ForkDecision = ForkDecisionOk | ForkDecisionRefused;

export interface ForkRequest {
  /** Hierarchy depth of the CHILD (1 = main agent's fork). */
  depth: number;
  /** Active preset delegation policy. */
  allowFork: boolean;
  /** Preset id, for the message. */
  presetId?: string;
  /** ConfigSet the PARENT is running on. */
  parentConfigSetId?: string | null;
  /** Model the PARENT is running. */
  parentModelId?: string | null;
  /** Parent conversation, most recent last. */
  parentMessages?: readonly Message[];
  /** Newest messages copied into the child. */
  snapshotLimit?: number;
}

/** Default number of trailing messages a fork inherits. */
export const DEFAULT_FORK_SNAPSHOT_LIMIT = 20;

/**
 * Decide whether a fork may run, and with which model.
 *
 * Order matters: the preset check comes first because it is the user's stated
 * intent ("this agent may not fork"), and answering "depth cap" to a preset that
 * forbids forking would point the user at the wrong knob.
 */
export function decideFork(request: ForkRequest): ForkDecision {
  if (!request.allowFork) {
    return {
      allowed: false,
      reason: 'preset_forbids_fork',
      message:
        `The active preset${request.presetId ? ` '${request.presetId}'` : ''} does not allow forking. ` +
        `Use a regular delegation, or enable delegation.allowFork in the preset.`,
    };
  }

  // The hard hierarchy cap, matching the one enforced for ordinary delegation.
  if (request.depth > MAX_DELEGATION_DEPTH) {
    return {
      allowed: false,
      reason: 'depth_cap',
      message:
        `Fork refused: the hierarchy depth cap (${MAX_DELEGATION_DEPTH} levels) is reached. ` +
        `Handle this subtask yourself and note it in your report.`,
    };
  }

  // A fork that has to pick a model defeats its own purpose, so an unknown
  // parent model is a refusal rather than a silent palette fallback.
  if (!request.parentModelId?.trim()) {
    return {
      allowed: false,
      reason: 'no_parent_model',
      message:
        'Fork refused: the parent session has no resolvable model, so the child would have to pick one ' +
        'and lose the shared prompt cache that makes a fork worthwhile. Use a regular delegation.',
    };
  }

  if (!request.parentConfigSetId?.trim()) {
    return {
      allowed: false,
      reason: 'no_parent_config_set',
      message:
        'Fork refused: the parent session has no pinned ConfigSet. Use a regular delegation, or pin the ' +
        'session to a ConfigSet so the fork can inherit it.',
    };
  }

  return {
    allowed: true,
    configSetId: request.parentConfigSetId.trim(),
    modelId: request.parentModelId.trim(),
    snapshot: snapshotMessages(request.parentMessages ?? [], request.snapshotLimit),
  };
}

/**
 * Render a conversation snapshot as the head of a forked child's prompt.
 *
 * Wrapped in an explicit envelope with a read-only instruction, mirroring the
 * cold-start history envelope: a model that mistakes the replayed transcript
 * for the output format to imitate degrades into emitting the envelope itself.
 * Marked read-only so the child treats it as context, not as instructions.
 */
export function buildForkSnapshotPrompt(snapshot: readonly Message[]): string {
  if (snapshot.length === 0) return '';
  const turns = snapshot
    .map((message) => {
      const role = message.role === 'user' ? 'user' : 'assistant';
      const text = (message.content ?? [])
        .filter((block) => (block as { type?: string }).type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('\n')
        .trim();
      if (!text) return '';
      return `<turn role="${role}">${text}</turn>`;
    })
    .filter(Boolean)
    .join('\n');
  if (!turns) return '';
  return [
    '[Replayed conversation snapshot from the parent session, for context only.',
    'Never imitate or emit this envelope or the <turn> markup in your replies.]',
    '<conversation_snapshot>',
    turns,
    '</conversation_snapshot>',
  ].join('\n');
}

/**
 * Take the trailing slice of a conversation as the child's starting context.
 *
 * Images are dropped: the snapshot is a text context, and a base64 image block
 * in a delegated prompt is a large payload the child cannot use usefully.
 */
export function snapshotMessages(
  messages: readonly Message[],
  limit: number = DEFAULT_FORK_SNAPSHOT_LIMIT
): Message[] {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (safeLimit === 0) return [];

  const usable = messages.filter(
    (message) =>
      message &&
      !message.isError &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) =>
          block &&
          (block as { type?: string }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string' &&
          (block as { text: string }).text.trim().length > 0
      )
  );

  return usable.slice(-safeLimit).map((message) => ({
    ...message,
    content: message.content.filter(
      (block) => (block as { type?: string }).type !== 'image'
    ),
  }));
}
