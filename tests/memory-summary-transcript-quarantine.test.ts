import { describe, expect, it } from 'vitest';
import { buildSummaryTranscript } from '../src/main/memory/memory-utils';
import type { ContentBlock, Message } from '../src/shared/types';

// Memory summaries and compressed context must not ingest raw agent-protocol
// markup leaked into assistant text blocks. The leak fixtures use explicit
// \u003C escapes so the tags survive generation pipelines verbatim.

const OPEN_TOOL_USE = '\u003Ctool_use name="bash" id="call_m"\u003E';
const CLOSE_TOOL_USE = '\u003C/tool_use\u003E';

function message(role: 'user' | 'assistant', text: string): Message {
  const content: ContentBlock[] = [{ type: 'text', text }];
  return {
    id: `m-${role}-${text.length}`,
    sessionId: 's',
    role,
    content,
    timestamp: 0,
  };
}

describe('buildSummaryTranscript — protocol quarantine', () => {
  it('keeps clean conversations identical in shape', () => {
    const transcript = buildSummaryTranscript([
      message('user', 'fix the build'),
      message('assistant', 'The build is fixed.'),
    ]);
    expect(transcript).toBe('[USER]: fix the build\n\n[ASSISTANT]: The build is fixed.');
  });

  it('strips leaked protocol markup from assistant turns', () => {
    const transcript = buildSummaryTranscript([
      message(
        'assistant',
        `Analyse en cours.\n${OPEN_TOOL_USE}{"command":"ls"}${CLOSE_TOOL_USE}\nConclusion.`
      ),
    ]);
    expect(transcript).toBe('[ASSISTANT]: Analyse en cours.\n\nConclusion.');
  });

  it('omits turns that were pure protocol markup (no dangling role line)', () => {
    const transcript = buildSummaryTranscript([
      message('user', 'go'),
      message('assistant', `${OPEN_TOOL_USE}{"command":"ls"}${CLOSE_TOOL_USE}`),
      message('assistant', 'Réponse réelle.'),
    ]);
    expect(transcript).toBe('[USER]: go\n\n[ASSISTANT]: Réponse réelle.');
  });

  it('is robust when a message has no text blocks at all', () => {
    const transcript = buildSummaryTranscript([
      {
        id: 'm-tool',
        sessionId: 's',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }],
        timestamp: 0,
      } as Message,
    ]);
    expect(transcript).toBe('');
  });
});
