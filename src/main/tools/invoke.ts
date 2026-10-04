/**
 * @module main/tools/invoke
 *
 * `invokeTool()` — the single entry point for executing a tool in Open Cowork.
 *
 * Every execution path funnels through here: sub-agents, the run_code bridge
 * (mode code), and any future caller. The pi SDK dispatches its own built-in
 * tools internally, so it cannot be routed through this function — instead it
 * runs the *same* gate pipeline (./pipeline.ts) through its beforeToolCall
 * hook. Both share one implementation, which is what makes "permissions,
 * path-guard, secrets and the diff panel apply everywhere" a structural fact
 * rather than a convention.
 *
 * The order is enforced by construction, not by documentation:
 *   gate (validate → preset → permission → path-guard → mods pre)
 *   → execute → mods post (redaction) → preset truncation.
 */

import {
  type ToolContext,
  type ToolDefinition,
  type ToolRegistry,
  type ToolResult,
} from './registry';
import {
  type ToolGateDeps,
  logRefusal,
  refusalResult,
  runToolGate,
} from './pipeline';
import { logWarn } from '../utils/logger';
import { getGlobalAuditLog } from '../agent/audit-log-registry';

/** Truncation budget, supplied by the active agent preset. */
export interface PrunerSettings {
  /** Leave the result alone while it is at or below this size. */
  thresholdChars: number;
  /** Characters kept from the start. */
  headChars: number;
  /** Characters kept from the end. */
  tailChars: number;
}

/**
 * Truncate while keeping both ends and stating exactly how much was dropped.
 *
 * The marker is explicit and carries the number removed: a model that sees a
 * silently shortened output has no way to tell truncation from completion, and
 * will reason about content that is not there.
 */
export function truncateByPruner(
  content: string,
  pruner: PrunerSettings
): string {
  if (!Number.isFinite(pruner.thresholdChars) || pruner.thresholdChars <= 0) return content;
  if (content.length <= pruner.thresholdChars) return content;

  const head = Math.max(0, Math.floor(pruner.headChars));
  const tail = Math.max(0, Math.floor(pruner.tailChars));
  // A degenerate budget (head+tail >= threshold) would produce a longer string
  // than the input; fall back to head-only rather than growing the output.
  if (head + tail >= content.length || head + tail >= pruner.thresholdChars) {
    return content.slice(0, head);
  }
  const removed = content.length - head - tail;
  const marker = `\n\n...[${removed} characters truncated by the agent pruner]...\n\n`;
  return content.slice(0, head) + marker + content.slice(content.length - tail);
}

/** Options for one invocation. */
export interface InvokeToolOptions {
  /** Truncation budget from the active preset. Absent = no truncation. */
  pruner?: PrunerSettings;
  /** Human-facing name used in permission prompts (e.g. MCP sanitized name). */
  displayName?: string;
  /** Override the session id carried to permissions / mods. */
  sessionId?: string;
  /** Skip the gate. Only for internal, already-gated calls; never for RPC. */
  skipGate?: boolean;
}

/**
 * Execute a tool through the full gate. Never throws for an ordinary refusal:
 * a denied or invalid call comes back as an error result so the model receives
 * a reason it can act on, exactly as the SDK hook path reports a block.
 * A genuine bug inside `execute` is re-thrown, because swallowing it would hide
 * a real failure behind a plausible-looking tool result.
 */
export async function invokeTool(
  registry: ToolRegistry,
  name: string,
  args: unknown,
  ctx: ToolContext,
  deps: ToolGateDeps,
  options: InvokeToolOptions = {}
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    return {
      content: `Unknown tool '${name}'.`,
      isError: true,
      details: { refusedAt: 'registry' },
    };
  }

  const effectiveCtx: ToolContext = options.sessionId
    ? { ...ctx, sessionId: options.sessionId }
    : ctx;

  let callArgs: Record<string, unknown>;
  if (options.skipGate) {
    callArgs = (args && typeof args === 'object' && !Array.isArray(args)
      ? args
      : {}) as Record<string, unknown>;
  } else {
    const decision = await runToolGate(tool, args, effectiveCtx, deps);
    if (!decision.allowed) {
      logRefusal(tool.name, decision, effectiveCtx.sessionId);
      return refusalResult(decision.reason, decision.stage);
    }
    callArgs = decision.args;
  }

  let result: ToolResult;
  try {
    result = await tool.execute(callArgs, effectiveCtx);
  } catch (error) {
    // A tool that throws is a bug or a genuine environmental failure, not a
    // policy refusal: re-throw so the caller's error path handles it rather
    // than dressing it up as a normal result.
    logWarn(`[Tools] '${tool.name}' threw during execute:`, error);
    throw error;
  }


  const auditLog = getGlobalAuditLog();
  if (auditLog) {
    try {
      const entry: import('../../shared/workflow-types').NewAuditEntry = {
        action: `tool:${tool.name}`,
        justification: `Tool invocation via invokeTool${effectiveCtx.sessionId ? ` (session: ${effectiveCtx.sessionId})` : ''}`,
        authorization: result.isError ? 'auto' : 'auto',
        ...(result.isError ? {} : {}),
      };
      auditLog.append(entry);
    } catch {
      // Audit failure must never interrupt tool execution
    }
  }

  const normalized: ToolResult = {
    ...result,
    content: typeof result.content === 'string' ? result.content : String(result.content ?? ''),
  };

  return options.pruner
    ? { ...normalized, content: truncateByPruner(normalized.content, options.pruner) }
    : normalized;
}

/** Re-exported so callers can build a registry without a second import. */
export type { ToolContext, ToolDefinition, ToolRegistry, ToolResult };
