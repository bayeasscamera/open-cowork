import OpenAI from 'openai';
import type { AppConfig, CustomProtocolType, ProviderType } from '../config/config-store';
import { configStore } from '../config/config-store';
import {
  normalizeOpenAICompatibleBaseUrl,
  resolveOllamaCredentials,
  resolveOpenAICredentials,
} from '../config/auth-utils';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { logWarn } from '../utils/logger';

export interface MemoryCompletionRequest {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface MemoryCompletionResponse {
  text: string;
}

export interface MemoryLLMClientLike {
  complete(request: MemoryCompletionRequest): Promise<MemoryCompletionResponse>;
  embed(text: string): Promise<number[]>;
}

interface MemoryModelConfig {
  inheritFromActive?: boolean;
  provider?: ProviderType;
  customProtocol?: CustomProtocolType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

interface ResolvedMemoryModelConfig {
  provider: ProviderType;
  customProtocol?: CustomProtocolType;
  apiKey: string;
  baseUrl?: string;
  model: string;
  timeoutMs: number;
}

export interface MemoryLLMClientOptions {
  /** How long a denied memory model is bypassed before being retried. */
  cooldownMs?: number;
}

const DEFAULT_BREAKER_COOLDOWN_MS = 10 * 60_000;

/**
 * Access rejections (HTTP 401/403, or explicit model-unavailable wording) that a
 * model swap can actually fix — unlike timeouts, rate limits (429) or network
 * failures, which stay transient and propagate untouched.
 */
function isAccessDeniedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(?:401|403)\b/.test(message) ||
    /no access to model|model .*not (?:found|available)|invalid model/i.test(message)
  );
}

function normalizeModelConfig(
  appConfig: AppConfig,
  input: MemoryModelConfig | undefined,
  fallbackModel: string
): ResolvedMemoryModelConfig {
  const inherit = input?.inheritFromActive !== false;
  const activeProvider = appConfig.provider;
  const activeProtocol = appConfig.customProtocol;
  const activeBaseUrl = appConfig.baseUrl;
  const activeApiKey = appConfig.apiKey;
  const activeModel = appConfig.model;

  const provider = inherit ? activeProvider : input?.provider || activeProvider;
  const customProtocol = inherit ? activeProtocol : input?.customProtocol || activeProtocol;
  const apiKey = inherit ? activeApiKey : input?.apiKey || '';
  const baseUrl = inherit ? activeBaseUrl : input?.baseUrl || activeBaseUrl;
  const model = (input?.model || (inherit ? activeModel : '') || fallbackModel).trim();
  const timeoutMs = Math.max(5_000, input?.timeoutMs || 180_000);

  return {
    provider,
    customProtocol,
    apiKey,
    baseUrl,
    model,
    timeoutMs,
  };
}

function buildAppConfig(base: AppConfig, resolved: ResolvedMemoryModelConfig): AppConfig {
  return {
    ...base,
    provider: resolved.provider,
    customProtocol: resolved.customProtocol,
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
  };
}

export class MemoryLLMClient implements MemoryLLMClientLike {
  private readonly brokenModels = new Map<string, number>();
  private readonly cooldownMs: number;

  constructor(
    private readonly getConfig: () => AppConfig = () => configStore.getAll(),
    options?: MemoryLLMClientOptions
  ) {
    this.cooldownMs = Math.max(0, options?.cooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS);
  }

  async complete(request: MemoryCompletionRequest): Promise<MemoryCompletionResponse> {
    const appConfig = this.getConfig();
    const llmConfig = normalizeModelConfig(
      appConfig,
      appConfig.memoryRuntime?.llm,
      appConfig.model
    );
    const activeConfig = normalizeModelConfig(
      appConfig,
      { inheritFromActive: true },
      appConfig.model
    );

    // A memory model previously denied access is bypassed until its cooldown
    // expires, so every auxiliary call does not hammer a doomed endpoint.
    if (this.isBreakerOpen(llmConfig) && !this.isSameResolvedConfig(llmConfig, activeConfig)) {
      return this.completeWithConfig(appConfig, activeConfig, request);
    }

    try {
      return await this.completeWithConfig(appConfig, llmConfig, request);
    } catch (error) {
      if (
        !isAccessDeniedError(error) ||
        this.isSameResolvedConfig(llmConfig, activeConfig)
      ) {
        throw error;
      }
      this.tripBreaker(llmConfig, error, activeConfig.model);
      return this.completeWithConfig(appConfig, activeConfig, request);
    }
  }

  private async completeWithConfig(
    appConfig: AppConfig,
    llmConfig: ResolvedMemoryModelConfig,
    request: MemoryCompletionRequest
  ): Promise<MemoryCompletionResponse> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Memory LLM request timed out after ${llmConfig.timeoutMs}ms`));
        }, llmConfig.timeoutMs);
        timeout.unref?.();
      });
      const result = await Promise.race([
        runPiAiOneShot(
          request.userPrompt,
          request.systemPrompt,
          buildAppConfig(appConfig, llmConfig),
          {
            temperature: request.temperature ?? 0,
            maxTokens: request.maxTokens ?? 16_000,
            signal: controller.signal,
          }
        ),
        timeoutPromise,
      ]);
      return { text: result.text };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private breakerKey(config: ResolvedMemoryModelConfig): string {
    return [config.provider, config.customProtocol ?? '', config.baseUrl ?? '', config.model].join(
      '|'
    );
  }

  private isSameResolvedConfig(a: ResolvedMemoryModelConfig, b: ResolvedMemoryModelConfig): boolean {
    return (
      a.provider === b.provider &&
      a.customProtocol === b.customProtocol &&
      a.apiKey === b.apiKey &&
      a.baseUrl === b.baseUrl &&
      a.model === b.model
    );
  }

  private isBreakerOpen(config: ResolvedMemoryModelConfig): boolean {
    const until = this.brokenModels.get(this.breakerKey(config));
    return until !== undefined && until > Date.now();
  }

  private tripBreaker(
    config: ResolvedMemoryModelConfig,
    error: unknown,
    activeModel: string
  ): void {
    if (this.cooldownMs <= 0) {
      return;
    }
    this.brokenModels.set(this.breakerKey(config), Date.now() + this.cooldownMs);
    // Log the status only — provider error text can echo credentials fragments.
    const message = error instanceof Error ? error.message : String(error);
    const status = /\b(?:401|403|404)\b/.exec(message)?.[0] ?? 'access-denied';
    logWarn(
      `[MemoryLLMClient] Memory model "${config.model}" rejected (HTTP ${status}); ` +
        `using active model "${activeModel}" for ${Math.round(this.cooldownMs / 60_000)} min.`
    );
  }

  async embed(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) {
      return [];
    }

    const appConfig = this.getConfig();
    if (!appConfig.memoryRuntime?.useEmbedding) {
      return [];
    }
    const embedConfig = normalizeModelConfig(
      appConfig,
      appConfig.memoryRuntime.embedding,
      'text-embedding-3-small'
    );

    const provider = embedConfig.provider;
    const protocol = embedConfig.customProtocol;
    const isOpenAiCompatible =
      provider === 'openai' ||
      provider === 'openrouter' ||
      provider === 'ollama' ||
      (provider === 'custom' && protocol === 'openai');

    if (!isOpenAiCompatible) {
      logWarn(
        '[MemoryLLMClient] Embedding requested for unsupported provider; returning empty embedding:',
        provider
      );
      return [];
    }

    const resolved =
      provider === 'ollama'
        ? resolveOllamaCredentials({
            provider,
            customProtocol: protocol,
            apiKey: embedConfig.apiKey,
            baseUrl: embedConfig.baseUrl,
          })
        : resolveOpenAICredentials({
            provider,
            customProtocol: protocol,
            apiKey: embedConfig.apiKey,
            baseUrl: embedConfig.baseUrl,
          });

    const client = new OpenAI({
      apiKey: resolved?.apiKey || embedConfig.apiKey,
      baseURL: resolved?.baseUrl || normalizeOpenAICompatibleBaseUrl(embedConfig.baseUrl),
      timeout: embedConfig.timeoutMs,
    });
    const response = await client.embeddings.create({
      model: embedConfig.model,
      input: trimmed,
    });
    return response.data[0]?.embedding || [];
  }
}
