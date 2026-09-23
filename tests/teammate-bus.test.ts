/**
 * Unit tests for the opt-in teammate question bus: the hard per-task limit,
 * the always-resolving deadline, the zero-cost failure modes and the audit
 * trail the swarm cost report is built from.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TEAMMATE_CALLS_PER_TASK,
  TEAMMATE_LIMIT_FALLBACK,
  TEAMMATE_TIMEOUT_FALLBACK,
  TEAMMATE_UNAVAILABLE_FALLBACK,
  __resetTeammateTeamsForTest,
  askTeammate,
  callsUsed,
  countTeammateModelCalls,
  disposeTeammateTeam,
  drainTeammate,
  formatTeammateReportSection,
  getTeammateExchanges,
  getTeammateTeam,
  markTeammateBoundary,
  registerTeammate,
  summarizeTeammateExchanges,
  unregisterTeammate,
} from '../src/main/agent/teammate-bus';

const TARGET = { role: 'architect', taskId: 'arch-1' };

describe('teammate-bus', () => {
  beforeEach(() => {
    __resetTeammateTeamsForTest();
  });

  it('answers a blocked agent at the target boundary, costing one model call', async () => {
    const team = getTeammateTeam('team-a');
    const responder = vi.fn(async () => 'Inject FooService through the container.');
    registerTeammate(team, { ...TARGET, responder });

    const pending = askTeammate(team, {
      fromRole: 'developer',
      fromTaskId: 'dev-1',
      targetRole: 'architect',
      question: 'Which service should I inject?',
    });

    // The target has not reached a boundary yet: no answer, no model call spent.
    expect(responder).not.toHaveBeenCalled();

    markTeammateBoundary(team, TARGET.taskId);
    const exchange = await pending;

    expect(exchange.status).toBe('answered');
    expect(exchange.answer).toContain('FooService');
    expect(exchange.modelCalls).toBe(1);
    expect(exchange.fromRole).toBe('developer');
    expect(exchange.targetRole).toBe('architect');
    expect(responder).toHaveBeenCalledTimes(1);
    expect(callsUsed(team, 'dev-1')).toBe(1);
    expect(countTeammateModelCalls(team)).toBe(1);
  });

  it('enforces the hard limit of 2 questions per task without extra model calls', async () => {
    const team = getTeammateTeam('team-a');
    const responder = vi.fn(async () => 'answer');
    registerTeammate(team, { ...TARGET, responder });

    const ask = () =>
      askTeammate(team, {
        fromRole: 'developer',
        fromTaskId: 'dev-1',
        targetRole: 'architect',
        question: 'q',
      });
    const first = ask();
    markTeammateBoundary(team, TARGET.taskId);
    expect((await first).status).toBe('answered');

    const second = ask();
    markTeammateBoundary(team, TARGET.taskId);
    expect((await second).status).toBe('answered');

    // Third call is refused BEFORE enqueueing: no responder call, no cost.
    const third = await ask();
    expect(third.status).toBe('limit');
    expect(third.answer).toBe(TEAMMATE_LIMIT_FALLBACK);
    expect(third.modelCalls).toBe(0);
    expect(responder).toHaveBeenCalledTimes(MAX_TEAMMATE_CALLS_PER_TASK);
    expect(callsUsed(team, 'dev-1')).toBe(MAX_TEAMMATE_CALLS_PER_TASK);
  });

  it('resolves the deadline with a continue instruction and costs nothing', async () => {
    const team = getTeammateTeam('team-a');
    const responder = vi.fn(async () => 'never called');
    registerTeammate(team, { ...TARGET, responder });

    const exchange = await askTeammate(team, {
      fromRole: 'developer',
      fromTaskId: 'dev-1',
      targetRole: 'architect',
      question: 'q',
      timeoutMs: 10,
    });

    expect(exchange.status).toBe('timeout');
    expect(exchange.answer).toBe(TEAMMATE_TIMEOUT_FALLBACK);
    expect(exchange.modelCalls).toBe(0);
    // The question still spends one of the two allowed calls.
    expect(callsUsed(team, 'dev-1')).toBe(1);
    // It is dropped from the queue: a later boundary must not answer it twice.
    expect(team.members.get(TARGET.taskId)?.queue).toHaveLength(0);
  });

  it('counts an unknown target role as unavailable but still spends the call', async () => {
    const team = getTeammateTeam('team-a');
    const exchange = await askTeammate(team, {
      fromRole: 'developer',
      fromTaskId: 'dev-1',
      targetRole: 'security',
      question: 'q',
    });

    expect(exchange.status).toBe('unavailable');
    expect(exchange.answer).toBe(TEAMMATE_UNAVAILABLE_FALLBACK);
    expect(exchange.modelCalls).toBe(0);
    // Counting before target resolution is what makes the cap unbypassable.
    expect(callsUsed(team, 'dev-1')).toBe(1);
  });

  it('keeps the timeout verdict even when a slow responder answers too late', async () => {
    const team = getTeammateTeam('team-a');
    registerTeammate(team, {
      ...TARGET,
      responder: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return 'too late';
      },
    });

    const pending = askTeammate(team, {
      fromRole: 'developer',
      fromTaskId: 'dev-1',
      targetRole: 'architect',
      question: 'q',
      timeoutMs: 10,
    });
    markTeammateBoundary(team, TARGET.taskId);

    const exchange = await pending;
    expect(exchange.status).toBe('timeout');
    expect(exchange.modelCalls).toBe(0);
  });

  it('unregisters a finished teammate and degrades its queued questions', async () => {
    const team = getTeammateTeam('team-a');
    registerTeammate(team, { ...TARGET, responder: async () => 'answer' });

    const pending = askTeammate(team, {
      fromRole: 'developer',
      fromTaskId: 'dev-1',
      targetRole: 'architect',
      question: 'q',
    });
    unregisterTeammate(team, TARGET.taskId);

    expect((await pending).status).toBe('unavailable');
    expect(team.members.has(TARGET.taskId)).toBe(false);
    // Later questions find no member at all.
    const after = await askTeammate(team, {
      fromRole: 'developer',
      fromTaskId: 'dev-1',
      targetRole: 'architect',
      question: 'q2',
    });
    expect(after.status).toBe('unavailable');
  });

  it('disposes a team and resolves everything still queued', async () => {
    const team = getTeammateTeam('team-a');
    registerTeammate(team, { ...TARGET, responder: async () => 'answer' });
    const pending = askTeammate(team, {
      fromRole: 'developer',
      fromTaskId: 'dev-1',
      targetRole: 'architect',
      question: 'q',
    });

    disposeTeammateTeam('team-a');

    expect((await pending).status).toBe('unavailable');
    expect(getTeammateTeam('team-a').members.size).toBe(0);
  });

  it('drains a boundary with no member or no queue without throwing', async () => {
    const team = getTeammateTeam('team-a');
    markTeammateBoundary(team, 'missing');
    await expect(drainTeammate(team, 'missing')).resolves.toBeUndefined();
    registerTeammate(team, { ...TARGET, responder: async () => 'answer' });
    await expect(drainTeammate(team, TARGET.taskId)).resolves.toBeUndefined();
  });

  it('traces exchanges and formats the report section', async () => {
    const team = getTeammateTeam('team-a');
    registerTeammate(team, { ...TARGET, responder: async () => 'the answer' });

    expect(formatTeammateReportSection([])).toBe('');

    const pending = askTeammate(team, {
      fromRole: 'developer',
      fromTaskId: 'dev-1',
      targetRole: 'architect',
      question: 'Which port?',
    });
    markTeammateBoundary(team, TARGET.taskId);
    await pending;
    await askTeammate(team, {
      fromRole: 'developer',
      fromTaskId: 'dev-1',
      targetRole: 'security',
      question: 'Anything else?',
    });

    const exchanges = getTeammateExchanges(team);
    expect(exchanges).toHaveLength(2);
    const summary = summarizeTeammateExchanges(exchanges);
    expect(summary).toEqual({
      exchanges: 2,
      answered: 1,
      timeouts: 0,
      unavailable: 1,
      limited: 0,
      modelCalls: 1,
    });

    const section = formatTeammateReportSection(exchanges);
    expect(section).toContain('Teammate questions');
    expect(section).toContain('Which port?');
    expect(section).toContain('the answer');
    expect(section).toContain('1 extra model call(s)');
  });
});
