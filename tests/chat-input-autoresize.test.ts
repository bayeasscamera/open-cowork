import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Source contracts for the Claude-Desktop-style auto-growing chat input:
 * the textarea grows with its content up to ~40% of the window height, then
 * scrolls INTERNALLY (max-height + overflow-y), never overflowing its box.
 */

const hook = readFileSync('src/renderer/hooks/useAutoResizeTextarea.ts', 'utf8');
const chatView = readFileSync('src/renderer/components/ChatView.tsx', 'utf8');
const welcomeView = readFileSync('src/renderer/components/WelcomeView.tsx', 'utf8');

describe('useAutoResizeTextarea hook', () => {
  it('grows the field with content then switches to internal scroll at the cap', () => {
    expect(hook).toContain("textarea.style.height = 'auto'");
    // Cap = ~40% of the window height, with a sane floor.
    expect(hook).toContain('window.innerHeight * 0.4');
    expect(hook).toContain('Math.min(textarea.scrollHeight, maxHeight)');
    // Internal scrollbar only once the cap is reached.
    expect(hook).toContain("textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'");
  });

  it('recomputes when the window is resized', () => {
    expect(hook).toContain("addEventListener('resize'");
  });
});

describe('chat input wiring', () => {
  it('ChatView uses the shared auto-resize hook on its prompt textarea', () => {
    expect(chatView).toContain('useAutoResizeTextarea(textareaRef, prompt)');
    // CSS guarantees even before/without JS: capped height + internal scroll.
    expect(chatView).toContain('max-h-[40vh] overflow-y-auto');
  });

  it('WelcomeView uses the shared hook too (replaces its fixed 200px local cap)', () => {
    expect(welcomeView).toContain('useAutoResizeTextarea(textareaRef, prompt)');
    expect(welcomeView).toContain('max-h-[40vh] overflow-y-auto');
    expect(welcomeView).not.toContain('const maxHeight = 200');
  });

  it('the action buttons stay anchored while the field grows (items-end layout)', () => {
    // The composer row keeps buttons aligned to the growing textarea's bottom.
    expect(chatView).toContain('flex items-end');
  });
});
