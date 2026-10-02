import { describe, expect, it, afterEach } from 'vitest';

import { copyTextToClipboard } from '../src/renderer/utils/clipboard';

afterEach(() => {
  // Keep the node-environment globals clean between cases.
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { document?: unknown }).document;
});

describe('copyTextToClipboard', () => {
  it('returns false for empty text without touching any API', async () => {
    await expect(copyTextToClipboard('')).resolves.toBe(false);
  });

  it('returns false (never throws) when no clipboard API exists', async () => {
    await expect(copyTextToClipboard('hello')).resolves.toBe(false);
  });

  it('resolves true when the async Clipboard API succeeds', async () => {
    let written: string | undefined;
    (globalThis as { navigator?: unknown }).navigator = {
      clipboard: {
        writeText: async (text: string) => {
          written = text;
        },
      },
    };
    await expect(copyTextToClipboard('hello')).resolves.toBe(true);
    expect(written).toBe('hello');
  });

  it('falls back to execCommand when the async API rejects', async () => {
    (globalThis as { navigator?: unknown }).navigator = {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    };
    const removed: unknown[] = [];
    const textareaStub = {
      value: '',
      setAttribute: () => {},
      style: {} as Record<string, string>,
      select: () => {},
    };
    (globalThis as { document?: unknown }).document = {
      createElement: () => textareaStub,
      body: {
        appendChild: () => {},
        removeChild: (node: unknown) => {
          removed.push(node);
        },
      },
      execCommand: (command: string) => command === 'copy',
    };
    await expect(copyTextToClipboard('fallback text')).resolves.toBe(true);
    expect(textareaStub.value).toBe('fallback text');
    expect(removed).toEqual([textareaStub]);
  });

  it('resolves false when both the async API and execCommand fail', async () => {
    (globalThis as { navigator?: unknown }).navigator = {
      clipboard: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    };
    (globalThis as { document?: unknown }).document = {
      createElement: () => {
        throw new Error('no dom');
      },
      body: {},
      execCommand: () => false,
    };
    await expect(copyTextToClipboard('hello')).resolves.toBe(false);
  });
});
