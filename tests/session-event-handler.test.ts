/**
 * Tests for the pi session event handler extracted from the
 * piSession.subscribe() callback.
 *
 * Every effect and every piece of mutable state is injected, so the handler runs
 * without Electron and without a live session: these tests pin message_update,
 * message_end, tool execution and auto-compaction handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  let seq = 0;
  return {
    log: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    logCtx: vi.fn(),
    logCtxWarn: vi.fn(),
    logCtxError: vi.fn(),
    logTiming: vi.fn(),
    nextId: () => `uuid-${++seq}`,
  };
});

vi.mock('uuid', () => ({ v4: () => mocks.nextId() }));
vi.mock('../src/main/utils/logger', () => ({
  log: mocks.log,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
  logCtx: mocks.logCtx,
  logCtxWarn: mocks.logCtxWarn,
  logCtxError: mocks.logCtxError,
  logTiming: mocks.logTiming,
}));
vi.mock('../src/main/agent/agent-runner-message-end', () => ({
  resolveMessageEndPayload: vi.fn(),
  resolveAssistantStreamErrorText: vi.fn(),
}));
vi.mock('../src/main/utils/artifact-parser', () => ({
  extractArtifactsFromText: vi.fn((text: string) => ({ cleanText: text, artifacts: [] })),
  buildArtifactTraceSteps: vi.fn(() => [{ id: 'artifact-step' }]),
}));
vi.mock('../src/main/agent/tool-result-utils', () => ({
  normalizeToolExecutionResultForUi: vi.fn(() => ({ content: 'tool out', images: [] })),
}));

import {
  handlePiSessionEvent,
  type PiSessionEventContext,
} from '../src/main/agent/session-event-handler';
import {
  resolveMessageEndPayload,
  resolveAssistantStreamErrorText,
} from '../src/main/agent/agent-runner-message-end';
import {
  extractArtifactsFromText,
  buildArtifactTraceSteps,
} from '../src/main/utils/artifact-parser';
import { normalizeToolExecutionResultForUi } from '../src/main/agent/tool-result-utils';
import type { Message, TraceStep } from '../src/shared/types';

type PiEvent = Parameters<typeof handlePiSessionEvent>[0];

function makePayload(
  over: Partial<{
    effectiveContent: unknown[];
    errorText: string;
    nextStreamedText: string;
    shouldEmitMessage: boolean;
  }> = {}
) {
  return {
    effectiveContent: [],
    nextStreamedText: '',
    shouldEmitMessage: true,
    ...over,
  } as unknown as ReturnType<typeof resolveMessageEndPayload>;
}

function makeHarness(over: Partial<PiSessionEventContext> = {}) {
  let streamedText = '';
  let twoStageArmed = false;
  let pipelineDraftMessage: Message | undefined;
  let pipelineDraftText = '';
  let compactionStepId: string | undefined;

  const sendPartial = vi.fn();
  const sendToRenderer = vi.fn();
  const sendTraceStep = vi.fn();
  const sendTraceUpdate = vi.fn();
  const sendMessage = vi.fn();
  const getToolDisplayName = vi.fn((name: string) => `display:${name}`);
  const emitTerminalError = vi.fn();
  const handleLoopGuardDecision = vi.fn();
  const sanitizeOutputPaths = vi.fn((content: string) => content.replace('/real', '/workspace'));
  const markFirstStreamEvent = vi.fn();
  const hasReceivedFirstStreamEvent = vi.fn(() => true);
  const getFirstStreamLatencyMs = vi.fn(() => 42);
  const recordAssistantMessage = vi.fn(() => ({ action: 'none', reason: 'ok' }));
  const recordToolInvocation = vi.fn(() => ({ action: 'none', reason: 'ok' }));
  const isAborted = vi.fn(() => false);

  const ctx: PiSessionEventContext = {
    sessionId: 'sess-1',
    provider: 'anthropic',
    model: { id: 'model-1', provider: 'anthropic', api: 'anthropic' },
    usedSyntheticModel: false,
    isAborted,
    telemetry: { markFirstStreamEvent, hasReceivedFirstStreamEvent, getFirstStreamLatencyMs },
    loopGuard: {
      recordAssistantMessage,
      recordToolInvocation,
    } as unknown as PiSessionEventContext['loopGuard'],
    handleLoopGuardDecision,
    state: {
      getStreamedText: () => streamedText,
      setStreamedText: (text) => {
        streamedText = text;
      },
      isTwoStageArmed: () => twoStageArmed,
      stashPipelineDraft: (message, text) => {
        pipelineDraftMessage = message;
        pipelineDraftText = text;
      },
      getCompactionStepId: () => compactionStepId,
      setCompactionStepId: (id) => {
        compactionStepId = id;
      },
    },
    sendPartial,
    sendToRenderer,
    sendTraceStep,
    sendTraceUpdate,
    sendMessage,
    getToolDisplayName,
    emitTerminalError,
    sanitizeOutputPaths,
    ...over,
  };

  const run = (event: Record<string, unknown>) => handlePiSessionEvent(event as PiEvent, ctx);

  return {
    run,
    ctx,
    effects: {
      sendPartial,
      sendToRenderer,
      sendTraceStep,
      sendTraceUpdate,
      sendMessage,
      getToolDisplayName,
      emitTerminalError,
      handleLoopGuardDecision,
      sanitizeOutputPaths,
    },
    telemetry: { markFirstStreamEvent, hasReceivedFirstStreamEvent, getFirstStreamLatencyMs },
    loopGuard: { recordAssistantMessage, recordToolInvocation },
    isAborted,
    getStreamedText: () => streamedText,
    armTwoStage: () => {
      twoStageArmed = true;
    },
    getPipelineDraft: () => ({ message: pipelineDraftMessage, text: pipelineDraftText }),
    getCompactionStepId: () => compactionStepId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveMessageEndPayload).mockReturnValue(makePayload());
  vi.mocked(resolveAssistantStreamErrorText).mockReturnValue('stream failed');
  vi.mocked(extractArtifactsFromText).mockImplementation((text: string) => ({
    cleanText: text,
    artifacts: [],
  }));
  vi.mocked(buildArtifactTraceSteps).mockReturnValue([
    { id: 'artifact-step' } as unknown as TraceStep,
  ]);
  vi.mocked(normalizeToolExecutionResultForUi).mockReturnValue({ content: 'tool out', images: [] });
  delete process.env.COWORK_LOG_SDK_MESSAGES_FULL;
});

describe('handlePiSessionEvent — message_update', () => {
  it('accumulates text deltas and streams the partial', () => {
    const h = makeHarness();
    h.run({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } });
    expect(h.getStreamedText()).toBe('Hi');
    expect(h.telemetry.markFirstStreamEvent).toHaveBeenCalledWith('text_delta');
    expect(h.effects.sendPartial).toHaveBeenCalledWith('Hi');
  });

  it('accumulates text deltas but withholds the partial while two-stage is armed', () => {
    const h = makeHarness();
    h.armTwoStage();
    h.run({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } });
    expect(h.getStreamedText()).toBe('Hi');
    expect(h.effects.sendPartial).not.toHaveBeenCalled();
  });

  it('forwards thinking deltas to the renderer', () => {
    const h = makeHarness();
    h.run({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' },
    });
    expect(h.effects.sendToRenderer).toHaveBeenCalledWith({
      type: 'stream.thinking',
      payload: { sessionId: 'sess-1', delta: 'hmm' },
    });
  });

  it('withholds thinking deltas while two-stage is armed', () => {
    const h = makeHarness();
    h.armTwoStage();
    h.run({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' },
    });
    expect(h.effects.sendToRenderer).not.toHaveBeenCalled();
  });

  it('opens a tool_call trace step on toolcall_start', () => {
    const h = makeHarness();
    h.run({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: {
          content: [{ type: 'toolCall', name: 'Read', id: 'tc1', arguments: { path: '/a' } }],
        },
      },
    });
    expect(h.effects.sendTraceStep).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tc1',
        type: 'tool_call',
        status: 'running',
        title: 'display:Read',
        toolName: 'Read',
        toolInput: { path: '/a' },
      })
    );
  });

  it('falls back to unknown when the toolcall_start part is missing', () => {
    const h = makeHarness();
    h.run({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 },
    });
    expect(h.effects.sendTraceStep).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'unknown', title: 'display:unknown' })
    );
  });

  it('ignores the done update', () => {
    const h = makeHarness();
    h.run({ type: 'message_update', assistantMessageEvent: { type: 'done' } });
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] message_update done event (handled in message_end)'
    );
    expect(h.effects.emitTerminalError).not.toHaveBeenCalled();
  });

  it('emits a terminal error on a stream error', () => {
    const h = makeHarness();
    h.run({
      type: 'message_update',
      assistantMessageEvent: { type: 'error', reason: 'boom', error: { content: 'detail' } },
    });
    expect(h.effects.emitTerminalError).toHaveBeenCalledWith('stream failed', { abort: true });
  });
});

describe('handlePiSessionEvent — message_end', () => {
  const message = { role: 'assistant', content: [], stopReason: 'end' };

  it('emits a terminal error and stops when the payload reports one', () => {
    const h = makeHarness();
    vi.mocked(resolveMessageEndPayload).mockReturnValue(makePayload({ errorText: 'boom' }));
    h.run({ type: 'message_end', message });
    expect(h.effects.emitTerminalError).toHaveBeenCalledWith('boom');
    expect(h.effects.sendMessage).not.toHaveBeenCalled();
  });

  it('builds and sends the assistant message from the effective content', () => {
    const h = makeHarness();
    vi.mocked(resolveMessageEndPayload).mockReturnValue(
      makePayload({
        nextStreamedText: 'reset',
        effectiveContent: [
          { type: 'text', text: 'Hello /real' },
          { type: 'toolCall', name: 'Read', id: 'tc1', arguments: { path: '/a' } },
          { type: 'thinking', thinking: 'hmm' },
          { type: 'weird', text: 'fallback' },
        ],
      })
    );
    h.run({ type: 'message_end', message: { ...message, usage: { input: 1 } } });
    expect(h.getStreamedText()).toBe('reset');
    const sent = h.effects.sendMessage.mock.calls[0][0] as Message;
    expect(sent).toMatchObject({
      sessionId: 'sess-1',
      role: 'assistant',
      api: 'anthropic',
      provider: 'anthropic',
      model: 'model-1',
    });
    expect(sent.content).toEqual([
      { type: 'text', text: 'Hello /workspace' },
      {
        type: 'tool_use',
        id: 'tc1',
        name: 'Read',
        displayName: 'display:Read',
        input: { path: '/a' },
      },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'fallback' },
    ]);
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Unknown content block type: weird');
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] normalized usage:',
      expect.any(String)
    );
  });

  it('sends artifact trace steps extracted from text blocks', () => {
    const h = makeHarness();
    vi.mocked(extractArtifactsFromText).mockReturnValue({
      cleanText: 'body',
      artifacts: [{ kind: 'html' }],
    } as unknown as ReturnType<typeof extractArtifactsFromText>);
    vi.mocked(resolveMessageEndPayload).mockReturnValue(
      makePayload({ effectiveContent: [{ type: 'text', text: 'body' }] })
    );
    h.run({ type: 'message_end', message });
    expect(buildArtifactTraceSteps).toHaveBeenCalled();
    expect(h.effects.sendTraceStep).toHaveBeenCalledWith({ id: 'artifact-step' });
  });

  it('runs the loop guard on the message tool-call group', () => {
    const h = makeHarness();
    vi.mocked(resolveMessageEndPayload).mockReturnValue(
      makePayload({
        effectiveContent: [{ type: 'toolCall', name: 'Bash', id: 'tc1', arguments: {} }],
      })
    );
    h.run({ type: 'message_end', message });
    expect(h.loopGuard.recordAssistantMessage).toHaveBeenCalledWith([{ name: 'Bash', input: {} }]);
    expect(h.effects.handleLoopGuardDecision).toHaveBeenCalledWith(
      { action: 'none', reason: 'ok' },
      'message_end'
    );
  });

  it('records a tool-call descriptor with empty defaults', () => {
    const h = makeHarness();
    vi.mocked(resolveMessageEndPayload).mockReturnValue(
      makePayload({ effectiveContent: [{ type: 'toolCall', name: '', id: 'tc1' }] })
    );
    h.run({ type: 'message_end', message });
    expect(h.loopGuard.recordAssistantMessage).toHaveBeenCalledWith([
      { name: '', input: undefined },
    ]);
    expect(h.effects.handleLoopGuardDecision).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'none' }),
      'message_end'
    );
  });

  it('stashes the terminal text-only draft instead of sending it when armed', () => {
    const h = makeHarness();
    h.armTwoStage();
    vi.mocked(resolveMessageEndPayload).mockReturnValue(
      makePayload({ effectiveContent: [{ type: 'text', text: 'draft answer' }] })
    );
    h.run({ type: 'message_end', message });
    expect(h.effects.sendMessage).not.toHaveBeenCalled();
    const draft = h.getPipelineDraft();
    expect(draft.text).toBe('draft answer');
    expect(draft.message?.content).toEqual([{ type: 'text', text: 'draft answer' }]);
  });

  it('drops a text block whose extracted text is empty', () => {
    const h = makeHarness();
    h.armTwoStage();
    vi.mocked(resolveMessageEndPayload).mockReturnValue(
      makePayload({ effectiveContent: [{ type: 'text' }] })
    );
    h.run({ type: 'message_end', message });
    expect(h.effects.sendMessage).not.toHaveBeenCalled();
    expect(h.getPipelineDraft().text).toBe('');
  });

  it('still sends tool-call messages while two-stage is armed', () => {
    const h = makeHarness();
    h.armTwoStage();
    vi.mocked(resolveMessageEndPayload).mockReturnValue(
      makePayload({
        effectiveContent: [{ type: 'toolCall', name: 'Bash', id: 'tc1', arguments: {} }],
      })
    );
    h.run({ type: 'message_end', message });
    expect(h.effects.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.getPipelineDraft().message).toBeUndefined();
  });

  it('dumps the raw message when full debug logging is enabled', () => {
    process.env.COWORK_LOG_SDK_MESSAGES_FULL = '1';
    const h = makeHarness();
    h.run({ type: 'message_end', message });
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] message_end raw message:',
      expect.any(String)
    );
  });

  it('logs Ollama diagnostics for the ollama provider', () => {
    const h = makeHarness({ provider: 'ollama' });
    h.run({ type: 'message_end', message });
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Ollama message_end diagnostics',
      expect.any(String)
    );
  });

  it('passes an unknown content block type through as text', () => {
    const h = makeHarness();
    vi.mocked(resolveMessageEndPayload).mockReturnValue(
      makePayload({ effectiveContent: [{ type: 'weird', text: 'fallback' }, { type: 'other' }] })
    );
    h.run({ type: 'message_end', message });
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Unknown content block type: weird');
    expect(h.effects.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [
          { type: 'text', text: 'fallback' },
          { type: 'text', text: '{"type":"other"}' },
        ],
      })
    );
  });

  it('does nothing when the payload suppresses the message', () => {
    const h = makeHarness();
    vi.mocked(resolveMessageEndPayload).mockReturnValue(
      makePayload({ shouldEmitMessage: false, effectiveContent: [{ type: 'text', text: 'x' }] })
    );
    h.run({ type: 'message_end', message });
    expect(h.effects.sendMessage).not.toHaveBeenCalled();
    expect(h.effects.sendToRenderer).not.toHaveBeenCalled();
  });
});

describe('handlePiSessionEvent — tool execution', () => {
  it('records the tool invocation on tool_execution_start', () => {
    const h = makeHarness();
    h.run({ type: 'tool_execution_start', toolName: 'Bash' });
    expect(mocks.logCtx).toHaveBeenCalledWith('[CoworkAgentRunner] Tool execution start: Bash');
    expect(h.loopGuard.recordToolInvocation).toHaveBeenCalledWith('Bash');
    expect(h.effects.handleLoopGuardDecision).toHaveBeenCalledWith(
      { action: 'none', reason: 'ok' },
      'tool_execution_start'
    );
  });

  it('updates the trace and sends the tool result on tool_execution_end', () => {
    const h = makeHarness();
    h.run({
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: 'Bash',
      isError: false,
      result: 'out',
    });
    expect(h.effects.sendTraceUpdate).toHaveBeenCalledWith(
      'tc1',
      expect.objectContaining({
        status: 'completed',
        title: 'display:Bash',
        toolName: 'Bash',
        toolOutput: 'tool out',
      })
    );
    const sent = h.effects.sendMessage.mock.calls[0][0] as Message;
    expect(sent.content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'tc1',
      content: 'tool out',
      isError: false,
    });
  });

  it('marks the trace as error and carries images on failure', () => {
    const h = makeHarness();
    vi.mocked(normalizeToolExecutionResultForUi).mockReturnValue({
      content: 'boom',
      images: [{ data: 'b64', mimeType: 'image/png' }],
    } as unknown as ReturnType<typeof normalizeToolExecutionResultForUi>);
    h.run({
      type: 'tool_execution_end',
      toolCallId: 'tc9',
      toolName: 'Bash',
      isError: true,
      result: 'boom',
    });
    expect(h.effects.sendTraceUpdate).toHaveBeenCalledWith(
      'tc9',
      expect.objectContaining({ status: 'error' })
    );
    const sent = h.effects.sendMessage.mock.calls[0][0] as Message;
    expect(sent.content[0]).toMatchObject({
      type: 'tool_result',
      isError: true,
      images: [{ data: 'b64', mimeType: 'image/png' }],
    });
  });

  it('skips tool_execution_end while aborted', () => {
    const h = makeHarness();
    h.isAborted.mockReturnValue(true);
    h.run({
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: 'Bash',
      isError: false,
      result: 'out',
    });
    expect(h.effects.sendMessage).not.toHaveBeenCalled();
    expect(h.effects.sendTraceUpdate).not.toHaveBeenCalled();
  });

  it('only logs on agent_end', () => {
    const h = makeHarness();
    h.run({ type: 'agent_end' });
    expect(mocks.logCtx).toHaveBeenCalledWith('[CoworkAgentRunner] Agent finished');
    expect(h.effects.sendMessage).not.toHaveBeenCalled();
  });
});

describe('handlePiSessionEvent — auto-compaction', () => {
  it('opens a compaction trace step on start', () => {
    const h = makeHarness();
    h.run({ type: 'auto_compaction_start', reason: 'threshold' });
    expect(h.getCompactionStepId()).toMatch(/^compaction-/);
    expect(h.effects.sendTraceStep).toHaveBeenCalledWith(
      expect.objectContaining({
        id: h.getCompactionStepId(),
        type: 'thinking',
        status: 'running',
        title: 'Compacting context (threshold)...',
      })
    );
  });

  it('closes the existing compaction step on end and surfaces the result', () => {
    const h = makeHarness();
    h.run({ type: 'auto_compaction_start', reason: 'threshold' });
    const stepId = h.getCompactionStepId();
    h.run({
      type: 'auto_compaction_end',
      aborted: false,
      willRetry: false,
      result: {
        summary: 'sum',
        tokensBefore: 10,
        details: { readFiles: ['a'], modifiedFiles: ['b'] },
      },
    });
    expect(h.effects.sendTraceUpdate).toHaveBeenCalledWith(stepId, {
      status: 'completed',
      title: 'Context compaction completed',
    });
    expect(h.getCompactionStepId()).toBeUndefined();
    expect(h.effects.sendToRenderer).toHaveBeenCalledWith({
      type: 'compaction.result',
      payload: {
        sessionId: 'sess-1',
        summary: 'sum',
        tokensBefore: 10,
        readFiles: ['a'],
        modifiedFiles: ['b'],
      },
    });
  });

  it('surfaces an empty file list when the result carries no details', () => {
    const h = makeHarness();
    h.run({ type: 'auto_compaction_start', reason: 'threshold' });
    h.run({
      type: 'auto_compaction_end',
      aborted: false,
      willRetry: false,
      result: { summary: 'sum', tokensBefore: 5 },
    });
    expect(h.effects.sendToRenderer).toHaveBeenCalledWith({
      type: 'compaction.result',
      payload: {
        sessionId: 'sess-1',
        summary: 'sum',
        tokensBefore: 5,
        readFiles: [],
        modifiedFiles: [],
      },
    });
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Compaction result surfaced:',
      expect.any(String)
    );
  });

  it('skips surfacing the result while a retry is pending', () => {
    const h = makeHarness();
    h.run({ type: 'auto_compaction_start', reason: 'threshold' });
    h.run({
      type: 'auto_compaction_end',
      aborted: false,
      willRetry: true,
      result: { summary: 'sum', tokensBefore: 9, details: { readFiles: ['x'] } },
    });
    expect(h.effects.sendToRenderer).not.toHaveBeenCalled();
  });

  it('reports an aborted compaction as an error', () => {
    const h = makeHarness();
    h.run({ type: 'auto_compaction_start', reason: 'threshold' });
    const stepId = h.getCompactionStepId();
    h.run({ type: 'auto_compaction_end', aborted: true, willRetry: false });
    expect(h.effects.sendTraceUpdate).toHaveBeenCalledWith(stepId, {
      status: 'error',
      title: 'Context compaction aborted',
    });
  });

  it('creates a fallback step when no start event was seen', () => {
    const h = makeHarness();
    h.run({ type: 'auto_compaction_end', aborted: false, willRetry: false });
    expect(h.effects.sendTraceUpdate).not.toHaveBeenCalled();
    expect(h.effects.sendTraceStep).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^compaction-end-/),
        type: 'thinking',
        status: 'completed',
        title: 'Context compaction completed',
      })
    );
  });

  it('reports a failed compaction with its message', () => {
    const h = makeHarness();
    h.run({ type: 'auto_compaction_start', reason: 'threshold' });
    const stepId = h.getCompactionStepId();
    h.run({ type: 'auto_compaction_end', aborted: false, errorMessage: 'nope', willRetry: false });
    expect(h.effects.sendTraceUpdate).toHaveBeenCalledWith(
      stepId,
      expect.objectContaining({ status: 'error', title: 'Context compaction failed: nope' })
    );
  });
});
