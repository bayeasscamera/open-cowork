/**
 * @module main/agent/agent-hooks
 *
 * Tool-call hooks installed on a pi-coding-agent session: the permission gate
 * (deny / ask / allow) and the local mods pre/post hooks. Extracted from
 * CoworkAgentRunner so the security-critical gating logic is testable.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentSession as PiAgentSession } from '@mariozechner/pi-coding-agent';
import {
  getPiAgentInternals,
  type PiBeforeToolCallHook,
  type PiToolCallContext,
} from './pi-agent-access';
import { getModsRegistry } from '../mods/mods-runtime';
import { recordSkillUseIfApplicable } from '../mods/skill-doctor';
import { decidePermissionWithDetail, describeDenyRefusal, describeLockdownRefusal, rememberAlwaysAllow } from '../config/permission-rules-store';
import { log, logWarn, logError } from '../utils/logger';

export type PermissionRequestResult = 'allow' | 'deny' | 'allow_always';

export type RequestPermission = (
  sessionId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>
) => Promise<PermissionRequestResult>;

export interface PermissionHookOptions {
  piSession: PiAgentSession;
  sessionId: string;
  requestPermission?: RequestPermission;
  getToolDisplayName: (toolName: string) => string;
}

/**
 * Install a permission-gating hook on the pi-coding-agent session via
 * `agent.setBeforeToolCall`. This is the only interception point that
 * fires for built-in tools (read, bash, edit, write) — the SDK ignores
 * wrapped `execute` functions on built-in tools passed via `options.tools`.
 *
 * The hook consults `decidePermissionWithDetail` from the main-process rules cache:
 *  - 'allow' → delegate to SDK's original hook (proceeds normally)
 *  - 'deny'  → return { block: true, reason } (SDK treats as tool error).
 *    User deny rules win even under Full Access; the reason names the rule
 *    and tells the model to adapt rather than retry or stall.
 *  - 'ask'   → await requestPermission() IPC round-trip to PermissionDialog
 *
 * Known limitation: the async requestPermission wait (user dialog) causes
 * the renderer to miss UI update events. The tool executes correctly on
 * the backend, but the renderer's loading spinner may not clear. This is
 * a renderer-side issue tracked as a follow-up.
 */
export function installPermissionHook(options: PermissionHookOptions): void {
  if (!options.requestPermission) {
    log('[CoworkAgentRunner] No requestPermission callback — skipping permission hook');
    return;
  }

  // Access the Agent instance (public readonly property on AgentSession)
  // and wrap its beforeToolCall hook with our permission gate.
  //
  // We must chain to the SDK's original beforeToolCall hook because it
  // fires extension tool_call events and manages the _agentEventQueue.
  // Without chaining, the renderer misses completion events.
  const agent = getPiAgentInternals(options.piSession);
  if (!agent || typeof agent.setBeforeToolCall !== 'function') {
    logWarn('[CoworkAgentRunner] Cannot access agent.setBeforeToolCall — skipping permission hook');
    return;
  }

  // Capture the SDK's hook before we overwrite it
  const sdkBeforeToolCall: PiBeforeToolCallHook | undefined = agent._beforeToolCall;

  const requestPermission = options.requestPermission;
  const getDisplayName = options.getToolDisplayName;

  agent.setBeforeToolCall(
    async (ctx: PiToolCallContext, signal?: AbortSignal): Promise<unknown> => {
      const toolName: string = ctx.toolCall?.name ?? '';
      const input: Record<string, unknown> = ctx.args ?? {};

      const { decision, matchedDenyRule, overriddenBypass, lockdownRefusal } =
        decidePermissionWithDetail(options.sessionId, toolName, input);
      // Human-readable name for prompts/messages (e.g. MCP sanitized
      // 'mcp__chrome__chrome_screenshot__ab12' → 'chrome_screenshot').
      // Rule matching and rememberAlwaysAllow still use the canonical
      // `toolName` so allow-once decisions stay stable across calls.
      const displayName = getDisplayName(toolName);

      if (decision === 'deny') {
        // A user deny rule names itself so the agent can attribute the refusal
        // and adapt; a lockdown refusal explains the read-only policy; a
        // structural deny (e.g. subagent hard-deny) falls back to the generic
        // wording. Either way the model must react, not stall.
        const reason = matchedDenyRule
          ? describeDenyRefusal(displayName, matchedDenyRule)
          : lockdownRefusal
            ? describeLockdownRefusal(displayName)
            : `Tool '${displayName}' is denied by your permission rules.`;
        log(`[CoworkAgentRunner] Tool '${toolName}' denied by rule`, {
          rule: matchedDenyRule ?? undefined,
          overriddenBypass: overriddenBypass ?? undefined,
          lockdownRefusal,
        });
        return { block: true, reason };
      }

      if (decision === 'ask') {
        const toolUseId = `${ctx.toolCall?.id ?? 'unknown'}-perm-${uuidv4().slice(0, 8)}`;
        let result: 'allow' | 'deny' | 'allow_always';
        try {
          // Send the display name to the renderer so the dialog shows a
          // human-readable tool name; canonical `toolName` is still used
          // for rule matching above and "always allow" memory below.
          result = await requestPermission(options.sessionId, toolUseId, displayName, input);
        } catch (permErr) {
          logError(
            `[CoworkAgentRunner] Permission request failed for '${toolName}' — failing closed`,
            permErr
          );
          return {
            block: true,
            reason: `Permission request failed for '${displayName}'; tool not executed.`,
          };
        }

        if (result === 'deny') {
          log(`[CoworkAgentRunner] Tool '${toolName}' denied by user`);
          return { block: true, reason: `User denied permission for '${displayName}'.` };
        }

        if (result === 'allow_always') {
          rememberAlwaysAllow(options.sessionId, toolName);
        }
      }

      // Allowed — delegate to SDK's original hook for event pipeline
      return sdkBeforeToolCall ? sdkBeforeToolCall(ctx, signal) : undefined;
    }
  );

  log(
    `[CoworkAgentRunner] Permission hook installed on session ${options.sessionId} via agent.setBeforeToolCall`
  );
}

/**
 * Install the local mods hooks on the session agent:
 *  - pre-hook composes into the SAME beforeToolCall slot as the permission
 *    gate (mods run first — they can block a call before permissions).
 *  - post-hook uses the Agent's setAfterToolCall: mods can replace the text
 *    content of tool results BEFORE they are emitted into the model context
 *    (security-redactor) or observe them (telemetry, diff collector).
 */
export function installModsHooks(piSession: PiAgentSession, sessionId: string): void {
  const agent = getPiAgentInternals(piSession);
  if (!agent || typeof agent.setAfterToolCall !== 'function') {
    logWarn('[CoworkAgentRunner] Cannot access agent.setAfterToolCall — mods post-hook skipped');
    return;
  }

  // Pre-hook composition into the existing permission slot.
  const originalBefore: PiBeforeToolCallHook | undefined = agent._beforeToolCall;

  if (typeof agent.setBeforeToolCall === 'function') {
    agent.setBeforeToolCall(
      async (ctx: PiToolCallContext, signal?: AbortSignal): Promise<unknown> => {
        const toolName: string = ctx.toolCall?.name ?? '';
        const args: Record<string, unknown> = ctx.args ?? {};
        const modsDecision = getModsRegistry().runPreToolUse({ sessionId, toolName, args });
        recordSkillUseIfApplicable(toolName, args);
        if (modsDecision.block) {
          return { block: true, reason: modsDecision.reason ?? 'Blocked by a local mod.' };
        }
        return originalBefore ? originalBefore(ctx, signal) : undefined;
      }
    );
  }

  // Post-hook: replace the result text when any mod rewrites it.
  agent.setAfterToolCall(async (ctx: PiToolCallContext): Promise<unknown> => {
    const toolName: string = ctx.toolCall?.name ?? '';
    const args: Record<string, unknown> = ctx.args ?? {};
    const blocks = Array.isArray(ctx.result?.content) ? ctx.result.content : [];
    const text = blocks
      .filter((block: { type?: string; text?: string }) => block.type === 'text')
      .map((block: { text?: string }) => block.text ?? '')
      .join('');
    const replaced = getModsRegistry().runPostToolUse(
      { sessionId, toolName, args },
      { content: text }
    );
    if (replaced !== text) {
      return { content: [{ type: 'text', text: replaced }] };
    }
    return undefined;
  });

  log(`[CoworkAgentRunner] Mods hooks installed on session ${sessionId}`);
}
