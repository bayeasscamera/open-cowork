import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

import { runCode, heapLimitMb } from '../src/main/agent/run-code-host';
import { DEFAULT_RUN_CODE_LIMITS, buildChildEnv, isSecretEnvName, parseChildMessage, resolveRunCodeLimits } from '../src/main/agent/run-code-protocol';
import { ToolRegistry, type ToolDefinition } from '../src/main/tools/registry';
import { STANDARD_PRESET } from '../src/main/presets/builtin-presets';
import { sensitiveReadPaths } from '../src/main/agent/run-code-sandbox';

/**
 * run_code is the capability with the largest blast radius, so these tests use
 * REAL PROCESSES rather than mocks. The child is compiled from the actual
 * production sources (run-code-child-main.ts) and executed as a real `node`
 * process with its own PID, so the timeout, the process-group kill and the
 * "never in the main process" property are all exercised for real.
 */

let workdir = '';
let childScript = '';
let esbuildBinary = '';

/**
 * The esbuild platform binary. The child spawns it to transpile, so the sandbox
 * must be told it may exec that exact path - and only that path.
 */
function esbuildBinaryPath(): string {
  const pkg = createRequire(import.meta.url)('esbuild/package.json') as { version: string };
  const platform = `${process.platform === 'darwin' ? 'darwin' : process.platform}-${process.arch}`;
  return join(process.cwd(), 'node_modules', '@esbuild', platform, 'bin', 'esbuild');
}

/** Compile the real child entry (and everything it imports) to one JS file. */
beforeAll(async () => {
  workdir = mkdtempSync(join(tmpdir(), 'cowork-run-code-'));
  // The child script is written INSIDE the repo so Node can resolve
  // `import('esbuild')` by walking up to the project's node_modules — exactly
  // how the packaged app resolves it from dist-electron. esbuild stays
  // external: inlining its CJS internals into an ESM bundle breaks at runtime.
  childScript = join(process.cwd(), 'node_modules', '.cache', 'cowork-run-code-child.mjs');
  esbuildBinary = realpathSync(esbuildBinaryPath());
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
      allowedExecPaths: [esbuildBinary],
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

  it('nothing outlives the time limit, even when the script tries to persist', async () => {
    const { registry, base } = harness([], []);
    const marker = join(workdir, 'grandchild-survived.txt');
    // The script tries to leave something behind after the limit expires. Note
    // that under the sandbox the spawn itself is refused, so this now tests two
    // things at once: the sandbox refuses the exec, and the host's timeout still
    // reaps the child. Both must hold; either alone would leave a way for work
    // to continue past the limit.
    const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(
      marker
    )}, 'survived'), 3000)`;
    const result = await runCode({
      ...base,
      registry,
      source: [
        "const { spawn } = await import('node:child_process');",
        'try {',
        `  spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
        '} catch { /* the sandbox refuses this; the loop below is what we test */ }',
        'while (true) {}',
      ].join('\n'),
      limits: { timeoutMs: 1200 },
    });

    expect(result.status).toBe('timeout');
    // Wait past the grandchild's own delay: if anything had survived, or the
    // child had kept running, the marker would exist by now.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('the sandbox refuses a subprocess the script tries to spawn', async () => {
    // Stated separately from the timeout above because it is a property of the
    // sandbox, not of the host: model-written code cannot fork off work that the
    // time limit would then fail to reap.
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      source: `
        const { spawn } = await import('node:child_process');
        try {
          spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
          return 'SPAWNED';
        } catch (error) {
          return 'REFUSED: ' + String(error);
        }
      `,
      limits: { timeoutMs: 15_000 },
    });
    expect(result.output).toContain('REFUSED');
    expect(result.output).not.toContain('SPAWNED');
  });

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

  it('the child actually starts with the requested heap cap', async () => {
    // The previous OOM test only proved the HOST survives the child dying. That
    // is containment, not enforcement: an uncapped child also dies eventually.
    // The child reports its real heap limit at startup, so a silently dropped
    // flag fails here instead of in production.
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      source: `return 1;`,
      limits: { timeoutMs: 15_000, maxMemoryBytes: 256 * 1024 * 1024 },
    });
    expect(result.status).toBe('completed');
    expect(result.heapLimitBytes).toBeGreaterThan(200 * 1024 * 1024);
    expect(result.heapLimitBytes).toBeLessThan(320 * 1024 * 1024);
  });

  it('a different cap produces a different child limit, proving the flag is wired', async () => {
    const { registry, base } = harness([], []);
    const readLimit = async (bytes: number): Promise<number> => {
      const result = await runCode({
        ...base,
        registry,
        source: `return 1;`,
        limits: { timeoutMs: 15_000, maxMemoryBytes: bytes },
      });
      expect(result.status).toBe('completed');
      expect(result.heapLimitBytes).toBeTypeOf('number');
      return result.heapLimitBytes as number;
    };
    const small = await readLimit(128 * 1024 * 1024);
    const large = await readLimit(768 * 1024 * 1024);
    expect(large).toBeGreaterThan(small);
  });

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
    // The watchdog now classifies this distinctly rather than as a generic
    // failure: the host killed the child for exceeding its memory budget.
    expect(result.status).toBe('resource_limit');
    expect(result.error).toMatch(/memory budget/i);
    // The test process is still alive to make this assertion.
    expect(true).toBe(true);
  }, 40_000);
});

describe('a tool called from code is gated by the session, in code', () => {
  // These cover the case where run_code was supposed to ask the user and did
  // not: the handler was typed, documented and then never called, so supplying
  // one DISABLED gating instead of applying it.

  it('consults the session handler for a call the static rules allow', async () => {
    const { registry, base } = harness([makeTool('echo', 'E:')], ['echo']);
    const asked: string[] = [];
    const result = await runCode({
      ...base,
      registry,
      source: `return await tools.echo({ value: 'x' });`,
      requestPermission: async (_s, _id, toolName) => {
        asked.push(toolName);
        return 'allow';
      },
    });
    expect(asked).toEqual(['echo']);
    expect(result.status).toBe('completed');
  });

  it('refuses the call when the handler denies it, and the script can adapt', async () => {
    {
      const { registry, base } = harness([makeTool('echo', 'E:')], ['echo']);
      const result = await runCode({
        ...base,
        registry,
        source: `
          try { return await tools.echo({ value: 'x' }); }
          catch (error) { return 'adapted: ' + String(error); }
        `,
        requestPermission: async () => 'deny',
      });
      expect(result.status).toBe('completed');
      expect(result.output).toContain('adapted:');
    }

    const { registry, base } = harness([makeTool('echo', 'E:')], ['echo']);
    const result = await runCode({
      ...base,
      registry,
      source: `return await tools.echo({ value: 'x' });`,
      requestPermission: async () => 'deny',
    });
    // The script did not catch the rejection, so the reason surfaces as the
    // execution error. A script that DID catch it would adapt instead.
    expect(result.status).toBe('failed');
    expect(result.error).toContain('denied by the parent session');
  });

  it('never prompts when the session rules already refused the call', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('echo', 'E:'));
    let asked = 0;
    const result = await runCode({
      sessionId: 'session-1',
      cwd: workdir,
      allowedTools: ['echo'],
      registry,
      childScript,
      gate: { decidePermission: () => ({ allowed: false, reason: 'denied by policy' }) },
      allowedExecPaths: [esbuildBinary],
      source: `
        try { return await tools.echo({ value: 'x' }); }
        catch (error) { return 'saw: ' + String(error); }
      `,
      requestPermission: async () => {
        asked += 1;
        return 'allow';
      },
    });
    expect(asked).toBe(0);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('denied by policy');
  });

  it('fails closed when the handler throws, rather than allowing by accident', async () => {
    const { registry, base } = harness([makeTool('echo', 'E:')], ['echo']);
    const result = await runCode({
      ...base,
      registry,
      source: `return await tools.echo({ value: 'x' });`,
      requestPermission: async () => {
        throw new Error('renderer is gone');
      },
    });
    expect(result.error).toContain('renderer is gone');
    // The tool itself never ran: its content would have been "E:x".
    expect(result.output).not.toContain('E:x');
  });

  it('falls back to the real permission engine when no handler is supplied', async () => {
    const { registry, base } = harness([makeTool('echo', 'E:')], ['echo']);
    const result = await runCode({
      ...base,
      registry,
      source: `return await tools.echo({ value: 'x' });`,
      gate: { decidePermission: () => ({ allowed: false, reason: 'blocked by engine' }) },
    });
    expect(result.error).toContain('blocked by engine');
  });
});

describe('a real sandboxed child cannot read the home directory', () => {
  // The confinement, verified end to end through the whole host. The point is
  // that it holds for files nobody thought to list, not only for the credential
  // paths a deny-list would have covered.
  it('refuses an ordinary file in the home directory, not just a secret', async () => {
    const { registry, base } = harness([], []);
    const fakeHome = mkdtempSync(join(tmpdir(), 'cowork-home-'));
    writeFileSync(join(fakeHome, 'shopping-list.txt'), 'not a credential');
    try {
      const result = await runCode({
        ...base,
        registry,
        homeDir: fakeHome,
        source: `
          const fs = await import('node:fs');
          try {
            const text = fs.readFileSync(${JSON.stringify(join(fakeHome, 'shopping-list.txt'))}, 'utf8');
            return 'READ_ORDINARY: ' + text;
          } catch (error) {
            return 'BLOCKED';
          }
        `,
        limits: { timeoutMs: 20_000 },
      });
      expect(result.output).toContain('BLOCKED');
      expect(result.output).not.toContain('READ_ORDINARY');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 40_000);

  it('refuses to list the home directory', async () => {
    const { registry, base } = harness([], []);
    const fakeHome = mkdtempSync(join(tmpdir(), 'cowork-home-'));
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
    try {
      const result = await runCode({
        ...base,
        registry,
        homeDir: fakeHome,
        source: `
          const fs = await import('node:fs');
          try { return 'LISTED: ' + fs.readdirSync(${JSON.stringify(fakeHome)}).join(','); }
          catch (error) { return 'BLOCKED'; }
        `,
        limits: { timeoutMs: 20_000 },
      });
      expect(result.output).toContain('BLOCKED');
      expect(result.output).not.toContain('LISTED');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 40_000);

  it('refuses a symlink planted in the workspace that points into the home directory', async () => {
    // The escape a naive "writable workspace" rule gets wrong: the child creates
    // the link itself, so nothing about the path is suspicious.
    const { registry, base } = harness([], []);
    const fakeHome = mkdtempSync(join(tmpdir(), 'cowork-home-'));
    writeFileSync(join(fakeHome, 'private.txt'), 'secret');
    try {
      const link = join(workdir, 'escape-link');
      symlinkSync(join(fakeHome, 'private.txt'), link);
      const result = await runCode({
        ...base,
        registry,
        homeDir: fakeHome,
        source: `
          const fs = await import('node:fs');
          try { return 'READ_VIA_LINK: ' + fs.readFileSync(${JSON.stringify(link)}, 'utf8'); }
          catch (error) { return 'BLOCKED'; }
        `,
        limits: { timeoutMs: 20_000 },
      });
      expect(result.output).toContain('BLOCKED');
      expect(result.output).not.toContain('READ_VIA_LINK');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 40_000);

  it('still reads the workspace normally', async () => {
    const { registry, base } = harness([], []);
    const fakeHome = mkdtempSync(join(tmpdir(), 'cowork-home-'));
    try {
      const result = await runCode({
        ...base,
        registry,
        homeDir: fakeHome,
        source: `
          const fs = await import('node:fs');
          fs.writeFileSync('note.txt', 'work');
          return fs.readFileSync('note.txt', 'utf8');
        `,
        limits: { timeoutMs: 20_000 },
      });
      expect(result.status).toBe('completed');
      expect(result.output).toBe('work');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('system locations are unreadable, with the default host policy', () => {
  // The default is verified separately from the unit level: the host passes the
  // system-wide denies unless the caller overrides them, so these go through the
  // real runCode without injecting anything.
  it('cannot read /etc/hosts', async () => {
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      source: `
        const fs = await import('node:fs');
        try { return 'READ_HOSTS: ' + fs.readFileSync('/etc/hosts', 'utf8'); }
        catch (error) { return 'BLOCKED: ' + String(error); }
      `,
      limits: { timeoutMs: 20_000 },
    });
    expect(result.output).toContain('BLOCKED');
    expect(result.output).not.toContain('READ_HOSTS');
  }, 40_000);

  it('cannot list /Applications', async () => {
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      source: `
        const fs = await import('node:fs');
        try { return 'LISTED: ' + fs.readdirSync('/Applications').length; }
        catch (error) { return 'BLOCKED'; }
      `,
      limits: { timeoutMs: 20_000 },
    });
    expect(result.output).toContain('BLOCKED');
    expect(result.output).not.toContain('LISTED');
  }, 40_000);
});

describe('run_code really routes the child through the OS sandbox', () => {
  // The policy is unit-tested in run-code-sandbox.test.ts. What that cannot see
  // is whether runCode actually USES it, so these go through the whole path: a
  // real child, launched by the host, attempting real escapes. Bypassing the
  // sandbox in the host must fail these.

  it('a script cannot write outside the workspace', async () => {
    const { registry, base } = harness([], []);
    const outside = mkdtempSync(join(tmpdir(), 'cowork-outside-'));
    const target = join(outside, 'escaped.txt');
    try {
      const result = await runCode({
        ...base,
        registry,
        source: `
          const fs = await import('node:fs');
          try {
            fs.writeFileSync(${JSON.stringify(target)}, 'x');
            return 'WROTE_OUTSIDE';
          } catch (error) {
            return 'REFUSED: ' + String(error);
          }
        `,
        limits: { timeoutMs: 15_000 },
      });
      expect(result.output).toContain('REFUSED');
      expect(result.output).not.toContain('WROTE_OUTSIDE');
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a script cannot open a socket', async () => {
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      // connect() is asynchronous: it returns before the kernel refuses, so the
      // script has to await the outcome. An earlier version returned
      // NETWORK_ALLOWED immediately and passed whether or not a sandbox existed.
      source: `
        const net = await import('node:net');
        return await new Promise((resolve) => {
          const socket = net.connect(80, '1.1.1.1');
          const done = (label) => { try { socket.destroy(); } catch {} resolve(label); };
          socket.on('error', (error) => done('NETWORK_REFUSED: ' + error.code));
          socket.on('connect', () => done('NETWORK_ALLOWED'));
          setTimeout(() => done('NETWORK_TIMEOUT_UNRESOLVED'), 2500);
        });
      `,
      limits: { timeoutMs: 20_000 },
    });
    expect(result.output).toContain('NETWORK_REFUSED');
    expect(result.output).not.toContain('NETWORK_ALLOWED');
  }, 30_000);

  it('a script cannot read a denied credential directory', async () => {
    const { registry, base } = harness([], []);
    const fakeHome = mkdtempSync(join(tmpdir(), 'cowork-home-'));
    mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
    writeFileSync(join(fakeHome, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    try {
      const result = await runCode({
        ...base,
        registry,
        // Point the denied set at the fake home, as production derives it from
        // the real home directory.
        homeDir: fakeHome,
        source: `
          const fs = await import('node:fs');
          try {
            return 'READ_SECRET: ' + fs.readFileSync(${JSON.stringify(
              join(fakeHome, '.ssh', 'id_rsa')
            )}, 'utf8');
          } catch (error) {
            return 'SECRET_REFUSED: ' + String(error);
          }
        `,
        limits: { timeoutMs: 15_000 },
      });
      expect(result.output).toContain('SECRET_REFUSED');
      expect(result.output).not.toContain('READ_SECRET');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('a normal script still works, so the sandbox is not simply refusing everything', async () => {
    // Without this, a policy that denies everything would pass every test above.
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      source: `
        const fs = await import('node:fs');
        fs.writeFileSync('inside.txt', 'ok');
        return fs.readFileSync('inside.txt', 'utf8');
      `,
      limits: { timeoutMs: 15_000 },
    });
    expect(result.status).toBe('completed');
    expect(result.output).toContain('ok');
  });
});

describe('on a platform with no confinement the run is refused, not executed', () => {
  // Windows has no sandbox facility a user process can use, so the only correct
  // behaviour is refusal. Forcing the platform exercises the WHOLE path —
  // resolution, plan, refusal — rather than asserting on planSandbox alone,
  // which would leave the wiring between the host and the plan untested.
  it.each(['win32', 'freebsd', 'sunos', 'aix'] as const)(
    'refuses on %s without spawning anything',
    async (platform) => {
      const { registry, base } = harness([], []);
      const startedAt = Date.now();
      const result = await runCode({
        ...base,
        registry,
        sandboxPlatform: platform,
        // Even a trivial script must not run: the refusal is about the absence
        // of a boundary, not about what the script does.
        source: 'return 1;',
      });
      expect(result.status).toBe('failed');
      expect(result.error).toMatch(/refus/i);
      // Refused fast, before any child could have started and done work.
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(result.toolCalls).toBe(0);
    }
  );

  it('the refusal names the platform and the reason', async () => {
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      sandboxPlatform: 'win32',
      source: 'return 1;',
    });
    expect(result.error).toContain('win32');
  });
});

describe('native memory outside the V8 heap is killed, not just observed', () => {
  // --max-old-space-size does not cover Buffers or ArrayBuffer backing stores,
  // which live in native memory. Without the watchdog a script allocates
  // gigabytes while the heap stays small. With it the host kills the child and
  // says why.
  it('kills a child that allocates native memory past the budget', async () => {
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      source: `
        const blocks = [];
        // fill(1): zero pages stay virtual until written, so an unfixed test
        // would allocate "gigabytes" without any resident page and prove nothing.
        for (let i = 0; i < 40; i++) blocks.push(Buffer.alloc(50 * 1024 * 1024, 1));
        return 'allocated';
      `,
      limits: { timeoutMs: 60_000, maxMemoryBytes: 256 * 1024 * 1024 },
    });
    expect(result.status).toBe('resource_limit');
    expect(result.error).toMatch(/memory budget/i);
    expect(result.output).not.toContain('allocated');
  }, 90_000);

  it('does not kill a script that stays inside its budget', async () => {
    // Without this, a watchdog that kills everything would pass the test above.
    const { registry, base } = harness([], []);
    const result = await runCode({
      ...base,
      registry,
      source: `return 'fine';`,
      limits: { timeoutMs: 15_000, maxMemoryBytes: 256 * 1024 * 1024 },
    });
    expect(result.status).toBe('completed');
  }, 30_000);
});

describe('CPU time beyond the wall clock is killed', () => {
  it('kills a child burning CPU on worker threads past the budget', async () => {
    const { registry, base } = harness([], []);
    // Four workers spinning: CPU seconds accumulate ~4x faster than the wall
    // clock, so a wall-clock timeout alone would let this run the full limit
    // while consuming far more CPU than any legitimate script needs.
    const result = await runCode({
      ...base,
      registry,
      source: `
        const { Worker } = await import('node:worker_threads');
        const code = 'while (true) { Math.sqrt(Math.random()); }';
        for (let i = 0; i < 4; i++) new Worker(code, { eval: true });
        await new Promise(() => {});
      `,
      limits: { timeoutMs: 120_000 },
    });
    // CPU budget is wall clock (120s) + 30s headroom = 150s of CPU; four
    // spinners reach it in ~38s of wall time.
    expect(result.status).toBe('resource_limit');
    expect(result.error).toMatch(/CPU budget/i);
  }, 120_000);
});

describe('the heap cap is clamped into a range Node will actually honour', () => {
  it('converts bytes to whole MiB', () => {
    expect(heapLimitMb(512 * 1024 * 1024)).toBe(512);
    expect(heapLimitMb(300 * 1024 * 1024)).toBe(300);
  });

  it('never rounds a tiny budget down to zero, which Node would ignore', () => {
    // `--max-old-space-size=0` is not "unlimited" in a useful sense and a
    // sub-MiB value would leave the child effectively uncapped while the config
    // claimed otherwise.
    expect(heapLimitMb(1024)).toBe(64);
    expect(heapLimitMb(1)).toBe(64);
  });

  it('clamps a huge request so the cap cannot be disabled by override', () => {
    expect(heapLimitMb(64 * 1024 * 1024 * 1024)).toBe(4096);
  });

  it('falls back to the default for a nonsensical value', () => {
    expect(heapLimitMb(0)).toBe(512);
    expect(heapLimitMb(-1)).toBe(512);
    expect(heapLimitMb(Number.NaN)).toBe(512);
  });
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
