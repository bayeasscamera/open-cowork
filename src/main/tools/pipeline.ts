/**
 * @module main/tools/pipeline
 *
 * The shared tool-call gate pipeline — the single source of truth for every
 * check that must run before a tool does anything.
 *
 * Order is load-bearing and is the whole point of this module:
 *
 *   1. **validate**   — arguments must match the tool's JSON Schema. A malformed
 *                       call never reaches a permission dialog or a mod.
 *   2. **preset**     — the active agent preset's `tools.allow` subset. Checked
 *                       BEFORE permissions so a tool the agent is not even
 *                       allowed to know about is refused without consulting
 *                       the user (there is nothing to ask permission for).
 *   3. **permission** — the existing user rule engine (deny / ask / allow).
 *   4. **path-guard** — write/read paths must resolve inside the workspace.
 *   5. **mods pre**   — local mods may block (security-redactor style policy).
 *
 * Both entry points share it: `invokeTool()` (./invoke.ts) for calls we
 * execute ourselves (sub-agents, the run_code bridge), and the pi SDK's
 * beforeToolCall hook (../agent/agent-hooks.ts) for calls the SDK dispatches.
 * That is why this function takes the checks as injected dependencies: the
 * SDK path supplies Electron-bound collaborators, while tests and the headless
 * runner supply cheap fakes, and neither can accidentally skip a stage.
 */

import type { ToolDefinition, ToolContext, ToolResult } from './registry';
import type { ToolRisk } from './registry';
import { log, logWarn } from '../utils/logger';

/** Outcome of the pre-execution gate. */
export type GateDecision =
  | { allowed: true; args: Record<string, unknown> }
  | { allowed: false; reason: string; stage: GateStage };

export type GateStage =
  | 'validate'
  | 'preset'
  | 'permission'
  | 'machineAccess'
  | 'pathGuard'
  | 'mods';

/** Collaborative dependencies, injected so the module stays testable. */
export interface ToolGateDeps {
  /** Active preset allow-list; undefined means "no preset restriction". */
  allowedTools?: readonly string[];
  /**
   * Existing permission engine. Returns the decision plus the wording the model
   * should receive, so this module never re-derives permission policy.
   *
   * Async because the 'ask' decision is a renderer round-trip: the hook path
   * and the RPC path must both be able to wait for the user.
   */
  decidePermission(input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<{ allowed: boolean; reason?: string }> | { allowed: boolean; reason?: string };
  /**
   * Extract the filesystem path a call touches, if any. Returns null for tools
   * with no path (so path-guard is skipped rather than failing them).
   */
  extractPath?: (toolName: string, args: Record<string, unknown>) => string | null;
  /**
   * Workspace confinement check. Only invoked when `extractPath` returns a
   * path.
   */
  checkPath?: (path: string, ctx: ToolContext) => { allowed: boolean; reason?: string };
  /** Local mods pre-hooks. */
  runModsPre?: (input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
  }) => { blocked: boolean; reason?: string };
  /**
   * Controlled machine access: classify the call and demand user approval for
   * anything dangerous or suspicious, or touching a sensitive zone. Runs on
   * BOTH entry points (this pipeline is shared), so the model cannot reach a
   * dangerous action through the code path that skips the hook.
   *
   * Absent = the stage is skipped, never failed: a caller with no machine
   * access wired keeps its previous behaviour.
   */
  assessMachineAccess?: (input: {
    sessionId: string;
    toolName: string;
    args: Record<string, unknown>;
    cwd: string;
  }) =>
    | { blocked: boolean; reason?: string }
    | Promise<{ blocked: boolean; reason?: string }>;
}

/**
 * Validate arguments against a tool's JSON Schema.
 *
 * A hand-rolled structural check rather than a full JSON-Schema evaluator: the
 * schemas in play are produced by us and by MCP servers and cover objects,
 * strings, numbers, booleans, arrays, enums and nested objects. Unknown
 * keywords are ignored rather than rejected, so a richer schema from a newer
 * server does not start failing calls.
 */
export function validateToolArgs(
  schema: ToolDefinition['inputSchema'] | undefined,
  args: unknown
): { valid: true; args: Record<string, unknown> } | { valid: false; reason: string } {
  if (args === null || args === undefined) {
    return { valid: true, args: {} };
  }
  if (typeof args !== 'object' || Array.isArray(args)) {
    return { valid: false, reason: 'Tool arguments must be an object.' };
  }
  const record = args as Record<string, unknown>;
  if (!schema || typeof schema !== 'object') {
    return { valid: true, args: record };
  }
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (properties && typeof properties === 'object') {
    for (const [key, rawSpec] of Object.entries(properties)) {
      const spec = rawSpec as { type?: string; enum?: unknown[] };
      const value = record[key];
      if (value === undefined) continue;
      if (spec.type === 'string' && typeof value !== 'string') {
        return { valid: false, reason: `Argument '${key}' must be a string.` };
      }
      if (spec.type === 'number' && typeof value !== 'number') {
        return { valid: false, reason: `Argument '${key}' must be a number.` };
      }
      if (spec.type === 'integer' && !Number.isInteger(value)) {
        return { valid: false, reason: `Argument '${key}' must be an integer.` };
      }
      if (spec.type === 'boolean' && typeof value !== 'boolean') {
        return { valid: false, reason: `Argument '${key}' must be a boolean.` };
      }
      if (spec.type === 'array' && !Array.isArray(value)) {
        return { valid: false, reason: `Argument '${key}' must be an array.` };
      }
      if (spec.type === 'object' && (typeof value !== 'object' || value === null)) {
        return { valid: false, reason: `Argument '${key}' must be an object.` };
      }
      if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
        return {
          valid: false,
          reason: `Argument '${key}' must be one of: ${spec.enum.map(String).join(', ')}.`,
        };
      }
    }
  }
  return { valid: true, args: record };
}

/**
 * Run every pre-execution check in order. Returns the normalized arguments on
 * success, or the first refusal with the stage that produced it.
 */
export async function runToolGate(
  tool: ToolDefinition,
  args: unknown,
  ctx: ToolContext,
  deps: ToolGateDeps
): Promise<GateDecision> {
  // 1. Validate — a malformed call must never reach a dialog or a mod.
  const validated = validateToolArgs(tool.inputSchema, args);
  if (!validated.valid) {
    return { allowed: false, reason: validated.reason, stage: 'validate' };
  }
  const normalized = validated.args;

  // 2. Preset allow-list. Checked before permissions: a tool the agent is not
  //    allowed to use has no permission to ask for.
  if (deps.allowedTools && !deps.allowedTools.includes(tool.name)) {
    return {
      allowed: false,
      stage: 'preset',
      reason:
        `Tool '${tool.name}' is not available to this agent. ` +
        `Allowed tools: ${deps.allowedTools.length > 0 ? deps.allowedTools.join(', ') : '(none)'}.`,
    };
  }

  // 3. Existing permission engine (may await a user decision).
  const permission = await deps.decidePermission({
    sessionId: ctx.sessionId,
    toolName: tool.name,
    args: normalized,
  });
  if (!permission.allowed) {
    return {
      allowed: false,
      stage: 'permission',
      reason: permission.reason ?? `Tool '${tool.name}' was refused by permission rules.`,
    };
  }

  // 3b. Machine access — dangerous/suspicious actions and sensitive zones ask
  //     the user, in EVERY autonomy level including "allow-all". Runs after the
  //     ordinary permission decision (so an already-refused call never reaches
  //     a second dialog) and before the path guard.
  if (deps.assessMachineAccess) {
    const machineAccess = await deps.assessMachineAccess({
      sessionId: ctx.sessionId,
      toolName: tool.name,
      args: normalized,
      cwd: ctx.cwd,
    });
    if (machineAccess.blocked) {
      return {
        allowed: false,
        stage: 'machineAccess',
        reason:
          machineAccess.reason ??
          `Tool '${tool.name}' needs explicit user approval for machine access.`,
      };
    }
  }

  // 4. Path-guard — only for tools that actually touch a path.
  if (deps.extractPath && deps.checkPath) {
    const target = deps.extractPath(tool.name, normalized);
    if (target) {
      const pathDecision = deps.checkPath(target, ctx);
      if (!pathDecision.allowed) {
        return {
          allowed: false,
          stage: 'pathGuard',
          reason:
            pathDecision.reason ??
            `Path '${target}' is outside the workspace for tool '${tool.name}'.`,
        };
      }
    }
  }

  // 5. Mods pre-hooks.
  if (deps.runModsPre) {
    const mods = deps.runModsPre({
      sessionId: ctx.sessionId,
      toolName: tool.name,
      args: normalized,
    });
    if (mods.blocked) {
      return {
        allowed: false,
        stage: 'mods',
        reason: mods.reason ?? `Tool '${tool.name}' was blocked by a local rule.`,
      };
    }
  }

  return { allowed: true, args: normalized };
}

/** Tools that touch the filesystem and therefore need a path-guard pass. */
const PATH_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'read_file',
  'write',
  'write_file',
  'edit',
  'edit_file',
  'notebook_edit',
  'glob',
  'grep',
  'ls',
  'multi_edit',
]);

/** Default path extraction: the conventional `path` / `file_path` argument. */
export function defaultExtractToolPath(
  toolName: string,
  args: Record<string, unknown>
): string | null {
  if (!PATH_TOOLS.has(toolName)) return null;
  const candidate = args.path ?? args.file_path ?? args.filePath;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/** Risk of a tool, defaulting to the most conservative class on unknown data. */
export function toolRiskOf(tool: ToolDefinition): ToolRisk {
  return tool.risk;
}

/** Wrap a gate refusal as a tool error result, so the model can react. */
export function refusalResult(reason: string, stage: GateStage): ToolResult {
  return { content: reason, isError: true, details: { refusedAt: stage } };
}

/** Best-effort log of a refusal; never throws. */
export function logRefusal(
  toolName: string,
  decision: Extract<GateDecision, { allowed: false }>,
  sessionId: string
): void {
  const line = `[Tools] '${toolName}' refused at ${decision.stage} for session ${sessionId}: ${decision.reason}`;
  if (decision.stage === 'validate') {
    logWarn(line);
  } else {
    log(line);
  }
}
