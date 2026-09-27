import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from '../src/renderer/components/MessageMarkdown';

// Residual overflow vector found during the live-app verification of the
// raw-protocol-markup fix (2026-09-27): a fenced code block WITHOUT a language
// renders as inline-styled code inside a class-less <pre> (white-space: pre),
// and long lines overflow the message column. The containment rule must keep
// such <pre> elements inside the column.

const css = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/styles/globals.css'),
  'utf8'
);

describe('class-less <pre> containment in assistant prose', () => {
  it('constrains pre:not(.code-block) to the column with internal scroll', () => {
    const ruleMatch = css.match(/\.prose-chat pre:not\(\.code-block\)\s*\{([^}]*)\}/);
    expect(ruleMatch, 'missing .prose-chat pre:not(.code-block) rule').not.toBeNull();
    const body = ruleMatch![1];
    expect(body).toContain('overflow-x: auto');
    expect(body).toContain('max-width: 100%');
  });

  it('keeps the .code-block scrolling rule untouched for highlighted code', () => {
    expect(css).toMatch(/\.code-block\s*\{[^}]*overflow-x-auto/);
  });

  it('renders a languageless fence as a class-less pre targeted by the rule', () => {
    const longLine = 'x'.repeat(400);
    const html = renderToStaticMarkup(
      React.createElement(MessageMarkdown, { normalizedText: '```\n' + longLine + '\n```' })
    );
    // The generic markdown <pre> carries no class, so it matches :not(.code-block).
    expect(html).toContain('<pre>');
    expect(html).toContain(longLine);
  });

});
