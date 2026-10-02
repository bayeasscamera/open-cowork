import { describe, expect, it } from 'vitest';

import {
  checkMcpSchema,
  DEFAULT_MCP_SCHEMA_LIMITS,
  describeMcpSchemaRefusal,
  type McpSchemaLimits,
} from '../src/main/agent/mcp-schema-guard';

/**
 * The MCP schema guard.
 *
 * A server's schema reaches AJV's code generator, so it is checked before it
 * becomes a tool. The checks are syntactic and bounded — size, depth, node
 * count, pattern validity and length — because detecting catastrophic
 * backtracking in general is undecidable, and a heuristic claiming to would be
 * theater. A refusal drops the TOOL, not the schema: a schema-less tool cannot
 * be validated, which is worse.
 */

const limits: McpSchemaLimits = { ...DEFAULT_MCP_SCHEMA_LIMITS };

function deep(depth: number): unknown {
  let schema: unknown = { type: 'string' };
  for (let i = 0; i < depth; i += 1) schema = { type: 'object', properties: { nested: schema } };
  return schema;
}

describe('acceptable schemas pass untouched', () => {
  it('accepts a normal tool schema', () => {
    expect(
      checkMcpSchema(
        {
          type: 'object',
          properties: {
            path: { type: 'string' },
            count: { type: 'number', minimum: 0 },
            mode: { type: 'string', enum: ['a', 'b'] },
            filter: { type: 'string', pattern: '^[a-z0-9_-]+$' },
          },
          required: ['path'],
        },
        limits
      )
    ).toBeNull();
  });

  it('accepts an empty schema', () => {
    expect(checkMcpSchema({}, limits)).toBeNull();
  });
});

describe('pathological schemas are refused, with the reason', () => {
  it('refuses a schema that is not an object', () => {
    expect(checkMcpSchema(null, limits)).toMatchObject({ reason: 'not_an_object' });
    expect(checkMcpSchema('string', limits)).toMatchObject({ reason: 'not_an_object' });
    expect(checkMcpSchema([1, 2], limits)).toMatchObject({ reason: 'not_an_object' });
  });

  it('refuses an oversized schema', () => {
    // Few nodes but long strings, so SIZE trips before the node count does.
    const big = { type: 'object', properties: {} as Record<string, unknown> };
    for (let i = 0; i < 20; i += 1) {
      big.properties[`param_number_${i}_with_a_descriptive_name`] = {
        type: 'string',
        description: 'x'.repeat(5000),
      };
    }
    expect(checkMcpSchema(big, limits)?.reason).toBe('too_large');
  });

  it('refuses an over-deep schema', () => {
    expect(checkMcpSchema(deep(50), limits)?.reason).toBe('too_deep');
  });

  it('accepts a schema comfortably inside the depth boundary', () => {
    // Each deep() level costs ~2 of depth (properties, then nested).
    expect(checkMcpSchema(deep(3), limits)).toBeNull();
  });

  it('refuses just past the boundary', () => {
    expect(checkMcpSchema(deep(6), limits)?.reason).toBe('too_deep');
  });

  it('refuses a schema with too many nodes', () => {
    const wide: Record<string, unknown> = { type: 'object', properties: {} };
    const props = wide.properties as Record<string, unknown>;
    // Many small nodes: under the size cap but over the node cap.
    for (let i = 0; i < limits.maxNodes + 10; i += 1) props[`p${i}`] = { type: 'boolean' };
    // Size may also trip first; either refusal is correct, but nodes must trip
    // when size does not. Use tight limits to isolate.
    const tight: McpSchemaLimits = { ...limits, maxSizeBytes: 10 ** 9 };
    expect(checkMcpSchema(wide, tight)?.reason).toBe('too_many_nodes');
  });

  it('refuses a pattern that is not a valid regex', () => {
    expect(
      checkMcpSchema({ type: 'string', pattern: '([a-z' }, limits)
    ).toMatchObject({ reason: 'invalid_pattern' });
  });

  it('refuses a pattern over the length budget', () => {
    expect(
      checkMcpSchema({ type: 'string', pattern: `^${'a'.repeat(500)}$` }, limits)
    ).toMatchObject({ reason: 'pattern_too_long' });
  });

  it('accepts a pattern at the boundary', () => {
    expect(
      checkMcpSchema({ type: 'string', pattern: `^${'a'.repeat(190)}$` }, limits)
    ).toBeNull();
  });
});

describe('the guard never throws on adversarial input', () => {
  it('survives cyclic input', () => {
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;
    expect(() => checkMcpSchema(cyclic, limits)).not.toThrow();
    // A cycle revisits nodes; it must terminate with an answer either way.
    expect(checkMcpSchema(cyclic, limits)).not.toBeUndefined();
  });

  it('survives a deeply nested array', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 5000; i += 1) nested = [nested];
    // Iterative walk: no stack overflow, and the depth cap trips.
    expect(checkMcpSchema({ type: 'array', items: nested }, limits)?.reason).toBe('too_deep');
  });
});

describe('refusal messages name the server, the tool and the reason', () => {
  it('is greppable and actionable', () => {
    const message = describeMcpSchemaRefusal('evil-server', 'run', {
      reason: 'pattern_too_long',
      length: 500,
      limit: 200,
    });
    expect(message).toContain('evil-server');
    expect(message).toContain('run');
    expect(message).toContain('500');
    expect(message).toContain('not registered');
  });
});

describe('the bridge applies the guard', () => {
  it('drops a tool with a pathological schema and keeps the rest', async () => {
    const { buildMcpCustomTools } = await import('../src/main/agent/agent-runner-mcp-tools');
    const tools = buildMcpCustomTools({
      getTools: () => [
        {
          name: 'good',
          serverName: 's',
          description: 'fine',
          inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        },
        {
          name: 'bad',
          serverName: 's',
          description: 'pathological',
          inputSchema: { type: 'string', pattern: `^${'a'.repeat(9000)}$` },
        },
      ],
      callTool: async () => ({ content: [] }),
    } as never);
    expect(tools.map((t) => t.name)).toEqual(['good']);
  });

  it('keeps every tool when all schemas are sane', async () => {
    const { buildMcpCustomTools } = await import('../src/main/agent/agent-runner-mcp-tools');
    const tools = buildMcpCustomTools({
      getTools: () => [
        {
          name: 'a',
          serverName: 's',
          description: '',
          inputSchema: { type: 'object' },
        },
        {
          name: 'b',
          serverName: 's',
          description: '',
          inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
        },
      ],
      callTool: async () => ({ content: [] }),
    } as never);
    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
  });
});
