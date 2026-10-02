/**
 * @module main/agent/mcp-schema-guard
 *
 * What a third-party MCP server's schema is allowed to look like before AJV
 * compiles it.
 *
 * The honest threat model first. MCP schemas arrive as JSON over the wire, and
 * JSON has no functions, so a server cannot inject code into AJV's generated
 * validator — codegen escapes strings, and an escaping bug would be a CVE in AJV
 * itself, not something this module can see. What a schema CAN do is deny
 * service: a pathological `pattern` with catastrophic backtracking hangs every
 * validation of every call to that tool, and a megabyte-sized schema makes
 * compilation itself expensive. A server malicious enough to do that on purpose
 * already executes tools through the agent, so this guard is mostly about
 * accidents — a legitimate server with a bad regex hanging validation forever.
 *
 * So the guard is availability-shaped, and it refuses the TOOL rather than
 * silently dropping its schema: a schema-less tool cannot be validated at all,
 * which is worse than not offering the tool. Every refusal is logged with the
 * server name, the tool name and the reason, because a dropped tool that nobody
 * can see is a support ticket that cannot be solved.
 *
 * The checks are deliberately syntactic and bounded — size, depth, node count,
 * and that every `pattern` compiles and fits in a length budget. Detecting
 * catastrophic backtracking in general is undecidable, and a heuristic that
 * claimed to would be theater. The length cap plus compilation is what turns an
 * unbounded hang into a bounded refusal.
 *
 * @module
 */

/** Why a schema was refused. Structured so logs stay greppable. */
export type McpSchemaRefusal =
  | { reason: 'too_large'; size: number; limit: number }
  | { reason: 'too_deep'; depth: number; limit: number }
  | { reason: 'too_many_nodes'; nodes: number; limit: number }
  | { reason: 'invalid_pattern'; pattern: string; detail: string }
  | { reason: 'pattern_too_long'; length: number; limit: number }
  | { reason: 'not_an_object'; received: string };

export interface McpSchemaLimits {
  /** Serialized JSON size cap in bytes. */
  maxSizeBytes: number;
  /** Maximum nesting depth. */
  maxDepth: number;
  /** Maximum total object/array/scalar nodes walked. */
  maxNodes: number;
  /** Maximum length of any single `pattern` string. */
  maxPatternLength: number;
}

export const DEFAULT_MCP_SCHEMA_LIMITS: McpSchemaLimits = {
  // 64 KiB of schema is already generous: a tool with more parameters than
  // this is not a tool, it is a file format.
  maxSizeBytes: 64 * 1024,
  // JSON Schema nests through properties/items/$defs; 10 levels covers every
  // real tool schema while stopping exponential blowup early.
  maxDepth: 10,
  maxNodes: 2000,
  // A legitimate pattern fits comfortably; a ReDoS candidate rarely does, and
  // length is the one property of a regex that is always cheap to check.
  maxPatternLength: 200,
};

/**
 * Check an MCP-provided schema. Returns null when it is acceptable, or the
 * refusal when it is not.
 *
 * Never throws: a guard that throws on adversarial input is itself the
 * vulnerability. Cyclic input, getters, proxies — JSON over the wire cannot
 * contain them, but this walks defensively anyway because the function sits on
 * a trust boundary.
 */
export function checkMcpSchema(
  schema: unknown,
  limits: McpSchemaLimits = DEFAULT_MCP_SCHEMA_LIMITS
): McpSchemaRefusal | null {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { reason: 'not_an_object', received: Array.isArray(schema) ? 'array' : typeof schema };
  }

  let size: number;
  try {
    size = JSON.stringify(schema)?.length ?? 0;
  } catch {
    return { reason: 'not_an_object', received: 'unserialisable' };
  }
  if (size > limits.maxSizeBytes) {
    return { reason: 'too_large', size, limit: limits.maxSizeBytes };
  }

  let nodes = 0;
  const seen = new Set<unknown>();
  // Iterative walk: recursion on adversarial depth is a stack overflow.
  const stack: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    nodes += 1;
    if (nodes > limits.maxNodes) {
      return { reason: 'too_many_nodes', nodes, limit: limits.maxNodes };
    }
    if (depth > limits.maxDepth) {
      return { reason: 'too_deep', depth, limit: limits.maxDepth };
    }
    if (value === null || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'pattern' && typeof child === 'string') {
        const refusal = checkPattern(child, limits);
        if (refusal) return refusal;
        continue;
      }
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

/** A `pattern` must compile and fit the budget. Both are cheap; both are checked. */
function checkPattern(pattern: string, limits: McpSchemaLimits): McpSchemaRefusal | null {
  if (pattern.length > limits.maxPatternLength) {
    return { reason: 'pattern_too_long', length: pattern.length, limit: limits.maxPatternLength };
  }
  try {
    // Compiling proves it is a regex at all. It does not prove it is fast —
    // nothing cheap can — which is why the length cap above does the real work.
    new RegExp(pattern);
    return null;
  } catch (error) {
    return {
      reason: 'invalid_pattern',
      pattern: pattern.slice(0, 80),
      detail: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
    };
  }
}

/** One-line log form for a refusal. */
export function describeMcpSchemaRefusal(
  serverName: string,
  toolName: string,
  refusal: McpSchemaRefusal
): string {
  switch (refusal.reason) {
    case 'too_large':
      return (
        `MCP tool '${serverName} → ${toolName}' not registered: its schema is ${refusal.size} ` +
        `bytes (limit ${refusal.limit}). A tool schema that large cannot be validated safely.`
      );
    case 'too_deep':
      return (
        `MCP tool '${serverName} → ${toolName}' not registered: its schema nests ${refusal.depth} ` +
        `levels (limit ${refusal.limit}).`
      );
    case 'too_many_nodes':
      return (
        `MCP tool '${serverName} → ${toolName}' not registered: its schema has more than ` +
        `${refusal.limit} nodes.`
      );
    case 'invalid_pattern':
      return (
        `MCP tool '${serverName} → ${toolName}' not registered: its schema contains a ` +
        `pattern that is not a valid regex ('${refusal.pattern}'): ${refusal.detail}`
      );
    case 'pattern_too_long':
      return (
        `MCP tool '${serverName} → ${toolName}' not registered: its schema contains a ` +
        `pattern of ${refusal.length} characters (limit ${refusal.limit}).`
      );
    case 'not_an_object':
      return (
        `MCP tool '${serverName} → ${toolName}' not registered: its schema is ` +
        `${refusal.received}, not an object.`
      );
  }
}
