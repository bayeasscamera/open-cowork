/**
 * @module main/tools/registry
 *
 * The single registry of every tool Open Cowork can expose to a model.
 *
 * Why a registry at all: the tool surface is assembled per session from four
 * different sources (pi coding tools, MCP bridges, runtime extensions, web and
 * image tools), each with its own shape. Without one place that knows which
 * tools exist, "which tools may this agent use?" cannot be answered — and that
 * question is exactly what an agent preset has to answer. The registry is that
 * one place.
 *
 * It deliberately does NOT execute anything. Execution funnels through
 * `invokeTool()` (see ./invoke.ts), which runs the shared gate pipeline
 * (validation → preset → permission → path-guard → mods) so no caller can skip
 * a layer.
 */

import type { TSchema } from 'typebox';

/** What a tool can do, for preset/risk decisions and UI affordances. */
export type ToolRisk = 'read' | 'write' | 'exec' | 'network';

/**
 * JSON-Schema-shaped input description. TypeBox schemas (what pi-ai speaks)
 * are JSON Schema objects, so this is deliberately a structural type rather
 * than a TypeBox generic: a preset must be able to validate a tool's input
 * from a plain JSON file.
 */
export type JsonSchema = TSchema & { [key: string]: unknown };

/** What a tool returns, normalized to the text the model actually sees. */
export interface ToolResult {
  /** Text content handed to the model (after mods redaction + truncation). */
  content: string;
  /** False when the tool failed; the model sees `content` either way. */
  isError?: boolean;
  /** Free-form structured payload for internal consumers. */
  details?: unknown;
}

/**
 * Execution context. Everything a tool needs that is not its own arguments,
 * so `execute` stays a pure-ish function of (args, ctx).
 */
export interface ToolContext {
  sessionId: string;
  /** Workspace root the session is confined to. */
  cwd: string;
  signal?: AbortSignal;
  /** Tool-call id, for correlating traces and diff snapshots. */
  toolCallId?: string;
}

/** One tool as the registry knows it. */
export interface ToolDefinition {
  /** Unique, lowercase snake_case. Never trusted from unvalidated input. */
  name: string;
  description: string;
  /** JSON Schema of the accepted arguments. */
  inputSchema: JsonSchema;
  risk: ToolRisk;
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolListFilter {
  /** When present, only these names are returned. An empty allow-list yields none. */
  allow?: readonly string[];
}

/** A tool name must be lowercase snake_case: it is an LLM-facing identifier. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function isValidToolName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && TOOL_NAME_PATTERN.test(name);
}

/**
 * Normalize an arbitrary name to something the registry will accept, or return
 * null. Used to sanitize names coming from MCP servers and extension
 * contributions, which are not under our authorship.
 */
export function normalizeToolName(raw: string): string | null {
  const normalized = raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!normalized) return null;
  // Must start with a letter; prefix a digit rather than reject, so a server
  // exposing "3d_render" is usable instead of silently dropped.
  const withPrefix = /^[a-z]/.test(normalized) ? normalized : `t_${normalized}`;
  return isValidToolName(withPrefix) ? withPrefix : null;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /**
   * Register a tool. Rejects an invalid or duplicate name rather than
   * overwriting: a silent overwrite would let one source shadow another
   * source's tool without any trace, which is exactly the failure a registry
   * exists to prevent.
   */
  register(def: ToolDefinition): void {
    if (!isValidToolName(def.name)) {
      throw new Error(`Invalid tool name: ${JSON.stringify(def.name)}`);
    }
    if (this.tools.has(def.name)) {
      throw new Error(`Duplicate tool registration: ${def.name}`);
    }
    this.tools.set(def.name, def);
  }

  /** Register, replacing an existing entry. Only for explicit re-registration. */
  registerOrReplace(def: ToolDefinition): void {
    if (!isValidToolName(def.name)) {
      throw new Error(`Invalid tool name: ${JSON.stringify(def.name)}`);
    }
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** All tools, or the subset named by `filter.allow`, in stable name order. */
  list(filter: ToolListFilter = {}): ToolDefinition[] {
    const all = [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!filter.allow) return all;
    const allowed = new Set(filter.allow);
    return all.filter((tool) => allowed.has(tool.name));
  }

  /** Every registered name, sorted. */
  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  get size(): number {
    return this.tools.size;
  }

  clear(): void {
    this.tools.clear();
  }
}

/**
 * The process-wide registry. Populated at session-tool assembly time by the
 * agent runner; read by presets, the presenter and the run_code bridge so all
 * three see the same catalog.
 */
export const toolRegistry = new ToolRegistry();
