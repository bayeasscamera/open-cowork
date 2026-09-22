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
