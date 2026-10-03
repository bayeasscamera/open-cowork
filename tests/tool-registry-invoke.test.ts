import { describe, expect, it, beforeEach } from 'vitest';

import {
  isValidToolName,
  normalizeToolName,
  ToolRegistry,
  type ToolDefinition,
} from '../src/main/tools/registry';
import {
  defaultExtractToolPath,
  runToolGate,
  validateToolArgs,
  type ToolGateDeps,
} from '../src/main/tools/pipeline';
import { invokeTool, truncateByPruner } from '../src/main/tools/invoke';

function def(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'read_file',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
    } as unknown as ToolDefinition['inputSchema'],
    risk: 'read',
    execute: async () => ({ content: 'ok' }),
    ...overrides,
  };
}

const allowAll: ToolGateDeps = {
  decidePermission: () => ({ allowed: true }),
};

describe('tool name validation', () => {
  it('accepts lowercase snake_case only', () => {
    expect(isValidToolName('read_file')).toBe(true);
    expect(isValidToolName('mcp__chrome__screenshot')).toBe(true);
    expect(isValidToolName('Read_File')).toBe(false);
    expect(isValidToolName('read-file')).toBe(false);
    expect(isValidToolName('1tool')).toBe(false);
    expect(isValidToolName('')).toBe(false);
    expect(isValidToolName(42)).toBe(false);
  });

  it('normalizes hostile or foreign names instead of dropping them', () => {
    expect(normalizeToolName('ReadFile')).toBe('read_file');
    expect(normalizeToolName('chrome-screenshot')).toBe('chrome_screenshot');
    expect(normalizeToolName('3d_render')).toBe('t_3d_render');
    expect(normalizeToolName('  ')).toBeNull();
    expect(normalizeToolName('!!!')).toBeNull();
  });
});

describe('ToolRegistry', () => {
  it('refuses an invalid name and refuses to silently shadow a duplicate', () => {
    const registry = new ToolRegistry();
    registry.register(def());
    expect(() => registry.register(def())).toThrow('Duplicate tool registration');
    expect(() => registry.register(def({ name: 'Bad Name' }))).toThrow('Invalid tool name');
  });

  it('lists in stable alphabetical order and filters by allow-list', () => {
    const registry = new ToolRegistry();
    registry.register(def({ name: 'write_file' }));
    registry.register(def({ name: 'read_file' }));
    registry.register(def({ name: 'bash' }));

    expect(registry.names()).toEqual(['bash', 'read_file', 'write_file']);
    expect(registry.list({ allow: ['read_file'] }).map((t) => t.name)).toEqual(['read_file']);
    // An empty allow-list means "nothing", never "everything".
    expect(registry.list({ allow: [] })).toEqual([]);
  });
});

describe('argument validation', () => {
  it('rejects a wrong-typed and an out-of-enum argument', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        count: { type: 'integer' },
        mode: { type: 'string', enum: ['read', 'write'] },
      },
    } as unknown as ToolDefinition['inputSchema'];

    expect(validateToolArgs(schema, { path: 1 }).valid).toBe(false);
    expect(validateToolArgs(schema, { count: 1.5 }).valid).toBe(false);
    expect(validateToolArgs(schema, { mode: 'delete' }).valid).toBe(false);
    expect(validateToolArgs(schema, { path: 'a', count: 2, mode: 'read' }).valid).toBe(true);
  });

  it('ignores absent optional arguments and tolerates null args', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
    } as unknown as ToolDefinition['inputSchema'];
    expect(validateToolArgs(schema, {}).valid).toBe(true);
    expect(validateToolArgs(schema, null)).toEqual({ valid: true, args: {} });
    expect(validateToolArgs(schema, 'nope').valid).toBe(false);
  });
});

describe('gate pipeline order', () => {
  const ctx = { sessionId: 's1', cwd: '/workspace' };

  it('refuses a tool the preset does not allow, before any permission check', async () => {
    let permissionAsked = false;
    const decision = await runToolGate(def(), { path: 'a.txt' }, ctx, {
      ...allowAll,
      allowedTools: ['bash'],
      decidePermission: () => {
        permissionAsked = true;
        return { allowed: true };
      },
    });
    expect(decision).toMatchObject({ allowed: false, stage: 'preset' });
    // Nothing was asked of the user for a tool the agent may not use at all.
    expect(permissionAsked).toBe(false);
  });

  it('blocks a write outside the workspace at the path-guard stage', async () => {
    const decision = await runToolGate(def(), { path: '../escape.txt' }, ctx, {
      ...allowAll,
      extractPath: defaultExtractToolPath,
      checkPath: (p) => ({ allowed: p.startsWith('/workspace'), reason: 'escapes workspace' }),
    });
    expect(decision).toMatchObject({ allowed: false, stage: 'pathGuard' });
  });

  it('runs stages in the documented order: validate -> preset -> mods -> permission -> path', async () => {
    const order: string[] = [];
    const deps: ToolGateDeps = {
      allowedTools: ['read_file'],
      decidePermission: () => {
        order.push('permission');
        return { allowed: true };
      },
      extractPath: () => {
        order.push('path');
        return '/workspace/a.txt';
      },
      checkPath: () => ({ allowed: true }),
      runModsPre: () => {
        order.push('mods');
        return { blocked: false };
      },
    };

    await runToolGate(def(), { path: 123 }, ctx, deps);
    // Invalid input never reaches permission.
    expect(order).toEqual([]);

    await runToolGate(def(), { path: 'a.txt' }, ctx, deps);
    // Mods run BEFORE every approval decision so that permission and the path
    // guard see the FINAL arguments a mod produced, not the ones it replaced.
    expect(order).toEqual(['mods', 'permission', 'path']);
  });

  it('lets a mod block an otherwise allowed call', async () => {
    const decision = await runToolGate(def(), { path: 'a.txt' }, ctx, {
      ...allowAll,
      runModsPre: () => ({ blocked: true, reason: 'blocked by mod' }),
    });
    expect(decision).toMatchObject({ allowed: false, stage: 'mods' });
  });
});

describe('invokeTool', () => {
  const ctx = { sessionId: 's1', cwd: '/workspace' };

  it('runs an allowed tool and returns its content', async () => {
    const registry = new ToolRegistry();
    let executed = false;
    registry.register(
      def({
        execute: async () => {
          executed = true;
          return { content: 'file body' };
        },
      })
    );
    const result = await invokeTool(registry, 'read_file', { path: 'a.txt' }, ctx, allowAll);
    expect(result.content).toBe('file body');
    expect(executed).toBe(true);
  });

  it('never executes a tool the preset forbids', async () => {
    const registry = new ToolRegistry();
    let executed = false;
    registry.register(
      def({
        execute: async () => {
          executed = true;
          return { content: 'secret' };
        },
      })
    );
    const result = await invokeTool(registry, 'read_file', {}, ctx, {
      ...allowAll,
      allowedTools: ['bash'],
    });
    expect(executed).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not available to this agent');
  });

  it('rejects an invalid argument without executing', async () => {
    const registry = new ToolRegistry();
    let executed = false;
    registry.register(
      def({
        execute: async () => {
          executed = true;
          return { content: '' };
        },
      })
    );
    const result = await invokeTool(registry, 'read_file', { path: 42 }, ctx, allowAll);
    expect(executed).toBe(false);
    expect(result.content).toContain("Argument 'path' must be a string");
  });

  it('reports an unknown tool instead of throwing', async () => {
    const result = await invokeTool(new ToolRegistry(), 'nope', {}, ctx, allowAll);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown tool');
  });

  it('re-throws a genuine tool crash rather than disguising it as a result', async () => {
    const registry = new ToolRegistry();
    registry.register(
      def({
        execute: async () => {
          throw new Error('kaboom');
        },
      })
    );
    await expect(invokeTool(registry, 'read_file', {}, ctx, allowAll)).rejects.toThrow('kaboom');
  });

  it('applies the preset pruner to the result', async () => {
    const registry = new ToolRegistry();
    registry.register(def({ execute: async () => ({ content: 'x'.repeat(500) }) }));
    const result = await invokeTool(registry, 'read_file', {}, ctx, allowAll, {
      pruner: { thresholdChars: 100, headChars: 10, tailChars: 10 },
    });
    expect(result.content.length).toBeLessThan(100);
    expect(result.content).toContain('characters truncated');
  });
});

describe('truncateByPruner', () => {
  it('leaves content at or below the threshold untouched', () => {
    const pruner = { thresholdChars: 100, headChars: 10, tailChars: 10 };
    expect(truncateByPruner('short', pruner)).toBe('short');
    expect(truncateByPruner('y'.repeat(100), pruner)).toBe('y'.repeat(100));
  });

  it('keeps both ends and states how many characters were removed', () => {
    const content = 'HEAD' + 'm'.repeat(2000) + 'TAIL';
    const out = truncateByPruner(content, {
      thresholdChars: 100,
      headChars: 4,
      tailChars: 4,
    });
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toContain('[2000 characters truncated by the agent pruner]');
  });

  it('falls back to head-only when the budget is degenerate instead of growing output', () => {
    const content = 'z'.repeat(50);
    const out = truncateByPruner(content, { thresholdChars: 10, headChars: 40, tailChars: 40 });
    expect(out.length).toBeLessThanOrEqual(content.length);
  });

  it('is a no-op for a non-positive threshold', () => {
    const content = 'abc';
    expect(truncateByPruner(content, { thresholdChars: 0, headChars: 1, tailChars: 1 })).toBe(
      'abc'
    );
  });
});

describe('defaultExtractToolPath', () => {
  it('extracts the conventional path argument for filesystem tools', () => {
    expect(defaultExtractToolPath('read_file', { path: '/a' })).toBe('/a');
    expect(defaultExtractToolPath('write', { file_path: '/b' })).toBe('/b');
  });

  it('returns null for tools with no path so path-guard is skipped, not failed', () => {
    expect(defaultExtractToolPath('bash', { command: 'ls' })).toBeNull();
    expect(defaultExtractToolPath('read_file', {})).toBeNull();
  });
});
