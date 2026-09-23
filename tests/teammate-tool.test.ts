/**
 * Tests for the OPT-IN `ask_teammate` tool and its one-shot responder.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/agent/sdk-one-shot', () => ({
  runPiAiOneShot: vi.fn(),
}));

import { runPiAiOneShot } from '../src/main/agent/sdk-one-shot';
import type { AppConfig } from '../src/main/config/config-store';
import type { AgentTask } from '../src/main/agent/multi-agent-coordinator';
import {
  __resetTeammateTeamsForTest,
  askTeammate,
  getTeammateTeam,
  markTeammateBoundary,
  registerTeammate,
} from '../src/main/agent/teammate-bus';
import {
  ASK_TEAMMATE_TOOL_NAME,
  ASK_TEAMMATE_TRIGGER_RULE,
  buildAskTeammateTool,
  buildTeammateResponder,
} from '../src/main/agent/teammate-tool';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

const TARGET_ROLES = ['architect', 'reviewer', 'security'];

function makeTask(): AgentTask {
  return {
    id: 'dev-1',
    role: 'developer',
    title: 'Implement the service',
    prompt: 'Implement the service',
    status: 'pending',
  };
}

describe('ask_teammate tool', () => {
  beforeEach(() => {
    __resetTeammateTeamsForTest();
    vi.mocked(runPiAiOneShot).mockReset();
  });

  it('exposes the tool with the blocking-only trigger rule and the hard cap', () => {
    const team = getTeammateTeam('team-a');
    const tool = buildAskTeammateTool({
      team,
      role: 'developer',
      taskId: 'dev-1',
      targetRoles: TARGET_ROLES,
    });

    expect(tool.name).toBe(ASK_TEAMMATE_TOOL_NAME);
    expect(tool.description).toContain(ASK_TEAMMATE_TRIGGER_RULE);
    expect(tool.description).toContain('At most 2 questions per task');
    expect(tool.parameters).toBeDefined();
  });

  it('returns the teammate answer so a blocked agent can continue', async () => {
    const team = getTeammateTeam('team-a');
    registerTeammate(team, {
      role: 'architect',
      taskId: 'arch-1',
      responder: async () => 'Expose it through the existing DI container.',
    });
    const tool = buildAskTeammateTool({
      team,
      role: 'developer',
      taskId: 'dev-1',
      targetRoles: TARGET_ROLES,
    });

    const pending = tool.execute('call-1', {
      target_role: 'architect',
      question: 'How should I expose the new service?',
    }) as Promise<ToolResult>;
    markTeammateBoundary(team, 'arch-1');
    const result = await pending;

    expect(result.content[0].text).toContain('Answer from the "architect" teammate');
    expect(result.content[0].text).toContain('DI container');
    expect(result.details).toMatchObject({ ok: true, status: 'answered', modelCalls: 1 });
  });

  it('degrades to a continue instruction when no teammate holds the role', async () => {
    const team = getTeammateTeam('team-a');
    const tool = buildAskTeammateTool({
      team,
      role: 'developer',
      taskId: 'dev-1',
      targetRoles: TARGET_ROLES,
    });

    const result = (await tool.execute('call-1', {
      target_role: 'security',
      question: 'Is the endpoint authenticated?',
    })) as ToolResult;

    expect(result.content[0].text).toContain('No "security" teammate is available');
    expect(result.details).toMatchObject({ ok: false, status: 'unavailable', modelCalls: 0 });
  });

  it('refuses an incomplete call without spending a teammate question', async () => {
    const team = getTeammateTeam('team-a');
    const tool = buildAskTeammateTool({
      team,
      role: 'developer',
      taskId: 'dev-1',
      targetRoles: TARGET_ROLES,
    });

    const result = (await tool.execute('call-1', {
      target_role: 'architect',
      question: '   ',
    })) as ToolResult;

    expect(result.details).toMatchObject({ ok: false, status: 'invalid' });
    // askTeammate was never reached, so the two-call budget is untouched.
    expect(getTeammateTeam('team-a').calls.get('dev-1')).toBeUndefined();
  });

  it('returns the limit fallback once the two questions are spent', async () => {
    const team = getTeammateTeam('team-a');
    registerTeammate(team, {
      role: 'architect',
      taskId: 'arch-1',
      responder: async () => 'answer',
    });
    const tool = buildAskTeammateTool({
      team,
      role: 'developer',
      taskId: 'dev-1',
      targetRoles: TARGET_ROLES,
    });
    for (let i = 0; i < 2; i += 1) {
      const pending = tool.execute('c', { target_role: 'architect', question: 'q' }) as Promise<ToolResult>;
      markTeammateBoundary(team, 'arch-1');
      await pending;
    }
    const third = (await tool.execute('c', {
      target_role: 'architect',
      question: 'q',
    })) as ToolResult;
    expect(third.content[0].text).toContain('limit reached');
    expect(third.details).toMatchObject({ ok: false, status: 'limit', modelCalls: 0 });
  });

  it('budget is per asker task, not shared across the team', async () => {
    const team = getTeammateTeam('team-a');
    registerTeammate(team, { role: 'architect', taskId: 'arch-1', responder: async () => 'a' });
    const other = buildAskTeammateTool({
      team,
      role: 'reviewer',
      taskId: 'rev-1',
      targetRoles: TARGET_ROLES,
    });
    const pending = other.execute('c', { target_role: 'architect', question: 'q' }) as Promise<ToolResult>;
    markTeammateBoundary(team, 'arch-1');
    await pending;
    expect(team.calls.get('rev-1')).toBe(1);
    expect(team.calls.get('dev-1')).toBeUndefined();
    // Sanity: the direct bus entry point agrees with the tool.
    const direct = askTeammate(team, {
      fromRole: 'reviewer',
      fromTaskId: 'rev-1',
      targetRole: 'architect',
      question: 'q2',
    });
    markTeammateBoundary(team, 'arch-1');
    expect(await direct).toMatchObject({ status: 'answered' });
  });
});

describe('teammate responder', () => {
  beforeEach(() => {
    vi.mocked(runPiAiOneShot).mockReset();
  });

  it('answers with one bounded one-shot call, grounded in the target task', async () => {
    const controller = new AbortController();
    vi.mocked(runPiAiOneShot).mockResolvedValue({
      text: '  Use FooService.  ',
      hasThinking: false,
      durationMs: 5,
    });
    const responder = buildTeammateResponder({
      task: { ...makeTask(), role: 'architect', title: 'Design the module' },
      // The responder only forwards this config; a stub keeps the test offline.
      config: { provider: 'anthropic', model: 'test' } as unknown as AppConfig,
      getContext: () => 'The module exposes two ports.',
    });

    const answer = await responder('Which port?', {
      askedByRole: 'developer',
      askedByTaskId: 'dev-1',
      signal: controller.signal,
    });

    expect(answer).toBe('Use FooService.');
    expect(runPiAiOneShot).toHaveBeenCalledTimes(1);
    const [prompt, systemPrompt, , options] = vi.mocked(runPiAiOneShot).mock.calls[0];
    expect(systemPrompt).toContain('one-shot answer');
    expect(prompt).toContain('Which port?');
    expect(prompt).toContain('The module exposes two ports.');
    expect(prompt).toContain('Design the module');
    expect(options?.signal).toBe(controller.signal);
  });
});
