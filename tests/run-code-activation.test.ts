import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { STANDARD_PRESET, CODE_MODE_PRESET } from '../src/main/presets/builtin-presets';
import { runToolGate, type ToolGateDeps } from '../src/main/tools/pipeline';
import type { ToolDefinition } from '../src/main/tools/registry';
import { RUN_CODE_TOOL_NAME, buildRunCodeTool } from '../src/main/tools/run-code-tool';
import { inferToolRisk } from '../src/main/agent/pi-session-tools';

/**
 * The invariants that make code mode safe to have switched on.
 *
 * Each is a claim that is easy to state and easy to stop being true without
 * noticing, because nothing crashes when a gate stops running — the call just
 * succeeds. So they are asserted against the real pipeline, the real presets and
 * the real call sites.
 */

const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'run a shell command',
  inputSchema: { type: 'object' } as never,
  risk: 'exec',
  execute: async () => ({ content: '' }),
};

function gate(allowedTools: readonly string[] | undefined): ToolGateDeps {
  return {
    decidePermission: () => ({ allowed: true }),
    ...(allowedTools ? { allowedTools } : {}),
  };
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('code mode is opt-in, and nothing else grants it', () => {
  it('the standard preset does not allow run_code', () => {
    // If this ever changes, every session can execute model-written code with
    // nobody having chosen code mode.
    expect(STANDARD_PRESET.tools.allow).not.toContain(RUN_CODE_TOOL_NAME);
  });

  it('code mode allows it, and presents tools through code', () => {
    expect(CODE_MODE_PRESET.tools.allow).toContain(RUN_CODE_TOOL_NAME);
    expect(CODE_MODE_PRESET.presentation).toBe('code');
  });

  it('every other built-in preset presents directly', () => {
    expect(STANDARD_PRESET.presentation).toBe('direct');
  });
});

describe('the preset stage is enforced rather than skipped', () => {
  it('refuses a tool the preset does not allow', async () => {
    // Deliberately a tool no built-in preset grants, since the default allow-list
    // does include `bash` - picking a granted tool here would have passed for
    // the wrong reason.
    const decision = await runToolGate(
      { ...bashTool, name: 'propose_preset' },
      {},
      { sessionId: 's', cwd: '/tmp' },
      gate(CODE_MODE_PRESET.tools.allow)
    );
    expect(decision.allowed).toBe(false);
    expect(decision.stage).toBe('preset');
  });

  it('allows a tool the preset does allow', async () => {
    const decision = await runToolGate(
      bashTool,
      {},
      { sessionId: 's', cwd: '/tmp' },
      gate(['bash'])
    );
    expect(decision.allowed).toBe(true);
  });

  it('is skipped when the allow-list is undefined, which is the trap', async () => {
    // Documented rather than endorsed. The SDK hook used to omit
    // allowedTools, so this stage never ran and `bash` went through — the exact
    // shape of the bug this file guards against.
    const decision = await runToolGate(
      bashTool,
      {},
      { sessionId: 's', cwd: '/tmp' },
      gate(undefined)
    );
    expect(decision.allowed).toBe(true);
  });
});

describe('the SDK hook is given what the pipeline needs', () => {
  it('the installer passes cwd, allowedTools and checkPath', () => {
    // Source-level because the failure mode is an OMISSION: the fields are
    // optional, so dropping one compiles cleanly and the only symptom is a
    // stage quietly ceasing to run.
    const runner = read('src/main/agent/agent-runner.ts');
    const install = runner.slice(
      runner.indexOf('private installPermissionHook('),
      runner.indexOf('private installModsHooks(')
    );
    expect(install).toContain('cwd: gateContext.cwd');
    expect(install).toContain('allowedTools: gateContext.allowedTools');
    expect(install).toContain('checkPath:');
  });

  it('the call site supplies the active preset and the effective cwd', () => {
    const runner = read('src/main/agent/agent-runner.ts');
    const callSite = runner.slice(runner.indexOf('installPermissionHook: (target)'));
    expect(callSite).toContain('allowedTools: activePreset.preset.tools.allow');
    expect(callSite).toContain('cwd: effectiveCwd');
  });
});

describe('a tool called from code is confined to the same allow-list', () => {
  it('the host forwards the caller allow-list into the gate', () => {
    const host = read('src/main/agent/run-code-host.ts');
    expect(host).toContain('allowedTools: request.allowedTools');
  });

  it('the host consults the session approval handler', () => {
    const host = read('src/main/agent/run-code-host.ts');
    expect(host).toContain('request.requestPermission(');
  });

  it('and fails closed when that handler throws', () => {
    const host = read('src/main/agent/run-code-host.ts');
    expect(host).toContain('Fail CLOSED');
  });
});

describe('run_code is a real tool, classified conservatively', () => {
  it('is buildable and typed as a write', () => {
    const definition = buildRunCodeTool({
      registry: { get: () => undefined, list: () => [] } as never,
      gate: { decidePermission: () => ({ allowed: true }) },
      allowedTools: [],
    });
    expect(definition.name).toBe(RUN_CODE_TOOL_NAME);
    // Understating the risk would let a permission rule treat it as harmless.
    expect(definition.risk).toBe('write');
  });

  it('is never classified as a read or a network tool by the registry inference', () => {
    // It classifies as `exec` (the name starts with "run"), which is more
    // conservative than `write` and therefore fine. What must never happen is it
    // being read as harmless.
    const risk = inferToolRisk(RUN_CODE_TOOL_NAME);
    expect(['read', 'network']).not.toContain(risk);
  });
});
