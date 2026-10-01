import { describe, it, expect } from 'vitest';
import {
  effectiveContextWindow,
  resolveCompactionSettings,
  resolveSubAgentCompactionSettings,
  COMPACTION_TRIGGER_RATIO,
  FALLBACK_CONTEXT_WINDOW,
} from '../src/main/agent/compaction-policy';

/**
 * When a long session approaches the model's context limit, it must continue by
 * compacting rather than stopping and asking for a new session — the whole
 * working context (files read, decisions taken, task progress) would otherwise
 * be lost and have to be retyped by hand.
 *
 * The compaction machinery itself (token estimation, LLM summary, cut point)
 * comes from the SDK. What this module owns — and what was broken — is WHEN it
 * fires. The SDK's `shouldCompact` is `tokens > window - reserveTokens` with a
 * fixed 16 384 reserve. A fixed reserve means the trigger is a percentage only
 * by coincidence: 87% on a 128k window, but 98.4% on a 1M one. At 98.4% the
 * in-flight user message and tool call have already overflowed, so the turn
 * fails instead of compacting — exactly the "start a new session" dead end.
 */

/** Mirrors the SDK's trigger so the tests assert real trigger points. */
function triggersAt(settings: { reserveTokens?: number }, contextWindow: number): number {
  return contextWindow - (settings.reserveTokens ?? 16_384);
}

function triggerRatio(settings: { reserveTokens?: number }, contextWindow: number): number {
  return triggersAt(settings, contextWindow) / contextWindow;
}

describe('compaction policy — sub-agent safety net', () => {
  it('keeps compaction on for a sub-agent on a large window', () => {
    expect(resolveSubAgentCompactionSettings({ contextWindow: 200_000 }).enabled).toBe(true);
  });

  it('never leaves a sub-agent without context management, even with no window', () => {
    expect(resolveSubAgentCompactionSettings({}).enabled).toBe(true);
    expect(resolveSubAgentCompactionSettings({ contextWindow: 0 }).enabled).toBe(true);
  });

  it('disables compaction on a very small model instead of trusting its summary', () => {
    // An 8k model summarising its own history produces something worse than the
    // overflow; the main agent already made this call, the sub-agents inherit it.
    expect(
      resolveSubAgentCompactionSettings({ contextWindow: 8_192, provider: 'ollama' })
    ).toEqual({ enabled: false });
  });

  it('scales reserves on a small local model whose window is still usable', () => {
    expect(
      resolveSubAgentCompactionSettings({ contextWindow: 32_768, provider: 'ollama' })
    ).toEqual({
      enabled: true,
      reserveTokens: Math.floor(32_768 * 0.15),
      keepRecentTokens: Math.floor(32_768 * 0.25),
    });
  });

  it('falls back to a sane window when the model advertises none', () => {
    expect(effectiveContextWindow({})).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(effectiveContextWindow({ contextWindow: undefined })).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(effectiveContextWindow({ contextWindow: 0 })).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(effectiveContextWindow({ contextWindow: 64_000 })).toBe(64_000);
  });
});

describe('compaction policy — the trigger fires early enough to resume', () => {
  /**
   * The regression this whole file exists for: a large-context model delaying
   * compaction until 98.4% of its window, so the turn that was in flight has
   * already overflowed and the session cannot be resumed at all.
   */
  const WINDOWS: Array<[label: string, contextWindow: number]> = [
    ['Claude 128k', 128_000],
    ['Claude 200k', 200_000],
    ['Gemini 1M', 1_000_000],
    ['GPT 400k', 400_000],
    ['unknown window (fallback)', FALLBACK_CONTEXT_WINDOW],
  ];

  for (const [label, contextWindow] of WINDOWS) {
    it(`triggers at ~80% of the window on ${label}`, () => {
      const settings = resolveCompactionSettings({ contextWindow });
      expect(settings).toBeDefined();
      expect(triggerRatio(settings!, contextWindow)).toBeCloseTo(COMPACTION_TRIGGER_RATIO, 5);
      expect(triggerRatio(settings!, contextWindow)).toBeLessThanOrEqual(0.8);
    });
  }

  it('never lets the trigger sit above 80% on any window', () => {
    // The fixed 16k reserve passed this on 128k and failed it everywhere above.
    for (let contextWindow = 16_384; contextWindow <= 1_000_000; contextWindow *= 2) {
      const settings = resolveCompactionSettings({ contextWindow })!;
      expect(
        triggerRatio(settings, contextWindow),
        `window ${contextWindow} triggered at ${triggerRatio(settings, contextWindow)}`
      ).toBeLessThanOrEqual(0.8);
    }
  });

  it('leaves headroom for the summary and the next turn at the trigger point', () => {
    const contextWindow = 200_000;
    const settings = resolveCompactionSettings({ contextWindow })!;
    const trigger = triggersAt(settings, contextWindow);

    // The space left at trigger time must comfortably hold the verbatim tail
    // plus a summary, or compaction itself overflows and the session dies.
    const keepRecent = settings.keepRecentTokens!;
    expect(contextWindow - trigger).toBeGreaterThan(keepRecent);
    expect(contextWindow - trigger).toBeGreaterThan(10_000);
  });

  it('keeps the verbatim tail bounded so a huge window cannot re-trigger immediately', () => {
    // keepRecentTokens close to the reserve would mean the post-compaction
    // context is already back over the threshold, and compaction would loop.
    const settings = resolveCompactionSettings({ contextWindow: 1_000_000 })!;
    const reserve = settings.reserveTokens!;

    expect(settings.keepRecentTokens!).toBeLessThan(reserve);
    expect(triggerRatio(settings, 1_000_000) - settings.keepRecentTokens! / 1_000_000).toBeGreaterThan(
      0.5
    );
  });

  it('applies the same rule to every provider, not just Ollama', () => {
    // The bug was invisible for Ollama (already proportional there) and only
    // bit the big hosted models.
    for (const provider of ['anthropic', 'openai', 'google', 'deepseek', 'mistral', undefined]) {
      const settings = resolveCompactionSettings({ contextWindow: 1_000_000, provider });
      expect(settings).toBeDefined();
      expect(triggerRatio(settings!, 1_000_000)).toBeCloseTo(COMPACTION_TRIGGER_RATIO, 5);
    }
  });

  it('still disables compaction on an unusable local model', () => {
    // The proportional reserve must not paper over the small-model escape
    // hatch: summarising 8k tokens of context needs more room than that.
    expect(
      resolveCompactionSettings({ contextWindow: 8_192, provider: 'ollama' }).enabled
    ).toBe(false);
  });
});
