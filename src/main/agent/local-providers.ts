/**
 * @module main/agent/local-providers
 *
 * Cowork 4.0 — Phase 7.3: detection of local inference servers. Only loopback
 * addresses are probed, with a hard timeout, and failures are returned as data
 * instead of thrown.
 */

import type {
  LocalProviderKind,
  LocalProviderPreset,
  LocalProviderProbe,
} from '../../shared/model-routing-types';
import { LOCAL_PROVIDER_KINDS } from '../../shared/model-routing-types';

export const LOCAL_PROVIDER_PRESETS: readonly LocalProviderPreset[] = [
  {
    kind: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434',
    modelsPath: '/api/tags',
    responseShape: 'ollama',
  },
  {
    kind: 'lm-studio',
    label: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234',
    modelsPath: '/v1/models',
    responseShape: 'openai',
  },
  {
    kind: 'vllm',
    label: 'vLLM',
    baseUrl: 'http://127.0.0.1:8000',
    modelsPath: '/v1/models',
    responseShape: 'openai',
  },
  {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    baseUrl: 'http://127.0.0.1:8080',
    modelsPath: '/v1/models',
    responseShape: 'openai',
  },
];

export const DEFAULT_PROBE_TIMEOUT_MS = 1500;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/** Security: local providers are only reachable on loopback. */
export function isLocalBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function presetForKind(kind: LocalProviderKind): LocalProviderPreset | null {
  return LOCAL_PROVIDER_PRESETS.find((preset) => preset.kind === kind) ?? null;
}

export function parseModelList(shape: 'ollama' | 'openai', payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  if (shape === 'ollama') {
    const models = (payload as { models?: unknown }).models;
    if (!Array.isArray(models)) {
      return [];
    }
    return models
      .map((entry) =>
        entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : null
      )
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((entry) => (entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export interface LocalProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

export async function probeLocalProvider(
  kind: LocalProviderKind,
  options: LocalProbeOptions = {}
): Promise<LocalProviderProbe> {
  const preset = presetForKind(kind);
  if (!preset) {
    return {
      kind,
      baseUrl: options.baseUrl ?? '',
      reachable: false,
      models: [],
      error: 'Unknown local provider: ' + String(kind),
    };
  }

  const baseUrl = (options.baseUrl ?? preset.baseUrl).replace(/\/+$/, '');
  if (!isLocalBaseUrl(baseUrl)) {
    return {
      kind,
      baseUrl,
      reachable: false,
      models: [],
      error: 'Refusing to probe a non-loopback address.',
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(200, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(baseUrl + preset.modelsPath, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return { kind, baseUrl, reachable: false, models: [], error: 'HTTP ' + response.status };
    }
    const payload: unknown = await response.json();
    return {
      kind,
      baseUrl,
      reachable: true,
      models: parseModelList(preset.responseShape, payload),
    };
  } catch (error: unknown) {
    return {
      kind,
      baseUrl,
      reachable: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAllLocalProviders(
  options: LocalProbeOptions = {}
): Promise<LocalProviderProbe[]> {
  return Promise.all(LOCAL_PROVIDER_KINDS.map((kind) => probeLocalProvider(kind, options)));
}
