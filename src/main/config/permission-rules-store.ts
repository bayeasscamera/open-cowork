/**
 * @module main/config/permission-rules-store
 *
 * Main-process cache of Settings.permissionRules.
 *
 * The renderer owns the source of truth (Zustand store), but the agent
 * runner needs synchronous access in the main process when wrapping tool
 * `execute()` calls. The renderer mirrors changes via the `settings.update`
 * IPC event; see `src/main/index.ts`.
 *
 * Security note: renderer-originated settings are treated as untrusted at
 * this boundary. All rules are validated and coerced before being cached —
 * unknown / malformed values fall back to `'ask'` so the worst-case is a
 * harmless extra prompt, never an unintended auto-allow.
 */
import type { PermissionRule } from '../../shared/types';

// Mirrors the renderer defaults in src/renderer/store/index.ts
const DEFAULT_RULES: PermissionRule[] = [
  { tool: 'read', action: 'allow' },
  { tool: 'glob', action: 'allow' },
  { tool: 'grep', action: 'allow' },
  { tool: 'ls', action: 'allow' },
  { tool: 'find', action: 'allow' },
  { tool: 'write', action: 'ask' },
  { tool: 'edit', action: 'ask' },
  { tool: 'bash', action: 'ask' },
];

const VALID_ACTIONS: ReadonlySet<PermissionRule['action']> = new Set(['allow', 'deny', 'ask']);

let rules: PermissionRule[] = [...DEFAULT_RULES];

/** Session-scoped "always allow" decisions, keyed by sessionId → set of lowercase tool names. */
const alwaysAllowBySession = new Map<string, Set<string>>();

/**
 * Sanitize an untrusted rules payload from IPC. Drops entries with empty
 * tool names, coerces invalid `action` values to `'ask'`, and preserves
 * optional string `pattern` fields. Returns null for non-array input.
 */
function sanitizeRules(input: unknown): PermissionRule[] | null {
  if (!Array.isArray(input)) return null;
  const out: PermissionRule[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<PermissionRule>;
    const tool = typeof r.tool === 'string' ? r.tool.trim() : '';
    if (!tool) continue;

    const pattern = typeof r.pattern === 'string' ? r.pattern : undefined;
    const rawAction = typeof r.action === 'string' ? r.action : '';
    const action: PermissionRule['action'] = VALID_ACTIONS.has(
      rawAction as PermissionRule['action']
    )
      ? (rawAction as PermissionRule['action'])
      : 'ask'; // Conservative fallback for unknown / malformed actions

    out.push({ tool, pattern, action });
  }
  return out;
}

export function setPermissionRules(next: unknown): void {
  const sanitized = sanitizeRules(next);
  rules = sanitized && sanitized.length > 0 ? sanitized : [...DEFAULT_RULES];
}

export function getPermissionRules(): PermissionRule[] {
  // Return a shallow copy so external callers can't mutate the internal cache.
  return rules.map((r) => ({ ...r }));
}

/** Global flag to automatically approve all tool calls without asking */
let autoApproveAll = false;

export function setAutoApproveAll(enabled: boolean): void {
  autoApproveAll = Boolean(enabled);
}

export function isAutoApproveAll(): boolean {
  return autoApproveAll;
}

/**
 * Decide how a given tool call should be handled.
 *
 * Matching order:
 *   0. User DENY rules (explicit refusals). They win over EVERYTHING below —
 *      Full Access mode, session "always allow" memory, everything. A deny
 *      rule is a persistent guardrail ("never touch .env"), not a suggestion,
 *      so no convenience bypass may silently override it: the refusal is
 *      reported with the rule attached instead.
 *   1. Global autoApproveAll flag (Full Access mode)
 *   2. Session-scoped "always allow" memory (including '*' for full session bypass)
 *   3. First rule whose `tool` matches (case-insensitive) AND whose
 *      optional `pattern` (glob-ish: `*` = any substring) matches the
 *      stringified input
 *   4. Default: 'ask' for unknown tools (conservative)
 *
 * Defence-in-depth: even though `setPermissionRules` sanitizes input, we
 * re-validate the matched rule's action here so a malformed rule that
 * somehow bypasses sanitation still falls back to `'ask'` rather than
 * letting an unknown value propagate into the execution path.
 */
export function decidePermission(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>
): 'allow' | 'deny' | 'ask' {
  return decidePermissionWithDetail(sessionId, toolName, input).decision;
}

export interface PermissionDecisionDetail {
  decision: 'allow' | 'deny' | 'ask';
  /**
   * The user deny rule that refused the call, if any. Non-null exactly when
   * the decision is a user-deny refusal — the hook turns it into the
   * explanation the agent receives.
   */
  matchedDenyRule: PermissionRule | null;
  /**
   * Which convenience bypass the deny rule overrode, for honest logging.
   * Null when no bypass was active or the decision is not a deny.
   */
  overriddenBypass: 'autoApprove' | 'sessionAllow' | null;
}

export function decidePermissionWithDetail(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>
): PermissionDecisionDetail {
  const lowered = toolName.toLowerCase();
  const inputStr = safeStringify(input);

  // Step 0 — explicit user refusals first. A deny rule that matches the tool
  // AND its pattern refuses even under Full Access: report what it overrode.
  for (const rule of rules) {
    if (rule.action !== 'deny') continue;
    if (rule.tool.toLowerCase() !== lowered) continue;
    if (rule.pattern && !matchesPattern(rule.pattern, inputStr)) continue;
    let overriddenBypass: PermissionDecisionDetail['overriddenBypass'] = null;
    if (autoApproveAll) {
      overriddenBypass = 'autoApprove';
    } else {
      const session = alwaysAllowBySession.get(sessionId);
      if (session?.has('*') || session?.has(lowered)) overriddenBypass = 'sessionAllow';
    }
    return { decision: 'deny', matchedDenyRule: { ...rule }, overriddenBypass };
  }

  if (autoApproveAll) return { decision: 'allow', matchedDenyRule: null, overriddenBypass: null };

  const session = alwaysAllowBySession.get(sessionId);
  if (session?.has('*') || session?.has(lowered)) {
    return { decision: 'allow', matchedDenyRule: null, overriddenBypass: null };
  }

  for (const rule of rules) {
    if (rule.tool.toLowerCase() !== lowered) continue;
    if (rule.pattern && !matchesPattern(rule.pattern, inputStr)) continue;
    return {
      decision: VALID_ACTIONS.has(rule.action) ? rule.action : 'ask',
      matchedDenyRule: null,
      overriddenBypass: null,
    };
  }
  return { decision: 'ask', matchedDenyRule: null, overriddenBypass: null };
}

/**
 * The explanation handed to the agent when a user deny rule refuses a tool
 * call. It names the rule (so the refusal is attributable, not mysterious)
 * and tells the model what to do instead of just failing: report the refusal
 * to the user and adapt the approach rather than retrying or going silent.
 */
export function describeDenyRefusal(toolName: string, rule: PermissionRule): string {
  const scope = rule.pattern ? ` matching '${rule.pattern}'` : '';
  return (
    `Tool '${toolName}' is blocked by your deny rule (tool '${rule.tool}'${scope}). ` +
    `Explain to the user what was refused and why, then adapt your approach ` +
    `to achieve the goal without the blocked action — do not retry the same ` +
    `call and do not fail silently.`
  );
}

export function rememberAlwaysAllow(sessionId: string, toolName: string): void {
  const set = alwaysAllowBySession.get(sessionId) ?? new Set<string>();
  set.add(toolName.toLowerCase());
  alwaysAllowBySession.set(sessionId, set);
}

export function forgetSessionPermissions(sessionId: string): void {
  alwaysAllowBySession.delete(sessionId);
}

function safeStringify(v: unknown): string {
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s ?? '';
  } catch {
    return '';
  }
}

function matchesPattern(pattern: string, haystack: string): boolean {
  // Escape regex metacharacters except '*', then convert '*' → '.*'
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped, 'i').test(haystack);
}
