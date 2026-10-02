/**
 * @module main/agent/run-code-protocol
 *
 * Wire protocol between the main process and a `run_code` child process.
 *
 * The child NEVER receives a tool implementation. It can only ASK: every
 * `tools.x()` call in the child's code becomes a JSONL request on stdout, and
 * the main process answers with a JSONL response. That is what keeps the
 * authority in one place — the main process re-runs the full gate pipeline
 * (preset, permission, path-guard, mods) on each request, so code cannot
 * obtain a capability a direct tool call could not.
 *
 * Kept dependency-free and shared verbatim by both sides, because a protocol
 * that exists twice is a protocol that will diverge.
 */

import { z } from 'zod';

/** Child -> main. */
export const runCodeRequestSchema = z.object({
  type: z.literal('tool_call'),
  /** Correlates the response. Monotonic within one execution. */
  id: z.number().int().nonnegative(),
  /** Must be in the preset's allow-list; the host enforces it. */
  tool: z.string().min(1),
  args: z.unknown().optional(),
});
export type RunCodeRequest = z.infer<typeof runCodeRequestSchema>;

/** Child -> main, once, at the end. */
export const runCodeDoneSchema = z.object({
  type: z.literal('done'),
  /** Whatever the script returned, JSON-serialised. */
  value: z.unknown().optional(),
  /** Anything the script wrote to console. */
  stdout: z.string().optional(),
});
export type RunCodeDone = z.infer<typeof runCodeDoneSchema>;

/** Child -> main, when the script threw. */
export const runCodeErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  /** Stack, forwarded so the model can be told something useful. */
  stack: z.string().optional(),
});
export type RunCodeError = z.infer<typeof runCodeErrorSchema>;

/** Main -> child, answering one request. */
export const runCodeResponseSchema = z.object({
  type: z.literal('tool_result'),
  id: z.number().int().nonnegative(),
  content: z.string(),
  isError: z.boolean().optional(),
});
export type RunCodeResponse = z.infer<typeof runCodeResponseSchema>;

export const runCodeChildMessageSchema = z.union([
  runCodeRequestSchema,
  runCodeDoneSchema,
  runCodeErrorSchema,
]);

export type RunCodeChildMessage = z.infer<typeof runCodeChildMessageSchema>;

/**
 * Parse one line of child output. Returns null for anything unrecognised
 * rather than throwing: the child may print stray output, and a malformed
 * line must not kill an execution that is otherwise fine.
 */
export function parseChildMessage(line: string): RunCodeChildMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = runCodeChildMessageSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Parse one line of HOST output (a tool answer). Returns null for anything
 * unrecognised, so a stray line cannot desynchronise the stream.
 */
export function parseHostMessage(line: string): RunCodeResponse | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = runCodeResponseSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Hard limits for one execution. Every value has a safe default; none of them
 * are "unlimited", because an unbounded child is an unbounded bill and an
 * unbounded hang.
 */
export interface RunCodeLimits {
  /** Wall-clock ceiling for the whole execution. */
  timeoutMs: number;
  /** Cap on stdout bytes the child may emit. */
  maxOutputBytes: number;
  /** Cap on `tools.*` calls per execution. */
  maxToolCalls: number;
  /** Cap on a single tool result handed back to the child. */
  maxToolResultChars: number;
  /** Address-space cap for the child, in bytes. Passed to the OS. */
  maxMemoryBytes: number;
}

export const DEFAULT_RUN_CODE_LIMITS: RunCodeLimits = {
  timeoutMs: 60_000,
  maxOutputBytes: 1_000_000,
  maxToolCalls: 50,
  maxToolResultChars: 64_000,
  // 512 MiB: enough for a script that reads a file into memory, small enough
  // that a runaway allocation cannot take the machine down with it.
  maxMemoryBytes: 512 * 1024 * 1024,
};

/** Merge caller overrides over the defaults, ignoring non-positive values. */
export function resolveRunCodeLimits(
  overrides: Partial<RunCodeLimits> | undefined
): RunCodeLimits {
  if (!overrides) return { ...DEFAULT_RUN_CODE_LIMITS };
  const pick = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  return {
    timeoutMs: pick(overrides.timeoutMs, DEFAULT_RUN_CODE_LIMITS.timeoutMs),
    maxOutputBytes: pick(overrides.maxOutputBytes, DEFAULT_RUN_CODE_LIMITS.maxOutputBytes),
    maxToolCalls: pick(overrides.maxToolCalls, DEFAULT_RUN_CODE_LIMITS.maxToolCalls),
    maxToolResultChars: pick(overrides.maxToolResultChars, DEFAULT_RUN_CODE_LIMITS.maxToolResultChars),
    maxMemoryBytes: pick(overrides.maxMemoryBytes, DEFAULT_RUN_CODE_LIMITS.maxMemoryBytes),
  };
}

/**
 * Environment variables that must never reach a child that runs model-written
 * code. Matched case-insensitively as substrings so provider-specific names
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY`, …) are covered
 * without maintaining a list that would inevitably miss one.
 */
const SECRET_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /credential/i,
  /auth/i,
  /session[_-]?key/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /^aws_/i,
  /^gh_/i,
  /^github_token$/i,
  /^bearer/i,
  /cookie/i,
];

/** Variables that are safe and often necessary for a child to behave sanely. */
const ALLOWED_EXACT = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'NODE_PATH',
  'SHELL',
  'USER',
  'SystemRoot',
  'TEMP',
  'TMP',
  'ComSpec',
]);

/** True when a variable must not be forwarded to model-written code. */
export function isSecretEnvName(name: string): boolean {
  if (ALLOWED_EXACT.has(name)) return false;
  return SECRET_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Build the child's environment: a minimal allow-list plus only the
 * non-sensitive variables from the parent.
 *
 * An allow-list would be stronger still, but it breaks legitimate use (a
 * project needing NODE_PATH, TZ, a proxy...). So this is a denylist applied to
 * the inherited set, with the short allow-list above keeping the common
 * infrastructure variables even when a pattern would have matched them.
 */
export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value !== 'string') continue;
    if (isSecretEnvName(key)) continue;
    env[key] = value;
  }
  // The child's own identity, so a stray error can be attributed.
  env.COWORK_RUN_CODE = '1';
  return { ...env, ...extra };
}
