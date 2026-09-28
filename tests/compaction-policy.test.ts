import { describe, it, expect } from 'vitest';
import {
  effectiveContextWindow,
  resolveCompactionSettings,
  resolveSubAgentCompactionSettings,
  FALLBACK_CONTEXT_WINDOW,
} from '../src/main/agent/compaction-policy';

/**
 * The three sub-agent paths hard-coded `compaction: { enabled: false }`, so a
 * sub-agent that read a few files overflowed its context window, the provider
 * rejected the request, and the task failed irrecoverably. These tests pin the
 * policy that replaced it — including the small-model escape hatch, so the fix
 * cannot silently reintroduce the overflow by trusting a weak summariser.
 */
describe('compaction policy', () => {
  it('keeps compaction on for a sub-agent on a large window', () => {
    expect(resolveSubAgentCompactionSettings({ contextWindow: 200_000 })).toEqual({
      enabled: true,
    });
  });

  it('never leaves a sub-agent without context management, even with no window', () => {
    expect(resolveSubAgentCompactionSettings({})).toEqual({ enabled: true });
    expect(resolveSubAgentCompactionSettings({ contextWindow: 0 })).toEqual({ enabled: true });
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

  it('disables compaction on a very small model instead of trusting its summary', () => {
    // A 8k model summarising its own history produces something worse than the
    // overflow; the main agent already made this call, the sub-agents inherit it.
    expect(
      resolveSubAgentCompactionSettings({ contextWindow: 8_192, provider: 'ollama' })
    ).toEqual({ enabled: false });
  });

  it('does not tune non-Ollama providers, whatever their window', () => {
    expect(resolveCompactionSettings({ contextWindow: 8_192, provider: 'anthropic' })).toBeUndefined();
    expect(resolveCompactionSettings({ contextWindow: 32_768, provider: 'openai' })).toBeUndefined();
  });

  it('falls back to a sane window when the model advertises none', () => {
    expect(effectiveContextWindow({})).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(effectiveContextWindow({ contextWindow: undefined })).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(effectiveContextWindow({ contextWindow: 0 })).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(effectiveContextWindow({ contextWindow: 64_000 })).toBe(64_000);
  });

  it('returns undefined when the SDK defaults are already correct', () => {
    // The main agent turns this into `{ enabled: true }`; a sub-agent keeps the
    // SDK reserves rather than overriding tuned provider defaults.
    expect(resolveCompactionSettings({ contextWindow: 200_000 })).toBeUndefined();
  });
});
