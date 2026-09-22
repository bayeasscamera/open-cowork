/**
 * Tests for the pi session event classification / logging helper extracted from
 * the piSession.subscribe() callback.
 *
 * The logger is mocked; telemetry and serializers are injected so every branch
 * and the exact log lines can be pinned without a live session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ log: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

vi.mock('../src/main/utils/logger', () => ({
  log: mocks.log,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

import {
  logSessionStreamEvent,
  type SessionEventLoggingDeps,
} from '../src/main/agent/session-event-logging';

function makeDeps() {
  const recordStreamEvent = vi.fn();
  const getStreamEventSummary = vi.fn(() => ({ text_delta: 3, tool_use: 1 }));
  const stringify = vi.fn((value: unknown, space?: number) => JSON.stringify(value, null, space));
  const summarizeMessage = vi.fn(() => ({ role: 'assistant' }));
  const deps: SessionEventLoggingDeps = {
    telemetry: { recordStreamEvent, getStreamEventSummary },
    stringify,
    summarizeMessage,
  };
  return { deps, recordStreamEvent, getStreamEventSummary, stringify, summarizeMessage };
}

beforeEach(() => {
  mocks.log.mockClear();
});

describe('logSessionStreamEvent', () => {
  it('counts text deltas without logging each one', () => {
    const { deps, recordStreamEvent } = makeDeps();
    logSessionStreamEvent(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta' } },
      deps
    );
    expect(recordStreamEvent).toHaveBeenCalledWith('text_delta');
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('counts thinking deltas without logging each one', () => {
    const { deps, recordStreamEvent } = makeDeps();
    logSessionStreamEvent(
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta' } },
      deps
    );
    expect(recordStreamEvent).toHaveBeenCalledWith('thinking_delta');
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it('counts and logs other assistant updates', () => {
    const { deps, recordStreamEvent } = makeDeps();
    logSessionStreamEvent(
      { type: 'message_update', assistantMessageEvent: { type: 'tool_use' } },
      deps
    );
    expect(recordStreamEvent).toHaveBeenCalledWith('tool_use');
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Event: message_update → tool_use');
  });

  it('defaults to unknown when the update type is missing', () => {
    const { deps, recordStreamEvent } = makeDeps();
    logSessionStreamEvent({ type: 'message_update' }, deps);
    expect(recordStreamEvent).toHaveBeenCalledWith('unknown');
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Event: message_update → unknown');
  });

  it('logs the summarized message on message_start', () => {
    const { deps, stringify, summarizeMessage } = makeDeps();
    const message = { role: 'assistant' };
    logSessionStreamEvent({ type: 'message_start', message }, deps);
    expect(summarizeMessage).toHaveBeenCalledWith(message);
    expect(stringify).toHaveBeenCalledWith({ role: 'assistant' }, 2);
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Event: message_start',
      JSON.stringify({ role: 'assistant' }, null, 2)
    );
  });

  it('logs the message plus the stream summary on message_end', () => {
    const { deps, getStreamEventSummary, stringify } = makeDeps();
    const message = { role: 'assistant' };
    logSessionStreamEvent({ type: 'message_end', message }, deps);
    expect(getStreamEventSummary).toHaveBeenCalledTimes(1);
    const expected = {
      message: { role: 'assistant' },
      messageUpdateCounts: { text_delta: 3, tool_use: 1 },
    };
    expect(stringify).toHaveBeenCalledWith(expected, 2);
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Event: message_end',
      JSON.stringify(expected, null, 2)
    );
  });

  it('logs the bare event type on turn_end', () => {
    const { deps } = makeDeps();
    logSessionStreamEvent({ type: 'turn_end' }, deps);
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Event: turn_end');
  });

  it('logs the bare event type for any other event', () => {
    const { deps } = makeDeps();
    logSessionStreamEvent({ type: 'agent_end' }, deps);
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Event: agent_end');
  });
});
