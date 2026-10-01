/**
 * Prompt-injection budgets: no model-driven expansion may decide how much
 * context window it spends, and every truncation says what was omitted.
 */
import { describe, expect, it } from 'vitest';

import {
  applyPrefixBudget,
  capInjectedText,
} from '../src/main/memory/memory-utils';
import {
  EXPANDED_CHUNK_RAW_CAP,
  PROMPT_PREFIX_BUDGET_CHARS,
} from '../src/main/memory/memory-service';

describe('capInjectedText', () => {
  it('passes short text through untouched', () => {
    expect(capInjectedText('hello', 100, 'chunk raw text')).toBe('hello');
  });

  it('caps long text with an explicit omission marker', () => {
    const text = 'x'.repeat(10_000);
    const capped = capInjectedText(text, EXPANDED_CHUNK_RAW_CAP, 'chunk raw text');
    expect(capped.length).toBeLessThan(text.length);
    expect(capped).toContain('chunk raw text truncated');
    expect(capped).toContain(`of ${text.length} chars`);
  });
});

describe('applyPrefixBudget', () => {
  it('passes a small prefix through untouched', () => {
    expect(applyPrefixBudget('<memory_context>hi</memory_context>', 100)).toBe(
      '<memory_context>hi</memory_context>'
    );
  });

  it('cuts the tail (lowest-priority sections) with a marker', () => {
    const prefix = `<core>keep</core>\n<experience>${'y'.repeat(50_000)}</experience>`;
    const budgeted = applyPrefixBudget(prefix, PROMPT_PREFIX_BUDGET_CHARS);
    expect(budgeted.startsWith('<core>keep</core>')).toBe(true);
    expect(budgeted).toContain('memory_context truncated');
    expect(budgeted.length).toBeLessThan(prefix.length);
  });

  it('budgets are sane constants', () => {
    expect(PROMPT_PREFIX_BUDGET_CHARS).toBe(12_000);
    expect(EXPANDED_CHUNK_RAW_CAP).toBe(6_000);
  });
});
