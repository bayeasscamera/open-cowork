/**
 * @module tests/creator-mode
 *
 * Tests for the Creator Mode tools: `create_task_skill` and `install_plugin`.
 *
 * These tools let the agent autonomously create workspace skills and install
 * plugins mid-task without human approval.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildAgentMetaTools } from '../src/main/tools/dynamic-tool-creator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCallId() {
  return `tc-${Math.random().toString(36).slice(2)}`;
}

function findTool(tools: ReturnType<typeof buildAgentMetaTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found in meta-tools`);
  return tool;
}

// ---------------------------------------------------------------------------
// create_task_skill
// ---------------------------------------------------------------------------

describe('create_task_skill', () => {
  let tmpDir: string;
  let sessionManagerMock: { invalidateSkillsSetup: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-creator-test-'));
    sessionManagerMock = { invalidateSkillsSetup: vi.fn() };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates SKILL.md in .claude/skills/<name>/', async () => {
    const tools = buildAgentMetaTools({
      cwd: tmpDir,
      sessionManager: sessionManagerMock,
    });
    const tool = findTool(tools, 'create_task_skill');

    const skillContent = `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This skill does something useful.
`;

    const result = await tool.execute(makeToolCallId(), {
      skillName: 'test_skill',
      skillContent,
    });

    expect(result.details).toMatchObject({ success: true, skillName: 'test_skill' });
    const skillMdPath = path.join(tmpDir, '.claude', 'skills', 'test_skill', 'SKILL.md');
    expect(fs.existsSync(skillMdPath)).toBe(true);
    expect(fs.readFileSync(skillMdPath, 'utf8')).toBe(skillContent);
  });

  it('writes extraFiles within the skill directory', async () => {
    const tools = buildAgentMetaTools({ cwd: tmpDir, sessionManager: sessionManagerMock });
    const tool = findTool(tools, 'create_task_skill');

    await tool.execute(makeToolCallId(), {
      skillName: 'my_skill',
      skillContent: '---\nname: my-skill\ndescription: test\n---\n',
      extraFiles: [
        { relativePath: 'scripts/run.sh', content: '#!/bin/bash\necho hello' },
        { relativePath: 'config.json', content: '{}' },
      ],
    });

    expect(
      fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'my_skill', 'scripts', 'run.sh'))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'my_skill', 'config.json'))
    ).toBe(true);
  });

  it('rejects path traversal in extraFiles', async () => {
    const tools = buildAgentMetaTools({ cwd: tmpDir, sessionManager: sessionManagerMock });
    const tool = findTool(tools, 'create_task_skill');

    await tool.execute(makeToolCallId(), {
      skillName: 'bad_skill',
      skillContent: '---\nname: bad\ndescription: test\n---\n',
      extraFiles: [
        { relativePath: '../../../etc/passwd', content: 'malicious' },
        { relativePath: '/etc/passwd', content: 'malicious' },
      ],
    });

    // Traversal files must NOT be written
    expect(fs.existsSync('/etc/passwd-cowork')).toBe(false);
    const skillDir = path.join(tmpDir, '.claude', 'skills', 'bad_skill');
    // Only SKILL.md should exist
    const written = fs.readdirSync(skillDir);
    expect(written).toEqual(['SKILL.md']);
  });

  it('sanitises skill name: special chars become underscores', async () => {
    const tools = buildAgentMetaTools({ cwd: tmpDir, sessionManager: sessionManagerMock });
    const tool = findTool(tools, 'create_task_skill');

    await tool.execute(makeToolCallId(), {
      skillName: 'my skill/with bad chars!',
      skillContent: '---\nname: sanitised\ndescription: test\n---\n',
    });

    const expected = 'my_skill_with_bad_chars_';
    expect(
      fs.existsSync(path.join(tmpDir, '.claude', 'skills', expected, 'SKILL.md'))
    ).toBe(true);
  });

  it('calls sessionManager.invalidateSkillsSetup() after creation', async () => {
    const tools = buildAgentMetaTools({ cwd: tmpDir, sessionManager: sessionManagerMock });
    const tool = findTool(tools, 'create_task_skill');

    await tool.execute(makeToolCallId(), {
      skillName: 'inv_skill',
      skillContent: '---\nname: inv-skill\ndescription: test\n---\n',
    });

    expect(sessionManagerMock.invalidateSkillsSetup).toHaveBeenCalledOnce();
  });

  it('returns error text when skillName is empty after sanitisation', async () => {
    const tools = buildAgentMetaTools({ cwd: tmpDir });
    const tool = findTool(tools, 'create_task_skill');

    // All chars stripped → safeName is '' → invalid
    const result = await tool.execute(makeToolCallId(), {
      skillName: '',
      skillContent: '',
    });

    expect(result.details).toMatchObject({ success: false });
    expect((result.content[0] as { text: string }).text).toMatch(/Invalid skill name/);
  });
});

// ---------------------------------------------------------------------------
// install_plugin
// ---------------------------------------------------------------------------

describe('install_plugin', () => {
  let pluginServiceMock: { install: ReturnType<typeof vi.fn> };
  let sessionManagerMock: { invalidateSkillsSetup: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    pluginServiceMock = { install: vi.fn().mockResolvedValue(undefined) };
    sessionManagerMock = { invalidateSkillsSetup: vi.fn() };
  });

  it('calls pluginRuntimeService.install with sanitised id', async () => {
    const tools = buildAgentMetaTools({
      pluginRuntimeService: pluginServiceMock,
      sessionManager: sessionManagerMock,
    });
    const tool = findTool(tools, 'install_plugin');

    const result = await tool.execute(makeToolCallId(), { pluginId: 'my-plugin' });

    expect(pluginServiceMock.install).toHaveBeenCalledWith('my-plugin');
    expect(result.details).toMatchObject({ success: true, pluginId: 'my-plugin' });
  });

  it('invalidates skills setup after successful install', async () => {
    const tools = buildAgentMetaTools({
      pluginRuntimeService: pluginServiceMock,
      sessionManager: sessionManagerMock,
    });
    const tool = findTool(tools, 'install_plugin');

    await tool.execute(makeToolCallId(), { pluginId: 'my-plugin' });

    expect(sessionManagerMock.invalidateSkillsSetup).toHaveBeenCalledOnce();
  });

  it('returns graceful error when no pluginRuntimeService injected', async () => {
    const tools = buildAgentMetaTools({ sessionManager: sessionManagerMock });
    const tool = findTool(tools, 'install_plugin');

    const result = await tool.execute(makeToolCallId(), { pluginId: 'some-plugin' });

    expect(result.details).toMatchObject({ success: false, reason: 'no_plugin_service' });
  });

  it('sanitises plugin id: strips invalid chars', async () => {
    const tools = buildAgentMetaTools({
      pluginRuntimeService: pluginServiceMock,
      sessionManager: sessionManagerMock,
    });
    const tool = findTool(tools, 'install_plugin');

    await tool.execute(makeToolCallId(), { pluginId: 'my-plugin; rm -rf /' });

    expect(pluginServiceMock.install).toHaveBeenCalledWith('my-pluginrm-rf');
  });

  it('returns error text when pluginId is empty after sanitisation', async () => {
    const tools = buildAgentMetaTools({ pluginRuntimeService: pluginServiceMock });
    const tool = findTool(tools, 'install_plugin');

    const result = await tool.execute(makeToolCallId(), { pluginId: ';;;' });

    expect(result.details).toMatchObject({ success: false });
    expect((result.content[0] as { text: string }).text).toMatch(/Invalid plugin ID/);
  });

  it('returns error when install throws', async () => {
    pluginServiceMock.install.mockRejectedValue(new Error('Network error'));
    const tools = buildAgentMetaTools({
      pluginRuntimeService: pluginServiceMock,
      sessionManager: sessionManagerMock,
    });
    const tool = findTool(tools, 'install_plugin');

    const result = await tool.execute(makeToolCallId(), { pluginId: 'bad-plugin' });

    expect(result.details).toMatchObject({ success: false, error: 'Network error' });
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_TOOL_ALLOW includes Creator Mode tools
// ---------------------------------------------------------------------------

describe('builtin-presets Creator Mode inclusion', () => {
  it('standard preset includes create_task_skill and install_plugin', async () => {
    const { STANDARD_PRESET } = await import('../src/main/presets/builtin-presets');
    expect(STANDARD_PRESET.tools.allow).toContain('create_task_skill');
    expect(STANDARD_PRESET.tools.allow).toContain('install_plugin');
  });
});
