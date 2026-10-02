import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { STANDARD_PRESET, CODE_MODE_PRESET } from '../src/main/presets/builtin-presets';
import { runToolGate, type ToolGateDeps } from '../src/main/tools/pipeline';
import type { ToolDefinition } from '../src/main/tools/registry';
import { RUN_CODE_TOOL_NAME, buildRunCodeTool } from '../src/main/tools/run-code-tool';
import { inferToolRisk } from '../src/main/agent/pi-session-tools';
import { presenterFor } from '../src/main/presets/tool-presenter';

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

describe('code mode actually reaches the model', () => {
  // The gaps this guards: run_code was in the preset allow-list but never in the
  // session catalog, so the presenter filtered out a tool the preset permitted
  // and the model was never offered it. And the generated SDK was returned but
  // never appended, so even once offered the model had no idea what `tools` is.
  // Both are silent: nothing throws, the preset simply looks enabled.

  it('run_code is added to the catalog before presentation, not after', () => {
    const source = read('src/main/agent/pi-session-tools.ts');
    const catalogAt = source.indexOf('const catalog = [...codingTools');
    const presentAt = source.indexOf('presentToolsForPreset(');
    expect(catalogAt).toBeGreaterThan(-1);
    expect(presentAt).toBeGreaterThan(catalogAt);
    // The definition is built and included in the catalog.
    expect(source).toMatch(/const catalog = \[\.\.\.codingTools, \.\.\.customTools, \.\.\.\(runCodeDefinition/);
  });

  it('its real executor is registered, not just catalogued', () => {
    const source = read('src/main/agent/pi-session-tools.ts');
    expect(source).toContain('registerRunCodeExecutor({');
  });

  it('the runner supplies the gate, so the tool has a policy', () => {
    const source = read('src/main/agent/agent-runner.ts');
    expect(source).toContain('gateForCode: createSessionGate({');
    expect(source).toContain('allowedTools: activePreset.preset.tools.allow');
  });

  it('the generated SDK is appended to the prompt', () => {
    const source = read('src/main/agent/agent-runner.ts');
    expect(source).toContain('coworkAppendPrompt: coworkAppendPrompt + codePresentationPrompt');
  });

  it('the prompt section is produced from the presented catalog', () => {
    const source = read('src/main/agent/pi-session-tools.ts');
    // The prompt is generated from the SAME tools that were presented, so the
    // SDK the model is shown cannot describe tools it was not given.
    expect(source).toContain(
      'promptSection: deps.preset ? presenterFor(deps.preset).promptSection(presentableTools)'
    );
  });

  it('the presentation input includes run_code, or code mode shows nothing', () => {
    // The third silent failure in this chain: presenting only the SDK's tools
    // left a code-mode session with an empty catalog, because in code mode every
    // tool is hidden behind run_code - the one tool the SDK does not provide.
    const source = read('src/main/agent/pi-session-tools.ts');
    expect(source).toMatch(
      /const presentable = \[\.\.\.wrappedTools, \.\.\.\(runCodeDefinition \? \[runCodeDefinition\] : \[\]\)\]/
    );
  });

  it('a code-mode preset yields a non-empty SDK section mentioning the tools proxy', () => {
    const tools: ToolDefinition[] = [
      { ...bashTool, name: 'read' },
      { ...bashTool, name: 'write' },
    ];
    const section = presenterFor(CODE_MODE_PRESET).promptSection(tools);
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain('run_code');
    expect(section).toContain('tools.');
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
