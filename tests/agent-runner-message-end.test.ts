import { describe, expect, it } from 'vitest';

import {
  buildTerminalErrorEmissionDetails,
  buildTerminalErrorMessage,
  classifyTerminalError,
  resolveAbortDisposition,
  resolveAssistantStreamErrorText,
  resolveMessageEndPayload,
  shouldPreserveExistingTrace,
  toUserFacingErrorText,
} from '../src/main/agent/agent-runner-message-end';

describe('resolveMessageEndPayload', () => {
  it('falls back to accumulated streamed text when message_end content is empty', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: 'streamed fallback',
    });

    expect(result.nextStreamedText).toBe('');
    expect(result.errorText).toBeUndefined();
    expect(result.shouldEmitMessage).toBe(true);
    expect(result.effectiveContent).toEqual([{ type: 'text', text: 'streamed fallback' }]);
  });

  it('surfaces user-facing error text when message_end stops with error', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'first_response_timeout',
      },
      streamedText: 'partial text',
    });

    expect(result.nextStreamedText).toBe('');
    expect(result.shouldEmitMessage).toBe(false);
    expect(result.effectiveContent).toEqual([]);
    expect(result.errorText).toBe(
      'Model response timed out: no upstream output was received for an extended period. Retry later or check the current model/gateway load.'
    );
  });

  it('surfaces empty_success_result when message_end has no content and no streamed fallback', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText: '',
    });

    expect(result.nextStreamedText).toBe('');
    expect(result.shouldEmitMessage).toBe(false);
    expect(result.effectiveContent).toEqual([]);
    expect(result.errorText).toBe(
      'The model returned an empty success result. The current model or gateway may have a compatibility problem. Retry or switch protocol.'
    );
  });

  it('preserves literal \u003Cthink\u003E in text as-is (never parsed)', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Use \u003Cthink\u003Ereasoning\u003C/think\u003E to think' },
        ],
        stopReason: 'stop',
      },
      streamedText: '',
    });

    expect(result.effectiveContent).toEqual([
      { type: 'text', text: 'Use \u003Cthink\u003Ereasoning\u003C/think\u003E to think' },
    ]);
  });

  it('preserves literal \u003Cthink\u003E in thinking block content (reasoning field mentions \u003Cthink\u003E)', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking:
              'The user asks about \u003Cthink\u003E and \u003C/think\u003E tags and what they mean.',
          },
          { type: 'text', text: 'The \u003Cthink\u003E tag wraps reasoning.' },
        ],
        stopReason: 'stop',
      },
      streamedText: '',
    });

    expect(result.effectiveContent).toEqual([
      {
        type: 'thinking',
        thinking:
          'The user asks about \u003Cthink\u003E and \u003C/think\u003E tags and what they mean.',
      },
      { type: 'text', text: 'The \u003Cthink\u003E tag wraps reasoning.' },
    ]);
  });

  it('preserves literal \u003Cthink\u003E in streamedText when message content is empty (Ollama streaming fallback)', () => {
    const result = resolveMessageEndPayload({
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'stop',
      },
      streamedText:
        'The \u003Cthink\u003E tag is used for reasoning, not \u003Cthink\u003Eactual reasoning\u003C/think\u003E.',
    });

    expect(result.effectiveContent).toEqual([
      {
        type: 'text',
        text: 'The \u003Cthink\u003E tag is used for reasoning, not \u003Cthink\u003Eactual reasoning\u003C/think\u003E.',
      },
    ]);
  });
});

describe('classifyTerminalError', () => {
  it('classifies the documented upstream failure kinds into stable codes', () => {
    expect(classifyTerminalError('first_response_timeout')).toBe('timeout');
    expect(classifyTerminalError('empty_success_result')).toBe('empty_result');
    expect(classifyTerminalError('HTTP 400: bad request')).toBe('upstream_400');
    expect(classifyTerminalError('invalid request: unsupported parameter')).toBe('upstream_400');
    expect(classifyTerminalError('Error 401: Unauthorized')).toBe('auth_failed');
    expect(classifyTerminalError('403 Forbidden')).toBe('auth_failed');
    expect(classifyTerminalError('429 Too Many Requests')).toBe('rate_limited');
    expect(classifyTerminalError('too many requests')).toBe('rate_limited');
    expect(classifyTerminalError('HTTP 502: Bad Gateway')).toBe('server_error');
    expect(classifyTerminalError('overloaded_error')).toBe('server_error');
    expect(classifyTerminalError('connection error: ECONNRESET')).toBe('network_error');
    expect(classifyTerminalError('fetch failed')).toBe('network_error');
    expect(classifyTerminalError('some obscure upstream error')).toBe('stream_error');
  });
});

describe('classification and user-facing text stay coherent', () => {
  it('the text layer is derived from the machine kind for every error shape', () => {
    const shapes: Array<[string, string]> = [
      ['first_response_timeout', 'Model response timed out'],
      ['empty_success_result', 'empty success result'],
      ['HTTP 400: bad request', 'Upstream rejected the request (400)'],
      ['Error 401: Unauthorized', 'Authentication failed'],
      ['429 Too Many Requests', 'Rate limited (429)'],
      ['HTTP 502: Bad Gateway', 'Upstream service error'],
      ['connection error: ECONNRESET', 'Network connection interrupted'],
    ];
    for (const [input, expectedFragment] of shapes) {
      expect(toUserFacingErrorText(input), input).toContain(expectedFragment);
    }
  });

  it('unknown errors pass through untouched (stream_error kind)', () => {
    const raw = 'some obscure upstream error';
    expect(classifyTerminalError(raw)).toBe('stream_error');
    expect(toUserFacingErrorText(raw)).toBe(raw);
  });
});

describe('toUserFacingErrorText', () => {
  it('maps 400 / bad request to a locale-neutral configuration hint', () => {
    const result = toUserFacingErrorText('HTTP 400: bad request - ROLE_UNSPECIFIED');
    expect(result).toContain('Upstream rejected the request (400)');
    expect(result).toContain('Raw error:');
    expect(result).toContain('ROLE_UNSPECIFIED');
  });

  it('maps invalid request to configuration hint', () => {
    const result = toUserFacingErrorText('invalid request: unsupported parameter "store"');
    expect(result).toContain('Upstream rejected the request (400)');
    expect(result).toContain('Raw error:');
  });

  it('maps 401 to authentication hint', () => {
    const result = toUserFacingErrorText('Error 401: Unauthorized');
    expect(result).toContain('Authentication failed');
    expect(result).toContain('API key');
    expect(result).toContain('Raw error:');
  });

  it('maps 429 / rate limit to throttle hint', () => {
    const result = toUserFacingErrorText('429 Too Many Requests - rate limit exceeded');
    expect(result).toContain('Rate limited (429)');
    expect(result).toContain('Raw error:');
  });

  it('passes through unknown errors unchanged', () => {
    const raw = 'some obscure upstream error';
    expect(toUserFacingErrorText(raw)).toBe(raw);
  });

  it('still maps first_response_timeout correctly (regression)', () => {
    expect(toUserFacingErrorText('first_response_timeout')).toBe(
      'Model response timed out: no upstream output was received for an extended period. Retry later or check the current model/gateway load.'
    );
  });

  it('maps 5xx server errors to upstream service hint', () => {
    const result = toUserFacingErrorText('HTTP 502: Bad Gateway');
    expect(result).toContain('Upstream service error');
    expect(result).toContain('Raw error:');
    expect(result).toContain('502');
  });

  it('maps "server error" to upstream service hint', () => {
    const result = toUserFacingErrorText('internal server error');
    expect(result).toContain('Upstream service error');
  });

  it('maps "overloaded" to upstream service hint', () => {
    const result = toUserFacingErrorText('overloaded_error');
    expect(result).toContain('Upstream service error');
  });

  it('maps "terminated" to network connection hint', () => {
    const result = toUserFacingErrorText('terminated');
    expect(result).toContain('Network connection interrupted');
    expect(result).toContain('terminated');
  });

  it('maps "connection error" to network connection hint', () => {
    const result = toUserFacingErrorText('connection error: ECONNRESET');
    expect(result).toContain('Network connection interrupted');
  });

  it('maps "fetch failed" to network connection hint', () => {
    const result = toUserFacingErrorText('fetch failed');
    expect(result).toContain('Network connection interrupted');
  });

  it('maps "other side closed" to network connection hint', () => {
    const result = toUserFacingErrorText('other side closed');
    expect(result).toContain('Network connection interrupted');
  });

  it('maps "too many requests" without status code to throttle hint', () => {
    const result = toUserFacingErrorText('too many requests');
    expect(result).toContain('Rate limited (429)');
    expect(result).toContain('Raw error:');
  });

  it('maps "retry delay exceeded" to network connection hint', () => {
    const result = toUserFacingErrorText('retry delay exceeded');
    expect(result).toContain('Network connection interrupted');
  });

  it('never emits hardcoded locale text (main process stays locale-neutral)', () => {
    const samples = [
      'HTTP 400: bad request',
      'Error 401: Unauthorized',
      '429 Too Many Requests',
      'HTTP 502: Bad Gateway',
      'terminated',
      'first_response_timeout',
      'empty_success_result',
    ];
    for (const sample of samples) {
      const cjk = toUserFacingErrorText(sample).match(/[\u4e00-\u9fff]/);
      expect(cjk, `CJK characters leaked for input: ${sample}`).toBeNull();
    }
  });
});

describe('resolveAssistantStreamErrorText', () => {
  it('maps provider stream errors through the user-facing formatter', () => {
    const result = resolveAssistantStreamErrorText({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        content: [],
        api: 'openai-completions',
        provider: 'openai',
        model: 'gemma4:31b',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        errorMessage: 'HTTP 400: invalid request - malformed tool call JSON',
        timestamp: 0,
      },
    });

    expect(result).toContain('Upstream rejected the request (400)');
    expect(result).toContain('malformed tool call JSON');
  });

  it('falls back to the event reason when the provider omits errorMessage', () => {
    const result = resolveAssistantStreamErrorText({
      type: 'error',
      reason: 'aborted',
      error: {
        role: 'assistant',
        content: [],
        api: 'openai-completions',
        provider: 'openai',
        model: 'gemma4:31b',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        stopReason: 'aborted',
        timestamp: 0,
      },
    });

    expect(result).toBe('aborted');
  });

  it('defensively falls back when the provider omits the error payload entirely', () => {
    const result = resolveAssistantStreamErrorText({
      type: 'error',
      reason: 'error',
      error: undefined as never,
    });

    expect(result).toBe('error');
  });
});

describe('buildTerminalErrorMessage', () => {
  it('preserves partial streamed text before the error footer', () => {
    const result = buildTerminalErrorMessage(
      'HTTP 400: invalid request',
      'Partial analysis already streamed'
    );

    expect(result).toContain('Partial analysis already streamed');
    expect(result).toContain('**Error**: HTTP 400: invalid request');
    expect(result).toContain('Check the configuration and retry');
  });

  it('uses the retry hint for non-4xx terminal errors', () => {
    const result = buildTerminalErrorMessage('connection reset');
    expect(result).toContain('The agent is retrying automatically');
  });
});

describe('buildTerminalErrorEmissionDetails', () => {
  it('preserves streamed partial text before the error footer', () => {
    const result = buildTerminalErrorEmissionDetails({
      errorText: 'HTTP 400: invalid request',
      streamedText: 'Partial body',
    });

    expect(result.partialText).toBe('Partial body');
    expect(result.messageText).toContain('Partial body');
    expect(result.messageText).toContain('**Error**: HTTP 400: invalid request');
  });

  it('omits empty flush fragments cleanly', () => {
    const result = buildTerminalErrorEmissionDetails({
      errorText: 'connection reset',
      streamedText: '',
    });

    expect(result.partialText).toBe('');
    expect(result.messageText).toContain('The agent is retrying automatically');
  });
});

describe('resolveAbortDisposition', () => {
  it('prioritizes timeout over other abort reasons', () => {
    expect(
      resolveAbortDisposition({
        abortedByTimeout: true,
        abortedByLoopGuard: true,
        abortedByStreamError: true,
      })
    ).toBe('timeout');
  });

  it('returns stream_error when only stream-error preservation should apply', () => {
    expect(
      resolveAbortDisposition({
        abortedByTimeout: false,
        abortedByLoopGuard: false,
        abortedByStreamError: true,
      })
    ).toBe('stream_error');
  });
});

describe('shouldPreserveExistingTrace', () => {
  it('preserves the published error trace for loop guard and stream errors only', () => {
    expect(shouldPreserveExistingTrace('loop_guard')).toBe(true);
    expect(shouldPreserveExistingTrace('stream_error')).toBe(true);
    expect(shouldPreserveExistingTrace('timeout')).toBe(false);
    expect(shouldPreserveExistingTrace('user')).toBe(false);
  });
});
