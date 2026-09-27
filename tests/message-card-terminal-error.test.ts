import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageCard } from '../src/renderer/components/MessageCard';
import { ThinkingBlock } from '../src/renderer/components/message/ThinkingBlock';
import type { Message } from '../src/shared/types';

// Terminal errors are structured messages (isError + errorCode): the renderer
// must show a distinct error banner with a localized label instead of letting
// the raw error read as normal assistant prose. Historical messages without
// the flag keep rendering exactly as before.

const OPEN_TURN = '\u003Cturn role="assistant"\u003E';
const CLOSE_TURN = '\u003C/turn\u003E';
const OPEN_TOOL_USE = '\u003Ctool_use name="bash" id="call_t"\u003E';
const CLOSE_TOOL_USE = '\u003C/tool_use\u003E';

function renderMessage(message: Message): string {
  return renderToStaticMarkup(React.createElement(MessageCard, { message }));
}

describe('MessageCard — terminal error card', () => {
  it('renders the structured error banner for flagged messages', () => {
    const html = renderMessage({
      id: 'm-err',
      sessionId: 's',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '**Error**: Upstream rejected the request (400).\n\nRaw error: HTTP 400',
        },
      ],
      timestamp: 0,
      isError: true,
      errorCode: 'upstream_400',
    } as Message);

    expect(html).toContain('assistant-error-banner');
    expect(html).toContain('border-error/40');
    expect(html).toContain('Upstream rejected the request (400)');
  });

  it('keeps normal assistant messages unstyled (non-regression)', () => {
    const html = renderMessage({
      id: 'm-ok',
      sessionId: 's',
      role: 'assistant',
      content: [{ type: 'text', text: 'Réponse normale.' }],
      timestamp: 0,
    } as Message);

    expect(html).not.toContain('assistant-error-banner');
    expect(html).not.toContain('border-error/40');
    expect(html).toContain('Réponse normale.');
  });

  it('historical error messages without the flag still render their text', () => {
    const html = renderMessage({
      id: 'm-legacy',
      sessionId: 's',
      role: 'assistant',
      content: [{ type: 'text', text: '**Error**: 请求被上游拒绝（400）' }],
      timestamp: 0,
    } as Message);

    expect(html).not.toContain('assistant-error-banner');
    expect(html).toContain('**Error**');
  });
});

describe('ThinkingBlock — protocol quarantine coverage', () => {
  const leakyThinking = `Je vais inspecter le dépôt.
${OPEN_TURN}
${OPEN_TOOL_USE}{"command":"pgrep -fl worker"}${CLOSE_TOOL_USE}
${CLOSE_TURN}
Voilà.`;

  it('shows a clean preview without raw markup in the collapsed header', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThinkingBlock, {
        block: { type: 'thinking', thinking: leakyThinking },
      })
    );
    expect(html).toContain('Je vais inspecter le dépôt.');
    // The 80-char preview must come from the quarantined text: even when the
    // leak starts inside the window, no raw tag is rendered.
    expect(html).not.toContain('tool_use');
  });

  it('quarantines the markup inside the expanded view too', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThinkingBlock, {
        block: { type: 'thinking', thinking: leakyThinking },
        defaultExpanded: true,
      })
    );
    expect(html).toContain('raw-protocol-notice');
    expect(html).toContain('Je vais inspecter le dépôt.');
    expect(html).not.toContain('call_t');
  });

  it('renders normal thinking content unchanged', () => {
    const html = renderToStaticMarkup(
      React.createElement(ThinkingBlock, {
        block: { type: 'thinking', thinking: 'Raisonnement parfaitement normal.' },
        defaultExpanded: true,
      })
    );
    expect(html).toContain('Raisonnement parfaitement normal.');
    expect(html).not.toContain('raw-protocol-notice');
  });
});
