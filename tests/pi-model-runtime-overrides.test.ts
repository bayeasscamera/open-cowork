import { describe, expect, it } from 'vitest';
import type { Api, Model } from '@mariozechner/pi-ai';
import {
  applyPiModelRuntimeOverrides,
  buildSyntheticPiModel,
  resolvePiRegistryModel,
} from '../src/main/agent/pi-model-resolution';

const openAIResponsesModel = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
} as Model<Api>;

describe('pi model runtime overrides', () => {
  it('keeps OpenAI Responses for custom OpenAI configs that target official OpenAI', () => {
    const model = resolvePiRegistryModel('openai/gpt-5.4', {
      configProvider: 'openai',
      rawProvider: 'custom',
      customProtocol: 'openai',
      customBaseUrl: 'https://api.openai.com/v1',
    });

    expect(model?.api).toBe('openai-responses');
    expect(model?.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('still downgrades Responses models for generic custom OpenAI-compatible relays', () => {
    const model = applyPiModelRuntimeOverrides(openAIResponsesModel, {
      configProvider: 'openai',
      rawProvider: 'custom',
      customProtocol: 'openai',
      customBaseUrl: 'https://relay.example.test/v1',
    });

    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://relay.example.test/v1');
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsStore: false,
    });
  });

  // Regression: the Context Window / Max Output Tokens fields in
  // Settings > API were applied ONLY to models absent from the pi-ai registry
  // (inside buildSyntheticPiModel). Registry models kept the registry's own
  // numbers, so the setting was silently ignored for the models users run daily.
  describe('context window and max output tokens overrides', () => {
    it('applies a configured context window to a REGISTRY model', () => {
      const model = resolvePiRegistryModel('anthropic/claude-sonnet-4-6', {
        configProvider: 'anthropic',
        rawProvider: 'anthropic',
        contextWindow: 1_000_000,
        maxTokens: 384000,
      });

      expect(model).toBeDefined();
      // The registry advertises 200000 for some Sonnet variants; the user's
      // explicit setting must win regardless.
      expect(model?.contextWindow).toBe(1_000_000);
      expect(model?.maxTokens).toBe(384000);
    });

    it('keeps registry values when the user configured nothing', () => {
      const configured = resolvePiRegistryModel('anthropic/claude-sonnet-4-6', {
        configProvider: 'anthropic',
        rawProvider: 'anthropic',
      });
      const reference = resolvePiRegistryModel('anthropic/claude-sonnet-4-6', {
        configProvider: 'anthropic',
        rawProvider: 'anthropic',
        contextWindow: undefined,
        maxTokens: undefined,
      });

      expect(configured?.contextWindow).toBe(reference?.contextWindow);
      expect(configured?.maxTokens).toBe(reference?.maxTokens);
    });

    it('treats zero and negative values as "no override" (auto-detect stays live)', () => {
      const model = applyPiModelRuntimeOverrides(openAIResponsesModel, {
        configProvider: 'openai',
        rawProvider: 'openai',
        contextWindow: 0,
        maxTokens: -1,
      });

      expect(model.contextWindow).toBe(128000);
      expect(model.maxTokens).toBe(16384);
    });

    it('applies the override to a synthetic (non-registry) model too', () => {
      const model = applyPiModelRuntimeOverrides(
        buildSyntheticPiModel('some-relay-model', 'custom', 'openai', 'https://relay.test/v1'),
        {
          configProvider: 'openai',
          rawProvider: 'custom',
          customProtocol: 'openai',
          contextWindow: 1_000_000,
          maxTokens: 384000,
        }
      );

      expect(model.contextWindow).toBe(1_000_000);
      expect(model.maxTokens).toBe(384000);
    });
  });
});
