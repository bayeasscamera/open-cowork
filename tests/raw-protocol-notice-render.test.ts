import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RawProtocolNotice } from '../src/renderer/components/message/RawProtocolNotice';
import { MessageMarkdown } from '../src/renderer/components/MessageMarkdown';

const FRAGMENT =
  '<tool_use name="bash" id="call_9fbb6cb64bff4db998b39e1d">{"command":"cd /project && pgrep -fl worker"}</tool_use>';

function render(props: { fragments: string[]; defaultExpanded?: boolean }): string {
  return renderToStaticMarkup(
    React.createElement(RawProtocolNotice, {
      fragments: props.fragments,
      ...(props.defaultExpanded !== undefined ? { defaultExpanded: props.defaultExpanded } : {}),
    })
  );
}

describe('RawProtocolNotice rendering', () => {
  it('renders the notice card and hides the raw markup by default', () => {
    const html = render({ fragments: [FRAGMENT] });
    expect(html).toContain('raw-protocol-notice');
    // The raw function-calling markup is NOT dumped into the visible message.
    expect(html).not.toContain('call_9fbb6cb64bff4db998b39e1d');
    expect(html).not.toContain('<tool_use');
  });

  it('shows the quarantined fragment count', () => {
    const html = render({ fragments: [FRAGMENT, FRAGMENT, FRAGMENT] });
    expect(html).toContain('raw-protocol-count');
  });

  it('renders nothing without fragments', () => {
    const html = render({ fragments: [] });
    expect(html).toBe('');
  });

  it('contains the raw fragment inside a wrapping, non-overflowing viewer when expanded', () => {
    const html = render({ fragments: [FRAGMENT], defaultExpanded: true });
    expect(html).toContain('call_9fbb6cb64bff4db998b39e1d');
    // Containment: the viewer wraps long unbroken tokens and clips instead of
    // letting content spill outside the message column.
    expect(html).toContain('whitespace-pre-wrap');
    expect(html).toContain('break-all');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('max-w-full');
  });
});

describe('MessageMarkdown overflow containment', () => {
  it('wraps long unbreakable tokens (break-words policy on the container)', () => {
    const longToken = 'a'.repeat(400);
    const html = renderToStaticMarkup(
      React.createElement(MessageMarkdown, {
        normalizedText: `Un token ininterrompu très long : ${longToken} fin.`,
      })
    );
    expect(html).toContain('break-words');
    expect(html).toContain(longToken);
  });

  it('still renders normal markdown content unchanged', () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageMarkdown, { normalizedText: 'Un **gras** et du texte.' })
    );
    expect(html).toContain('<strong>gras</strong>');
    expect(html).toContain('break-words');
  });
});
