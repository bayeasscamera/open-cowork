import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

import { runCode } from '../src/main/agent/run-code-host';
import { DEFAULT_RUN_CODE_LIMITS, buildChildEnv, isSecretEnvName, parseChildMessage, resolveRunCodeLimits } from '../src/main/agent/run-code-protocol';
import { ToolRegistry, type ToolDefinition } from '../src/main/tools/registry';
import { STANDARD_PRESET } from '../src/main/presets/builtin-presets';

/**
 * run_code is the capability with the largest blast radius, so these tests use
 * REAL PROCESSES rather than mocks. The child is compiled from the actual
 * production sources (run-code-child-main.ts) and executed as a real `node`
 * process with its own PID, so the timeout, the process-group kill and the
 * "never in the main process" property are all exercised for real.
 */

let workdir = '';
let childScript = '';

/** Compile the real child entry (and everything it imports) to one JS file. */
beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'cowork-run-code-'));
  // The child script is written INSIDE the repo so Node can resolve
  // `import('esbuild')` by walking up to the project's node_modules — exactly
  // how the packaged app resolves it from dist-electron. esbuild stays
  // external: inlining its CJS internals into an ESM bundle breaks at runtime.
  childScript = join(process.cwd(), 'node_modules', '.cache', 'cowork-run-code-child.mjs');
  await build({
    entryPoints: ['src/main/agent/run-code-child-main.ts'],
    outfile: childScript,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['esbuild'],
  });
}, 60_000);

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  if (childScript) rmSync(childScript, { force: true });
});

function makeTool(name: string, content: string): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
    } as unknown as ToolDefinition['inputSchema'],
    risk: 'read',
    execute: async (args) => {
      const value = (args as { value?: string } | undefined)?.value;
      return { content: content + (value ?? '') };
    },
  };
}

function harness(tools: ToolDefinition[], allowedTools: string[]) {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return {
    registry,
    base: {
      sessionId: 'session-1',
      cwd: workdir,
      allowedTools,
      gate: { decidePermission: () => ({ allowed: true }) },
      childScript,
    },
  };
}

describe('the child runtime is real', () => {
  it('compiled the production child entry to an executable file', () => {
    expect(existsSync(childScript)).toBe(true);
  });
});

describe('a script chains tool calls and returns a value', () => {
  it('performs three sequential calls and reports the composed result', async () => {
    const { registry, base } = harness([makeTool('echo', 'E:')], ['echo']);
    const result = await runCode({
      ...base,
      registry,
      source: `
        const a = await tools.echo({ value: 'one' });
        const b = await tools.echo({ value: 'two' });
        const c = await tools.echo({ value: 'three' });
        return a + '|' + b + '|' + c;
      `,
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('E:one|E:two|E:three');
    expect(result.toolCalls).toBe(3);
  }, 30_000);

  it('transpiles TypeScript, not just JavaScript', async () => {
    const { registry, base } = harness([makeTool('echo', 'E:')], ['echo']);
    const result = await runCode({
      ...base,
      registry,
      source: `
        interface Row { value: string }
        const rows: Row[] = [{ value: 'x' }, { value: 'y' }];
        const parts: string[] = [];
        for (const row of rows) parts.push(await tools.echo({ value: row.value }));
        return parts.join(',');
      `,
    });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('E:x,E:y');
  }, 30_000);
});

describe('a syntax error is reported cleanly, not as a crash', () => {
  it('returns a compilation error and does not hang', async () => {
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      source: 'const x: = ;;;((',
      limits: { timeoutMs: 15_000 },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/compilation failed|Transform/i);
  }, 30_000);

  it('returns a runtime error with the message intact', async () => {
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      source: `throw new Error('deliberate failure');`,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('deliberate failure');
  }, 30_000);
});

describe('limits are enforced against a real process', () => {
  it('kills the child when it exceeds the time limit', async () => {
    const { registry, base } = harness([], []);
    const started = Date.now();
    const result = await runCode({
      ...base,
      registry,
      // An infinite loop with no await can never be interrupted from inside.
      source: 'while (true) {}',
      limits: { timeoutMs: 1500 },
    });
    const elapsed = Date.now() - started;

    expect(result.status).toBe('timeout');
    expect(result.error).toContain('time limit');
    // It really was killed near the limit, not after a long drain.
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it('kills the whole process group, so a spawned child cannot outlive it', async () => {
    const { registry, base } = harness([], []);
    const marker = join(workdir, 'grandchild-survived.txt');
    // The script spawns a grandchild that writes the marker well after the
    // limit. If only the direct child were killed, the marker would appear.
    const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(
      marker
    )}, 'survived'), 3000)`;
    const result = await runCode({
      ...base,
      registry,
      source: [
        "const { spawn } = await import('node:child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
        'while (true) {}',
      ].join('\n'),
      limits: { timeoutMs: 1200 },
    });

    expect(result.status).toBe('timeout');
    // Wait past the grandchild's own delay: if only the direct child had been
    // killed, the marker would exist by now.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('refuses more tool calls than the quota allows', async () => {
    const { registry, base } = harness([makeTool('echo', 'E:')], ['echo']);
    const result = await runCode({
      ...base,
      registry,
      source: `
        for (let i = 0; i < 10; i += 1) await tools.echo({ value: String(i) });
        return 'done';
      `,
      limits: { maxToolCalls: 3, timeoutMs: 20_000 },
    });
    expect(result.status).toBe('tool_limit');
    expect(result.error).toContain('maximum of 3 tool calls');
  }, 40_000);
});

describe('the preset allow-list binds code exactly as it binds direct calls', () => {
  it('refuses a tool the preset does not allow, and does not run it', async () => {
    let executed = false;
    const sneaky: ToolDefinition = {
      name: 'sneaky',
      description: 'must not run',
      inputSchema: { type: 'object', properties: {} } as unknown as ToolDefinition['inputSchema'],
      risk: 'write',
      execute: async () => {
        executed = true;
        return { content: 'leaked' };
      },
    };
    const { registry, base } = harness([sneaky], ['echo']);

    const result = await runCode({
      ...base,
      registry,
      source: `
        try {
          await tools.sneaky({});
          return 'it ran';
        } catch (error) {
          return 'refused: ' + error.message;
        }
      `,
    });

    expect(executed).toBe(false);
    expect(result.output).toContain('not available to this agent');
  }, 30_000);

  it('the shipped standard preset does not allow run_code at all', () => {
    // Defence in depth: even with code mode enabled, the default preset never
    // grants the code entry point.
    expect(STANDARD_PRESET.tools.allow).not.toContain('run_code');
  });
});

describe('the child cannot read secrets from its environment', () => {
  it('an API-key variable in the parent env is not visible to the script', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-never-be-visible';
    process.env.COWORK_FAKE_TOKEN = 'token-should-never-be-visible';
    try {
      const { registry, base } = harness([], []);
      const result = await runCode({
        ...base,
        registry,
        source: `
          return JSON.stringify({
            anthropic: typeof process.env.ANTHROPIC_API_KEY,
            fake: typeof process.env.COWORK_FAKE_TOKEN,
            path: typeof process.env.PATH,
          });
        `,
        limits: { timeoutMs: 20_000 },
      });

      expect(result.status).toBe('completed');
      const seen = JSON.parse(result.output) as Record<string, string>;
      expect(seen.anthropic).toBe('undefined');
      expect(seen.fake).toBe('undefined');
      // Infrastructure the child legitimately needs is still present.
      expect(seen.path).toBe('string');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.COWORK_FAKE_TOKEN;
    }
  }, 40_000);
});

describe('a child that crashes does not take the app with it', () => {
  it('a hard process exit is reported as a failure', async () => {
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      source: `process.exit(7);`,
      limits: { timeoutMs: 15_000 },
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('unexpectedly');
  }, 30_000);

  it('an out-of-memory allocation is contained by the child boundary', async () => {
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      // Grows until the process dies; the host must survive and report it.
      source: `
        const blocks: number[] = [];
        for (;;) blocks.push(new Array(1e7).fill(0));
      `,
      limits: { timeoutMs: 20_000, maxMemoryBytes: 256 * 1024 * 1024 },
    });
    expect(['failed', 'timeout']).toContain(result.status);
    // The test process is still alive to make this assertion.
    expect(true).toBe(true);
  }, 40_000);
});

describe('protocol and environment helpers', () => {
  it('ignores malformed child output instead of throwing', () => {
    expect(parseChildMessage('not json')).toBeNull();
    expect(parseChildMessage('')).toBeNull();
    expect(parseChildMessage('{"type":"unknown"}')).toBeNull();
    expect(parseChildMessage('{"type":"done","value":1}')).toEqual({ type: 'done', value: 1 });
  });

  it('never forwards a secret-looking variable to the child', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'DB_PASSWORD',
      'MY_SESSION_KEY',
    ]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    // Infrastructure variables must survive, or the child cannot run at all.
    for (const name of ['PATH', 'HOME', 'LANG', 'TMPDIR']) {
      expect(isSecretEnvName(name), name).toBe(false);
    }
  });

  it('strips secrets but keeps the environment functional', () => {
    const env = buildChildEnv(
      { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-x', HOME: '/home/u', EMPTY: undefined },
      { COWORK_RUN_CODE_SESSION: 's1' }
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.EMPTY).toBeUndefined();
    expect(env.COWORK_RUN_CODE_SESSION).toBe('s1');
  });

  it('falls back to safe defaults for nonsense limits', () => {
    const limits = resolveRunCodeLimits({ timeoutMs: -5, maxToolCalls: 0 });
    expect(limits.timeoutMs).toBe(DEFAULT_RUN_CODE_LIMITS.timeoutMs);
    expect(limits.maxToolCalls).toBe(DEFAULT_RUN_CODE_LIMITS.maxToolCalls);
    // The shipped default is a 60s ceiling with a 50-call budget.
    expect(DEFAULT_RUN_CODE_LIMITS.timeoutMs).toBe(60_000);
    expect(DEFAULT_RUN_CODE_LIMITS.maxToolCalls).toBe(50);
  });
});
