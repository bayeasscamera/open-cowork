/**
 * Tests for the stream liveness watcher extracted from CoworkAgentRunner.run().
 *
 * The module is effect-free: timers, clock and callbacks are all injectable, so
 * these tests drive the real policy with fake timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  createStreamLivenessWatcher,
  type StreamLivenessOptions,
} from '../src/main/agent/stream-liveness';

interface Harness {
  options: StreamLivenessOptions;
  isAborted: ReturnType<typeof vi.fn>;
  onColdStartWaiting: ReturnType<typeof vi.fn>;
  onFirstStreamEvent: ReturnType<typeof vi.fn>;
  onActivityTimeout: ReturnType<typeof vi.fn>;
}

const PROMPT_STARTED_AT = 1000;

const buildHarness = (over: Partial<StreamLivenessOptions> = {}): Harness => {
  const isAborted = vi.fn(() => false);
  const onColdStartWaiting = vi.fn();
  const onFirstStreamEvent = vi.fn();
  const onActivityTimeout = vi.fn();
  const options: StreamLivenessOptions = {
    promptStartedAt: PROMPT_STARTED_AT,
    isAborted,
    onColdStartWaiting,
    onFirstStreamEvent,
    onActivityTimeout,
    ...over,
  };
  return { options, isAborted, onColdStartWaiting, onFirstStreamEvent, onActivityTimeout };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(PROMPT_STARTED_AT);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createStreamLivenessWatcher', () => {
  it('warns when an Ollama model produced no event after 10 seconds', () => {
    const h = buildHarness({ provider: 'ollama' });
    createStreamLivenessWatcher(h.options);

    vi.advanceTimersByTime(9_999);
    expect(h.onColdStartWaiting).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(h.onColdStartWaiting).toHaveBeenCalledTimes(1);
  });

  it('does not warn for other providers or without a provider', () => {
    createStreamLivenessWatcher(buildHarness({ provider: 'openai' }).options);
    createStreamLivenessWatcher(buildHarness().options);

    vi.advanceTimersByTime(60_000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays silent when the run was aborted before the warning fires', () => {
    const h = buildHarness({ provider: 'ollama' });
    h.isAborted.mockReturnValue(true);
    createStreamLivenessWatcher(h.options);

    vi.advanceTimersByTime(10_000);

    expect(h.onColdStartWaiting).not.toHaveBeenCalled();
  });

  it('cancels the warning on the first event and reports its latency', () => {
    const h = buildHarness({ provider: 'ollama' });
    const watcher = createStreamLivenessWatcher(h.options);

    vi.advanceTimersByTime(250);
    watcher.markFirstStreamEvent('text_delta');

    expect(h.onFirstStreamEvent).toHaveBeenCalledWith({
      eventType: 'text_delta',
      latencyMs: 250,
    });

    vi.advanceTimersByTime(60_000);
    expect(h.onColdStartWaiting).not.toHaveBeenCalled();
  });

  it('reports only the first event', () => {
    const h = buildHarness();
    const watcher = createStreamLivenessWatcher(h.options);

    watcher.markFirstStreamEvent('text_delta');
    vi.advanceTimersByTime(500);
    watcher.markFirstStreamEvent('thinking_delta');

    expect(h.onFirstStreamEvent).toHaveBeenCalledTimes(1);
    expect(h.onFirstStreamEvent).toHaveBeenCalledWith({ eventType: 'text_delta', latencyMs: 0 });
    expect(watcher.getFirstStreamLatencyMs()).toBe(0);
  });

  it('reports no first event before anything arrives', () => {
    const h = buildHarness();
    const watcher = createStreamLivenessWatcher(h.options);

    expect(watcher.hasReceivedFirstStreamEvent()).toBe(false);
    expect(watcher.getFirstStreamLatencyMs()).toBeNull();
  });

  it('does not start the inactivity countdown on its own', () => {
    const h = buildHarness();
    createStreamLivenessWatcher(h.options);

    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(h.onActivityTimeout).not.toHaveBeenCalled();
  });

  it('aborts after five minutes without activity', () => {
    const h = buildHarness();
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.resetActivityTimeout();

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(h.onActivityTimeout).toHaveBeenCalledTimes(1);

    // The timeout is one-shot: it must not keep firing.
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(h.onActivityTimeout).toHaveBeenCalledTimes(1);
  });

  it('restarts the countdown on every activity signal', () => {
    const h = buildHarness();
    const watcher = createStreamLivenessWatcher(h.options);

    watcher.resetActivityTimeout();
    vi.advanceTimersByTime(4 * 60 * 1000);
    watcher.resetActivityTimeout();
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(h.onActivityTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60 * 1000);
    expect(h.onActivityTimeout).toHaveBeenCalledTimes(1);
  });

  it('dispose stops both timers', () => {
    const h = buildHarness({ provider: 'ollama' });
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.resetActivityTimeout();

    watcher.dispose();
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(h.onColdStartWaiting).not.toHaveBeenCalled();
    expect(h.onActivityTimeout).not.toHaveBeenCalled();
  });

  it('counts stream events and summarizes them sorted by type', () => {
    const h = buildHarness();
    const watcher = createStreamLivenessWatcher(h.options);

    watcher.recordStreamEvent('text_delta');
    watcher.recordStreamEvent('text_delta');
    watcher.recordStreamEvent('toolcall_start');

    expect(watcher.getStreamEventSummary()).toEqual({ text_delta: 2, toolcall_start: 1 });
  });

  it('honours custom delays', () => {
    const h = buildHarness({ provider: 'ollama', coldStartDelayMs: 50, activityTimeoutMs: 100 });
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.resetActivityTimeout();

    vi.advanceTimersByTime(50);
    expect(h.onColdStartWaiting).toHaveBeenCalledTimes(1);
    expect(h.onActivityTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(h.onActivityTimeout).toHaveBeenCalledTimes(1);
  });
});

/**
 * A tool in flight emits no SDK events at all, so the old single inactivity
 * timer aborted healthy long work: a six-minute build was killed at five
 * minutes with a bare "Request timed out". The inactivity window now measures
 * silence while WAITING on the model, and a separate ceiling guards a tool that
 * is genuinely stuck.
 */
describe('createStreamLivenessWatcher — long-running tools', () => {
  const buildToolHarness = (over: Partial<StreamLivenessOptions> = {}) => {
    const isAborted = vi.fn(() => false);
    const onColdStartWaiting = vi.fn();
    const onFirstStreamEvent = vi.fn();
    const onActivityTimeout = vi.fn();
    const onToolExecutionTimeout = vi.fn();
    const options: StreamLivenessOptions = {
      provider: 'anthropic',
      promptStartedAt: PROMPT_STARTED_AT,
      isAborted,
      onColdStartWaiting,
      onFirstStreamEvent,
      onActivityTimeout,
      onToolExecutionTimeout,
      activityTimeoutMs: 1000,
      toolExecutionCeilingMs: 10_000,
      now: () => PROMPT_STARTED_AT,
      ...over,
    };
    return {
      options,
      onActivityTimeout,
      onToolExecutionTimeout,
    };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT abort a healthy tool that runs past the inactivity window', () => {
    const h = buildToolHarness();
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.resetActivityTimeout();

    watcher.beginToolCall('Bash');
    // Six times the inactivity window, the way a real build overruns it.
    vi.advanceTimersByTime(6000);
    expect(h.onActivityTimeout).not.toHaveBeenCalled();
    expect(watcher.isToolInFlight()).toBe(true);
  });

  it('re-arms the inactivity countdown once the last tool finishes', () => {
    const h = buildToolHarness();
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.resetActivityTimeout();

    watcher.beginToolCall('Bash');
    vi.advanceTimersByTime(6000);
    watcher.endToolCall();

    // The tool is done: the model can go silent again, so the countdown runs.
    vi.advanceTimersByTime(1000);
    expect(h.onActivityTimeout).toHaveBeenCalledTimes(1);
  });

  it('still aborts a genuinely stuck tool at the ceiling', () => {
    const h = buildToolHarness();
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.beginToolCall('Bash');

    vi.advanceTimersByTime(9999);
    expect(h.onToolExecutionTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2);
    expect(h.onToolExecutionTimeout).toHaveBeenCalledTimes(1);
    // The label is reported so the user knows which tool was stuck.
    expect(h.onToolExecutionTimeout).toHaveBeenCalledWith('Bash');
  });

  it('counts parallel tools: the countdown only returns after the last one', () => {
    const h = buildToolHarness();
    const watcher = createStreamLivenessWatcher(h.options);

    watcher.beginToolCall('Bash');
    watcher.beginToolCall('Read');
    watcher.endToolCall();

    // One tool is still running — the stream is expected to be silent.
    vi.advanceTimersByTime(6000);
    expect(h.onActivityTimeout).not.toHaveBeenCalled();

    watcher.endToolCall();
    vi.advanceTimersByTime(1000);
    expect(h.onActivityTimeout).toHaveBeenCalledTimes(1);
  });

  it('clears the ceiling when the tool finishes in time', () => {
    const h = buildToolHarness();
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.beginToolCall('Bash');
    vi.advanceTimersByTime(5000);
    watcher.endToolCall();

    vi.advanceTimersByTime(20_000);
    expect(h.onToolExecutionTimeout).not.toHaveBeenCalled();
  });

  it('never re-arms the inactivity timer while a tool is in flight', () => {
    const h = buildToolHarness();
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.beginToolCall('Bash');
    // A stray SDK event mid-tool must not restart the inactivity countdown.
    watcher.resetActivityTimeout();
    vi.advanceTimersByTime(5000);
    expect(h.onActivityTimeout).not.toHaveBeenCalled();
  });

  it('disables the ceiling when configured to 0', () => {
    const h = buildToolHarness({ toolExecutionCeilingMs: 0 });
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.beginToolCall('Bash');
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(h.onToolExecutionTimeout).not.toHaveBeenCalled();
  });

  it('leaves no timer armed after dispose', () => {
    const h = buildToolHarness();
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.beginToolCall('Bash');
    watcher.dispose();

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(h.onActivityTimeout).not.toHaveBeenCalled();
    expect(h.onToolExecutionTimeout).not.toHaveBeenCalled();
  });

  it('tolerates an unbalanced endToolCall', () => {
    const h = buildToolHarness();
    const watcher = createStreamLivenessWatcher(h.options);
    watcher.endToolCall();
    watcher.endToolCall();
    expect(watcher.isToolInFlight()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(h.onActivityTimeout).toHaveBeenCalledTimes(1);
  });
});
