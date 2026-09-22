/**
 * Tests for the runtime-config system-prompt builder extracted from
 * CoworkAgentRunner.run().
 *
 * No Electron and no runner: the module is pure string assembly, so these tests
 * pin the exact prompt templates, the blank-section filtering and — importantly —
 * that no sensitive runtime value can leak into the summary.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRuntimeConfigSummaryPrompt,
  buildWorkspaceInfoPrompt,
  buildUserInstructionsPrompt,
  buildCoworkAppendPrompt,
  type RuntimeConfigSummaryInput,
} from '../src/main/agent/runtime-config-summary';

function config(over: Partial<RuntimeConfigSummaryInput> = {}): RuntimeConfigSummaryInput {
  return {
    modelId: 'claude-sonnet-4',
    provider: 'anthropic',
    contextWindow: 200000,
    maxTokens: 8192,
    thinkingEnabled: true,
    sandboxEnabled: true,
    memoryEnabled: true,
    ...over,
  };
}

describe('buildRuntimeConfigSummaryPrompt', () => {
  it('renders the full configuration block', () => {
    expect(buildRuntimeConfigSummaryPrompt(config())).toBe(
      [
        '<your_configuration>',
        '- Model: claude-sonnet-4',
        '- Provider: anthropic',
        '- Context Window: 200000 tokens',
        '- Max Output Tokens: 8192',
        '- Thinking: enabled',
        '- Sandbox: enabled',
        '- Memory: enabled',
        '</your_configuration>',
      ].join('\n')
    );
  });

  it('falls back to unknown/default when the model omits the limits', () => {
    const prompt = buildRuntimeConfigSummaryPrompt(
      config({ contextWindow: undefined, maxTokens: 0 })
    );
    expect(prompt).toContain('- Context Window: unknown tokens');
    expect(prompt).toContain('- Max Output Tokens: default');
  });

  it('renders disabled flags', () => {
    const prompt = buildRuntimeConfigSummaryPrompt(
      config({ thinkingEnabled: false, sandboxEnabled: false, memoryEnabled: false })
    );
    expect(prompt).toContain('- Thinking: disabled');
    expect(prompt).toContain('- Sandbox: disabled');
    expect(prompt).toContain('- Memory: disabled');
  });

  it('never exposes anything but the whitelisted runtime fields', () => {
    const prompt = buildRuntimeConfigSummaryPrompt(config());
    // The input type has no API key / base URL, but guard the template anyway.
    expect(prompt).not.toMatch(/api[-_]?key|authorization|bearer|base.?url/i);
  });
});

describe('buildWorkspaceInfoPrompt', () => {
  const virtualWorkspacePath = '/workspace';

  it('describes the isolated sandbox with the virtual root', () => {
    const prompt = buildWorkspaceInfoPrompt({
      sandboxIsolated: true,
      sandboxPath: '/tmp/sandbox',
      workingDir: '/Users/me/project',
      virtualWorkspacePath,
    });
    expect(prompt).toBe(
      [
        '<workspace_info>',
        'Your current workspace is located at: /workspace',
        'This is an isolated sandbox environment. Use /workspace as the root path for file operations.',
        '</workspace_info>',
      ].join('\n')
    );
  });

  it('uses the real working directory when not sandboxed', () => {
    expect(
      buildWorkspaceInfoPrompt({
        sandboxIsolated: false,
        sandboxPath: null,
        workingDir: '/Users/me/project',
        virtualWorkspacePath,
      })
    ).toBe('<workspace_info>Your current workspace is: /Users/me/project</workspace_info>');
  });

  it('falls back to the real directory when isolation is on but no sandbox path exists', () => {
    expect(
      buildWorkspaceInfoPrompt({
        sandboxIsolated: true,
        sandboxPath: '',
        workingDir: '/Users/me/project',
        virtualWorkspacePath,
      })
    ).toBe('<workspace_info>Your current workspace is: /Users/me/project</workspace_info>');
  });

  it('is empty when there is neither a sandbox nor a working directory', () => {
    expect(
      buildWorkspaceInfoPrompt({ sandboxIsolated: false, workingDir: null, virtualWorkspacePath })
    ).toBe('');
  });
});

describe('buildUserInstructionsPrompt', () => {
  it('wraps and trims the personal instructions', () => {
    expect(buildUserInstructionsPrompt('  Always answer in French.  ')).toBe(
      [
        '<user_instructions>',
        'The user has provided the following personal instructions. Follow them consistently across the conversation:',
        'Always answer in French.',
        '</user_instructions>',
      ].join('\n')
    );
  });

  it('is empty for blank, absent or non-string instructions', () => {
    expect(buildUserInstructionsPrompt('')).toBe('');
    expect(buildUserInstructionsPrompt('   ')).toBe('');
    expect(buildUserInstructionsPrompt(undefined)).toBe('');
    expect(buildUserInstructionsPrompt(null)).toBe('');
    // Defensive: a legacy config value may not be a string.
    expect(buildUserInstructionsPrompt(42 as unknown as string)).toBe('');
  });
});

describe('buildCoworkAppendPrompt', () => {
  const base = {
    config: config(),
    workspace: { sandboxIsolated: false, workingDir: '/w', virtualWorkspacePath: '/workspace' },
    elitePrompt: 'ELITE',
    strategicPrompt: 'STRATEGIC',
    bundledPathHints: 'BUNDLED',
    extensionSystemContext: 'EXT',
    projectSystemPromptBlock: 'PROJECT',
    userPreferences: 'PREFS',
    errorPatterns: 'ERRORS',
    projectResumption: 'RESUME',
  };

  it('orders the sections and joins them with a blank line', () => {
    const prompt = buildCoworkAppendPrompt(base);
    const order = [
      'You are an Open Cowork assistant. Be concise, accurate, and tool-capable.',
      'CRITICAL BEHAVIORAL RULES:',
      '<your_configuration>',
      '<workspace_info>',
      'ELITE',
      'STRATEGIC',
      'BUNDLED',
      'EXT',
      'PROJECT',
      'PREFS',
      'ERRORS',
      'RESUME',
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = prompt.indexOf(marker);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(prompt).not.toContain('\n\n\n');
  });

  it('drops blank and whitespace-only sections', () => {
    const prompt = buildCoworkAppendPrompt({
      ...base,
      elitePrompt: '',
      strategicPrompt: '   ',
      extensionSystemContext: undefined,
      projectSystemPromptBlock: null,
      userPreferences: '',
      errorPatterns: '',
      projectResumption: '',
    });
    expect(prompt).not.toContain('ELITE');
    expect(prompt).not.toContain('\n\n\n');
    expect(prompt.endsWith('BUNDLED')).toBe(true);
  });

  it('always carries the configuration and the behavioral rules', () => {
    const prompt = buildCoworkAppendPrompt({
      config: config({ sandboxEnabled: false, memoryEnabled: false }),
      workspace: { sandboxIsolated: false, workingDir: '/w', virtualWorkspacePath: '/workspace' },
    });
    expect(prompt).toContain('<your_configuration>');
    expect(prompt).toContain('- Sandbox: disabled');
    expect(prompt).toContain('CRITICAL BEHAVIORAL RULES:');
    expect(prompt).toContain('CHAT FIRST');
  });
});
