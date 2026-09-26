import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageCard } from '../src/renderer/components/MessageCard';
import type { Message } from '../src/shared/types';

// End-to-end proof for the raw-function-calling-markup bug: an assistant
// message whose text block contains agent protocol leaked as plain text
// (as observed in a real session) must not render the tags as chat prose.

const LEAKY_TEXT = `Voici le diagnostic.
<turn role="assistant">
<tool_use name="bash" id="call_9fbb6cb64bff4db998b39e1d">{"command":"cd /project && pgrep -fl \\"worker\\" | head -4","timeout":30}</tool_use>
</turn>
<turn role="assistant">
<tool_result tool_use_id="call_9fbb6cb64bff4db998b39e1d">\`\`\`=== apps en cours ===
36582 /Applications/Demo.app
\`\`\`</tool_result>
</turn>
Et la conclusion normale.`;

function renderMessage(content: unknown, role: 'user' | 'assistant'): string {
  const message = {
    id: 'm-raw-1',
    sessionId: 's-raw',
    role,
    content,
    timestamp: Date.now(),
  } as Message;
  return renderToStaticMarkup(React.createElement(MessageCard, { message }));
}

describe('MessageCard quarantines raw agent-protocol markup (assistant)', () => {
  const html = renderMessage([{ type: 'text', text: LEAKY_TEXT }], 'assistant');

  it('does not render the raw function-calling tags as message text', () => {
    expect(html).not.toContain('tool_use name=');
    expect(html).not.toContain('&lt;tool_use');
    expect(html).not.toContain('&lt;turn');
    expect(html).not.toContain('tool_result tool_use_id=');
  });

  it('keeps the legitimate prose around the leak', () => {
    expect(html).toContain('Voici le diagnostic.');
    expect(html).toContain('Et la conclusion normale.');
  });

  it('shows the quarantine notice instead', () => {
    expect(html).toContain('raw-protocol-notice');
    // The replayed tool output is not dumped into the message either.
    expect(html).not.toContain('/Applications/Demo.app');
  });
});

describe('MessageCard never rewrites user content (non-regression)', () => {
  it('leaves user text untouched (no quarantine notice for user messages)', () => {
    const html = renderMessage([{ type: 'text', text: LEAKY_TEXT }], 'user');
    expect(html).not.toContain('raw-protocol-notice');
    // User content is displayed verbatim (HTML-escaped by React).
    expect(html).toContain('&lt;tool_use');
  });

  it('renders clean assistant markdown without any notice', () => {
    const html = renderMessage(
      [{ type: 'text', text: 'Réponse **propre** sans balise de protocole.' }],
      'assistant'
    );
    expect(html).not.toContain('raw-protocol-notice');
    expect(html).toContain('Réponse');
  });
});
