import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPiSessionTools } from '../src/main/agent/pi-session-tools';
import { createSessionGate } from '../src/main/agent/agent-hooks';
import { resolveActivePreset } from '../src/main/agent/preset-context';
import {
  CODE_MODE_PRESET,
  STANDARD_PRESET,
  listBuiltinPresets,
} from '../src/main/presets/builtin-presets';
import { invokeTool } from '../src/main/tools/invoke';
import { toolRegistry } from '../src/main/tools/registry';
import { RUN_CODE_TOOL_NAME } from '../src/main/tools/run-code-tool';

/**
 * The whole path the model actually takes, minus the model.
 *
 * Everything else in the run_code suite tests a unit. This one walks the real
 * chain — preset resolution, session tool assembly, the presenter's filtering,
 * the tool catalog, and finally a real tool invocation through invokeTool with
 * the real gate — because that chain is exactly where the feature was silently
 * broken twice: run_code was allow-listed but never catalogued, and the
 * generated SDK was produced but never shown to the model. Neither failed
 * anything; the preset just looked enabled.
 *
 * The LLM call is the one link not exercised, and it is a link we do not own.
 */

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'cowork-e2e-chain-'));
}

async function assemble(preset: typeof CODE_MODE_PRESET, cwd: string) {
  const gate = createSessionGate({
    allowedTools: preset.tools.allow,
    // run_code is exec-class, so the permission engine asks before it runs. A
    // real session answers through the UI; here the handler approves, and the
    // separate refusal test proves a denial still propagates.
    requestPermission: async () => 'allow',
    getToolDisplayName: (name) => name,
  });

  return buildPiSessionTools({
    sessionId: 'e2e',
    cwd,
    extensionCustomTools: [],
    tavilyApiKey: '',
    braveApiKey: '',
    enrichProcessPath: async () => {},
    preset,
    gateForCode: gate,
  });
}

describe('a code-mode session offers run_code to the model', () => {
  it('resolves to the code-mode preset and carries run_code', () => {
    const resolved = resolveActivePreset({
      projectPresetId: 'code-mode',
      sessionSkillDirs: [],
      loaded: { presets: listBuiltinPresets(), issues: [] },
    });
    expect(resolved.preset.id).toBe('code-mode');
    expect(resolved.preset.tools.allow).toContain(RUN_CODE_TOOL_NAME);
  });

  it('puts run_code in the tool set handed to the model', async () => {
    const cwd = workspace();
    try {
      const { wrappedTools, customTools } = await assemble(CODE_MODE_PRESET, cwd);
      // In code mode run_code arrives as a custom tool, not an SDK tool, so
      // asserting only on wrappedTools would pass while the model got nothing.
      const offered = [...wrappedTools, ...customTools].map((t) => t.name);
      expect(offered).toContain(RUN_CODE_TOOL_NAME);
      // And it is not also offered as a direct SDK tool, which would let the
      // model call it without the SDK it was supposed to use.
      expect(wrappedTools.map((t) => t.name)).not.toContain(RUN_CODE_TOOL_NAME);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  it('a code-mode session still offers SOME tools, however they are presented', async () => {
    // The regression this guards: presenting only the SDK subset left a
    // code-mode session with an empty catalog, so the model had no run_code and
    // no direct tools - silently, with nothing to fail.
    const cwd = workspace();
    try {
      const { wrappedTools, customTools, codeSdkSource } = await assemble(CODE_MODE_PRESET, cwd);
      const offered = [...wrappedTools, ...customTools].map((t) => t.name);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered).toContain(RUN_CODE_TOOL_NAME);
      // In code mode the individual tools live in the generated SDK instead.
      expect(codeSdkSource).toContain('tools');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  it('does NOT offer run_code in a standard session', async () => {
    // The single most important negative: the default session must be unable to
    // execute model-written code.
    const cwd = workspace();
    try {
      const { wrappedTools, customTools } = await assemble(STANDARD_PRESET, cwd);
      expect([...wrappedTools, ...customTools].map((t) => t.name)).not.toContain(
        RUN_CODE_TOOL_NAME
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  it('shows the model the generated SDK it is expected to drive', async () => {
    const cwd = workspace();
    try {
      const { promptSection } = await assemble(CODE_MODE_PRESET, cwd);
      expect(promptSection.length).toBeGreaterThan(0);
      expect(promptSection).toContain('run_code');
      // The SDK itself, not just a mention of it.
      expect(promptSection).toMatch(/tools\./);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a tool call the model makes from code is gated like any other', () => {
  it('a permitted call from code executes', async () => {
    const cwd = workspace();
    try {
      const gate = createSessionGate({
        allowedTools: CODE_MODE_PRESET.tools.allow,
        requestPermission: async () => 'allow',
        getToolDisplayName: (name) => name,
      });
      await assemble(CODE_MODE_PRESET, cwd);

      // The real registry entry, invoked through the real funnel.
      const result = await invokeTool(
        toolRegistry,
        RUN_CODE_TOOL_NAME,
        { source: 'const n: number = 20 + 22; return `got ${n}`;' },
        { sessionId: 'e2e', cwd },
        gate
      );
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('got 42');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  it('a tool the preset forbids is still refused from code', async () => {
    const cwd = workspace();
    try {
      const gate = createSessionGate({
        allowedTools: [RUN_CODE_TOOL_NAME],
        requestPermission: async () => 'allow',
        getToolDisplayName: (name) => name,
      });
      await assemble(CODE_MODE_PRESET, cwd);

      const result = await invokeTool(
        toolRegistry,
        'propose_preset',
        { title: 'x' },
        { sessionId: 'e2e', cwd },
        gate
      );
      expect(result.isError).toBeTruthy();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);

  it('a script cannot escape the workspace through the full chain', async () => {
    const cwd = workspace();
    try {
      const gate = createSessionGate({
        allowedTools: CODE_MODE_PRESET.tools.allow,
        requestPermission: async () => 'allow',
        getToolDisplayName: (name) => name,
      });
      await assemble(CODE_MODE_PRESET, cwd);

      const result = await invokeTool(
        toolRegistry,
        RUN_CODE_TOOL_NAME,
        {
          source: `
            const fs = await import('node:fs');
            try {
              fs.writeFileSync('/tmp/cowork-chain-escape.txt', 'x');
              return 'ESCAPED';
            } catch (error) {
              return 'REFUSED';
            }
          `,
        },
        { sessionId: 'e2e', cwd },
        gate
      );
      expect(result.content).toContain('REFUSED');
      expect(result.content).not.toContain('ESCAPED');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 90_000);
});