import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRunCodeTool, RUN_CODE_TOOL_NAME } from '../src/main/tools/run-code-tool';
import { ToolRegistry, type ToolDefinition } from '../src/main/tools/registry';
import { runToolGate, type ToolGateDeps } from '../src/main/tools/pipeline';
import { seatbeltUsable } from './sandbox-capability';

/**
 * The run_code tool adapter.
 *
 * It is a thin adapter on purpose: no evaluation, no policy of its own. What is
 * worth testing is that it never becomes a way AROUND the gate, and that every
 * failure comes back as a message the model can act on rather than a throw that
 * the tool loop would surface as a crash.
 */

let workspace = '';

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'cowork-rctool-'));
});

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const echo: ToolDefinition = {
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } } as never,
    risk: 'read',
    execute: async (args) => ({ content: `E:${(args as { value?: string })?.value ?? ''}` }),
  };
  registry.register(echo);
  return registry;
}

function permissiveGate(overrides: Partial<ToolGateDeps> = {}): ToolGateDeps {
  return { decidePermission: () => ({ allowed: true }), ...overrides };
}

function build(overrides: Partial<Parameters<typeof buildRunCodeTool>[0]> = {}) {
  return buildRunCodeTool({
    registry: makeRegistry(),
    gate: permissiveGate(),
    allowedTools: ['echo'],
    ...overrides,
  });
}

describe('the tool is shaped so the gate can reason about it', () => {
  it('is classified as a write, the conservative class', () => {
    // Understating risk would let a permission rule treat it as harmless.
    expect(build().risk).toBe('write');
  });

  it('requires a source string', () => {
    expect(build().inputSchema).toMatchObject({ required: ['source'] });
  });
});

describe('input validation happens before anything is spawned', () => {
  it('rejects a missing source without running anything', async () => {
    const tool = build();
    const result = await tool.execute({}, { sessionId: 's', cwd: workspace });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/source/i);
  });

  it('rejects an empty source', async () => {
    const tool = build();
    const result = await tool.execute({ source: '   ' }, { sessionId: 's', cwd: workspace });
    expect(result.isError).toBe(true);
  });

  it('rejects a non-string source rather than coercing it', async () => {
    const tool = build();
    const result = await tool.execute(
      { source: { evil: true } },
      { sessionId: 's', cwd: workspace }
    );
    expect(result.isError).toBe(true);
  });
});

// These three suites execute run_code for real, so each one needs a child the
// host will actually let us sandbox. Skipped rather than faked where it will
// not (see tests/sandbox-capability.ts).
describe.skipIf(!seatbeltUsable)(
  'a tool call made from code is gated exactly like a direct one',
  () => {
    it('runs a permitted call', async () => {
      const tool = build();
      const result = await tool.execute(
        {
          source: `
          const call = await tools.echo({ value: 'hi' });
          return call;
        `,
        },
        { sessionId: 's', cwd: workspace }
      );
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('E:hi');
    }, 60_000);

    it('refuses a call the preset does not allow, and does not run it', async () => {
      // allowedTools excludes `echo`; the tool exists in the registry, so the
      // only thing that can stop it is the gate.
      const tool = build({ allowedTools: ['read'] });
      const result = await tool.execute(
        { source: `return await tools.echo({ value: 'nope' });` },
        { sessionId: 's', cwd: workspace }
      );
      expect(result.content.toLowerCase()).toMatch(/not available|refused|denied|error/);
      expect(result.content).not.toContain('E:nope');
    }, 60_000);

    it('refuses a call the permission engine denies', async () => {
      const tool = build({
        gate: permissiveGate({
          decidePermission: () => ({ allowed: false, reason: 'policy says no' }),
        }),
      });
      const result = await tool.execute(
        {
          source: `
          try { return await tools.echo({ value: 'x' }); }
          catch (error) { return 'saw: ' + String(error); }
        `,
        },
        { sessionId: 's', cwd: workspace }
      );
      expect(result.content).toContain('policy says no');
    }, 60_000);
  }
);

describe.skipIf(!seatbeltUsable)('failures are reported to the model, never thrown', () => {
  it('reports a compile error as a result, so the model can fix its own code', async () => {
    const tool = build();
    const result = await tool.execute(
      { source: 'this is not typescript (((' },
      { sessionId: 's', cwd: workspace }
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/compilation|error/i);
  }, 60_000);

  it('reports a runtime throw with its message intact', async () => {
    const tool = build();
    const result = await tool.execute(
      { source: 'throw new Error("deliberate failure");' },
      { sessionId: 's', cwd: workspace }
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('deliberate failure');
  }, 60_000);

  it('says so plainly when the script returns nothing', async () => {
    const tool = build();
    const result = await tool.execute(
      { source: 'return undefined;' },
      { sessionId: 's', cwd: workspace }
    );
    expect(result.content).toMatch(/returned nothing/i);
  }, 60_000);
});

describe.skipIf(!seatbeltUsable)(
  'the child cannot escape the workspace, through this tool either',
  () => {
    it('refuses a write outside the workspace', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'cowork-rctool-out-'));
      const target = join(outside, 'escaped.txt');
      try {
        const tool = build();
        const result = await tool.execute(
          {
            source: `
            const fs = await import('node:fs');
            try {
              fs.writeFileSync(${JSON.stringify(target)}, 'x');
              return 'WROTE_OUTSIDE';
            } catch (error) {
              return 'REFUSED';
            }
          `,
          },
          { sessionId: 's', cwd: workspace }
        );
        expect(result.content).toContain('REFUSED');
        expect(result.content).not.toContain('WROTE_OUTSIDE');
        expect(existsSync(target)).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    }, 60_000);
  }
);

describe('the gate is the same policy for both callers', () => {
  it('the run_code tool runs through the same runToolGate the SDK hook uses', () => {
    // Structural, not behavioural: it asserts the code path is not carrying its
    // own permission logic. A second implementation here is exactly the kind of
    // divergence that lets code calls bypass rules direct calls obey.
    const source = readFileSync('src/main/tools/run-code-tool.ts', 'utf8');
    // The adapter delegates; it must not import or re-implement the pipeline.
    expect(source).not.toMatch(/decidePermission\s*[:=]\s*(\(|async)/);
    expect(source).not.toMatch(/from '\.\.\/tools\/pipeline'/);
  });
});

describe('the tool name is shared with the presenter', () => {
  it('is the same constant the presenter keys on, so the two cannot drift', () => {
    // The presenter's DEFAULT_DIRECT_TOOLS lists this name; if the two ever
    // disagreed, code mode would either hide run_code or expose it twice.
    const presenter = readFileSync('src/main/presets/tool-presenter.ts', 'utf8');
    expect(presenter).toContain(`RUN_CODE_TOOL_NAME = '${RUN_CODE_TOOL_NAME}'`);
  });
});
