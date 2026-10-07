/**
 * @module main/config/config-store
 *
 * Persistent application configuration.
 *
 * Responsibilities:
 * - electron-store backed config persistence (API keys, model presets, settings)
 * - Config set management: create, rename, delete, switch between config profiles
 * - API key validation and provider credential resolution
 * - Model preset definitions (Anthropic, OpenAI, Gemini, OpenRouter, Ollama)
 *
 * Dependencies: electron-store, auth-utils, api-model-presets
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Store, { type Options as StoreOptions } from 'electron-store';
import { log, logWarn, logError } from '../utils/logger';
import {
  createEncryptedStoreWithKeyRotation,
  getLegacyDerivedKeyHexes,
} from '../utils/store-encryption';
import { resolveStoreEncryptionKey, StoreKeyUnreadableError } from '../utils/store-key-manager';
import {
  isOpenAIProvider,
  isOllamaLegacyCustomOpenAIConfig,
  normalizeAnthropicBaseUrl,
  normalizeOllamaBaseUrl,
  resolveOllamaCredentials,
  resolveOpenAICredentials,
  shouldAllowEmptyOllamaApiKey,
  shouldAllowEmptyAnthropicApiKey,
  shouldAllowEmptyGeminiApiKey,
  shouldUseAnthropicAuthToken,
} from './auth-utils';
import { API_PROVIDER_PRESETS, PI_AI_CURATED_PRESETS } from '../../shared/api-model-presets';
import type { ImageGenerationConfig } from '../../shared/types';
import type { SecretSourceMap } from '../../shared/secret-source';
import { normalizeSecretSourceMap } from './secret-source-normalize';
import { getSecretResolver, withBudget } from './secret-resolver';

/**
 * Application configuration schema
 */
export type ProviderType = 'openrouter' | 'anthropic' | 'custom' | 'openai' | 'gemini' | 'ollama';
export type CustomProtocolType = 'anthropic' | 'openai' | 'gemini';
export type AppTheme = 'dark' | 'light' | 'system';
export type ProviderProfileKey =
  | 'openrouter'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'custom:anthropic'
  | 'custom:openai'
  | 'custom:gemini';
export type ConfigSetId = string;
type CreateSetMode = 'blank' | 'clone';

export interface CreateConfigSetPayload {
  name: string;
  mode?: CreateSetMode;
  fromSetId?: string;
}

export interface ProviderProfile {
  apiKey: string;
  baseUrl?: string;
  model: string;
  customModels?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface ApiConfigSet {
  id: ConfigSetId;
  name: string;
  isSystem?: boolean;
  provider: ProviderType;
  customProtocol: CustomProtocolType;
  activeProfileKey: ProviderProfileKey;
  profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>;
  enableThinking: boolean;
  updatedAt: string;
}

export interface AppConfig {
  // API Provider
  provider: ProviderType;

  // API credentials
  apiKey: string;
  baseUrl?: string;
  customProtocol?: CustomProtocolType;

  // Model selection
  model: string;
  contextWindow?: number;
  maxTokens?: number;

  // Active profile
  activeProfileKey: ProviderProfileKey;
  profiles: Partial<Record<ProviderProfileKey, ProviderProfile>>;

  // Active config set
  activeConfigSetId: ConfigSetId;
  configSets: ApiConfigSet[];

  // Optional: Claude Code CLI path override
  agentCliPath?: string;

  // Optional: Default working directory
  defaultWorkdir?: string;

  // Optional: Global skills storage directory
  globalSkillsPath?: string;

  // Developer logs
  enableDevLogs: boolean;

  // UI theme preference
  theme: AppTheme;

  // Sandbox mode (WSL/Lima isolation)
  sandboxEnabled: boolean;

  // Remote sandbox backend (ssh/daytona); connection params live in env vars
  sandboxRemoteMode: 'off' | 'ssh' | 'daytona';

  // Global memory toggle
  memoryEnabled: boolean;

  // Personalization: free-form user instructions injected into agent system prompts
  coworkInstructions: string;

  // Optional native web_search provider keys (empty = DuckDuckGo fallback, no key needed)
  tavilyApiKey: string;
  braveApiKey: string;

  // Tray icon + global Alt+Space toggle (background quick access)
  trayEnabled: boolean;

  // Agent-to-Agent (A2A) server: expose this app as an A2A agent over
  // loopback HTTP. Off by default; the token is a bearer secret stored in
  // this same encrypted store and never exported to plaintext config.
  a2aEnabled: boolean;
  a2aToken: string;
  a2aPort: number;

  // Dedicated memory runtime config
  memoryRuntime: MemoryRuntimeConfig;

  // Sub-agent swarm settings (profile resolution + guardrails)
  subAgents?: SubAgentsConfig;

  // Dedicated image read/generation profile (separate from text ConfigSets)
  imageGeneration?: ImageGenerationConfig;

  // OpenJev "System One" routing hint (optional, off by default)
  openjev?: OpenJevConfig;

  // Enable thinking mode (show thinking steps)
  enableThinking: boolean;

  // First run flag
  isConfigured: boolean;

  // Session resumption — persisted across restarts (months-long projects)
  lastActiveSessionId?: string;
  lastActiveCwd?: string;
  lastActiveSessionUpdatedAt?: number; // epoch ms — used to show "last seen X days ago"

  // Stream liveness guardrails (see stream-liveness.ts)
  streamTimeout?: StreamTimeoutConfig;

  /**
   * Per-ConfigSet secret source. Absent or `local` means the key lives in this
   * encrypted store (the historical default). When a ConfigSet names
   * Bitwarden or 1Password, `profiles[*].apiKey` holds only the manager's
   * REFERENCE (an item id or `op://vault/item/field`) — the real value is
   * resolved at call time and never persisted here.
   */
  secretSources?: SecretSourceMap;
}

/**
 * How long a turn may stay silent before it is aborted, and how long a single
 * tool execution may run. They are separate because a tool in flight produces
 * no stream events by design: the inactivity window governs waiting on the
 * model, the ceiling governs work that is actually running.
 */
export interface StreamTimeoutConfig {
  /** No stream event at all for this long → abort. Default 5 min. */
  activityTimeoutMs: number;
  /** One tool execution longer than this → abort. Default 15 min. 0 = no ceiling. */
  toolExecutionCeilingMs: number;
}

export interface MemoryModelRuntimeConfig {
  inheritFromActive: boolean;
  provider?: ProviderType;
  customProtocol?: CustomProtocolType;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
}

export interface MemoryRuntimeConfig {
  llm: MemoryModelRuntimeConfig;
  embedding: MemoryModelRuntimeConfig;
  useEmbedding: boolean;
  maxNavSteps: number;
  ingestionConcurrency: number;
  storageRoot?: string;
  evalEnabled?: boolean;
  evalWorkspaces?: string[];
  evalMaxRounds?: number;
  evalArtifactsRoot?: string;
  promptIterationRounds?: number;
}

export type SubAgentRoleKey = 'architect' | 'developer' | 'reviewer' | 'security';

export interface OpenJevConfig {
  /** Off by default until validated in real conditions. */
  enabled: boolean;
  /** Base URL of the local OpenJev decision server. */
  baseUrl: string;
}

export interface SubAgentProfileSelection {
  configSetId: string;
  /** Model id inside the configSet; empty/undefined = the set's active model. */
  modelId?: string;
  /** Display name for the role (e.g. "Dev Backend"); empty = generic role name. */
  personaName?: string;
  /** Role system prompt, ADDED to project/agent instructions (never replaces). */
  systemPrompt?: string;
}

export interface SubAgentsConfig {
  /** ConfigSet used for sub-agents; empty string inherits the active profile. */
  configSetId: string;
  /** Model id inside the selected configSet; empty/undefined = its active model. */
  modelId?: string;
  /**
   * Per-role overrides. Legacy configs store a bare configSet id string —
   * normalizeSubAgentsConfig migrates it to { configSetId } on read.
   */
  perRole: Partial<Record<SubAgentRoleKey, SubAgentProfileSelection>>;
  /**
   * Dynamic criticality tiers. A task on the structural critical path (other
   * tasks depend on it) uses the `critical` selection when configured;
   * terminal tasks use `economical`. Unconfigured tiers fall back to
   * perRole > configSet > inherited, so this stays fully opt-in.
   */
  criticality?: {
    critical?: SubAgentProfileSelection;
    economical?: SubAgentProfileSelection;
  };
  /** Per-sub-agent execution timeout in ms (default 120s, capped at 300s). */
  timeoutMs: number;
  /** Maximum sub-agents running at once (default 2, capped at 8). */
  maxConcurrent: number;
  /**
   * OPT-IN: type-check a sub-agent's modified files with a real TypeScript
   * Program, on top of the always-on AST syntax check.
   *
   * Off by default because it is expensive: measured on this repo, a full
   * Program costs ~2.4 s and ~1 GB RSS cold (against 23 ms / 24 MB for the
   * AST parse). The Program is cached per project, so a warm pass is far
   * cheaper, but the first pass is heavy enough that it must not be
   * unconditional.
   */
  semanticVerification?: boolean;
  /** Time budget for one semantic pass in ms (default 20000). */
  semanticVerificationBudgetMs?: number;
}

const DEFAULT_CONFIG_SET_ID = 'default';
const MAX_CONFIG_SET_COUNT = 20;
const LOCAL_ANTHROPIC_PLACEHOLDER_KEY = 'sk-ant-local-proxy';
const DIRECT_READ_KEYS = new Set<keyof AppConfig>([
  'provider',
  'apiKey',
  'baseUrl',
  'customProtocol',
  'activeProfileKey',
  'activeConfigSetId',
  'agentCliPath',
  'defaultWorkdir',
  'globalSkillsPath',
  'enableDevLogs',
  'theme',
  'sandboxEnabled',
  'sandboxRemoteMode',
  'memoryEnabled',
  'coworkInstructions',
  'enableThinking',
  'isConfigured',
]);

/**
 * Fields safe to expose in the plaintext config file.
 * NEVER include API keys, tokens, or other secrets.
 */
export const EXPORTABLE_FIELDS: (keyof AppConfig)[] = [
  'defaultWorkdir',
  'globalSkillsPath',
  'theme',
  'enableDevLogs',
  'sandboxEnabled',
  'enableThinking',
  'memoryEnabled',
  'coworkInstructions',
  'trayEnabled',
  'model',
  'provider',
  'contextWindow',
  'maxTokens',
];

/**
 * Per-field type/value validators applied when importing the plaintext config
 * file (see `importSafeConfig`). Fields not listed here are accepted as-is.
 */
export const FIELD_VALIDATORS: Record<string, (v: unknown) => boolean> = {
  defaultWorkdir: (v) => typeof v === 'string',
  globalSkillsPath: (v) => typeof v === 'string',
  theme: (v) => v === 'dark' || v === 'light' || v === 'system',
  enableDevLogs: (v) => typeof v === 'boolean',
  sandboxEnabled: (v) => typeof v === 'boolean',
  sandboxRemoteMode: (v) => v === 'off' || v === 'ssh' || v === 'daytona',
  enableThinking: (v) => typeof v === 'boolean',
  memoryEnabled: (v) => typeof v === 'boolean',
  coworkInstructions: (v) => typeof v === 'string',
  trayEnabled: (v) => typeof v === 'boolean',
  model: (v) => typeof v === 'string',
  provider: (v) =>
    typeof v === 'string' &&
    ['openrouter', 'anthropic', 'custom', 'openai', 'gemini', 'ollama'].includes(v),
  contextWindow: (v) => typeof v === 'number' && v > 0,
  maxTokens: (v) => typeof v === 'number' && v > 0,
  streamTimeout: (v) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { activityTimeoutMs?: unknown }).activityTimeoutMs === 'number' &&
    (v as { activityTimeoutMs: number }).activityTimeoutMs > 0 &&
    typeof (v as { toolExecutionCeilingMs?: unknown }).toolExecutionCeilingMs === 'number' &&
    (v as { toolExecutionCeilingMs: number }).toolExecutionCeilingMs >= 0,
};

const defaultProfiles: Record<ProviderProfileKey, ProviderProfile> = {
  openrouter: {
    apiKey: '',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4-6',
    contextWindow: 1_000_000,
    maxTokens: 384000,
  },
  anthropic: {
    apiKey: '',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-6',
    contextWindow: 1_000_000,
    maxTokens: 384000,
  },
  openai: {
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
    contextWindow: 1_000_000,
    maxTokens: 384000,
  },
  ollama: {
    apiKey: '',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    contextWindow: 1_000_000,
    maxTokens: 384000,
  },
  gemini: {
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
    contextWindow: 1_000_000,
    maxTokens: 384000,
  },
  'custom:anthropic': {
    apiKey: '',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    model: 'glm-5',
    contextWindow: 1_000_000,
    maxTokens: 384000,
  },
  'custom:openai': {
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4',
    contextWindow: 1_000_000,
    maxTokens: 384000,
  },
  'custom:gemini': {
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.5-flash',
    contextWindow: 1_000_000,
    maxTokens: 384000,
  },
};

const defaultConfigSet: ApiConfigSet = {
  id: DEFAULT_CONFIG_SET_ID,
  name: 'Profil par défaut',
  isSystem: true,
  provider: 'openrouter',
  customProtocol: 'anthropic',
  activeProfileKey: 'openrouter',
  profiles: defaultProfiles,
  enableThinking: false,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

/**
 * Stream liveness defaults. The inactivity window keeps its historical 5 min
 * (it only ever fires when the model itself is silent), while the tool ceiling
 * is deliberately much larger: a heavy build legitimately runs for many
 * minutes, and only a genuinely stuck tool should hit it.
 */
const DEFAULT_STREAM_TIMEOUT: StreamTimeoutConfig = {
  activityTimeoutMs: 5 * 60 * 1000,
  toolExecutionCeilingMs: 15 * 60 * 1000,
};

// Sub-agents inherit the active profile by default — zero surprise for a
// user who never touches this section.
const DEFAULT_SUB_AGENTS: SubAgentsConfig = {
  configSetId: '',
  perRole: {},
  timeoutMs: 120_000,
  maxConcurrent: 2,
};

// Image work inherits the active profile until the user pins a dedicated
// images ConfigSet — image models are billed per image, not per token, so the
// choice is explicit and never silently taken from the chat model.
const DEFAULT_IMAGE_GENERATION: ImageGenerationConfig = {
  configSetId: '',
  costConfirmThresholdUsd: 0.05,
};

const defaultConfig: AppConfig = {
  provider: defaultConfigSet.provider,
  apiKey: defaultProfiles.openrouter.apiKey,
  baseUrl: defaultProfiles.openrouter.baseUrl,
  customProtocol: defaultConfigSet.customProtocol,
  model: defaultProfiles.openrouter.model,
  activeProfileKey: defaultConfigSet.activeProfileKey,
  profiles: defaultProfiles,
  activeConfigSetId: DEFAULT_CONFIG_SET_ID,
  configSets: [defaultConfigSet],
  agentCliPath: '',
  defaultWorkdir: '',
  globalSkillsPath: '',
  enableDevLogs: false,
  theme: 'light',
  sandboxEnabled: false,
  sandboxRemoteMode: 'off',
  memoryEnabled: true,
  coworkInstructions: '',
  tavilyApiKey: '',
  braveApiKey: '',
  // Close button quits for real by default; the tray is an explicit opt-in.
  trayEnabled: false,
  // A2A server is opt-in; the token is generated on first enable.
  a2aEnabled: false,
  a2aToken: '',
  a2aPort: 19889,
  memoryRuntime: {
    llm: {
      inheritFromActive: true,
      provider: undefined,
      customProtocol: undefined,
      apiKey: '',
      baseUrl: '',
      model: '',
      timeoutMs: 180000,
    },
    embedding: {
      inheritFromActive: true,
      provider: undefined,
      customProtocol: undefined,
      apiKey: '',
      baseUrl: '',
      model: 'text-embedding-3-small',
      timeoutMs: 180000,
    },
    useEmbedding: false,
    maxNavSteps: 2,
    // Sequential by default: memory summarization shares the provider rate
    // limit with live conversations, so parallel extraction causes 429s.
    ingestionConcurrency: 1,
    storageRoot: '',
    evalEnabled: false,
    evalWorkspaces: [],
    evalMaxRounds: 12,
    evalArtifactsRoot: '',
    promptIterationRounds: 2,
  },
  subAgents: DEFAULT_SUB_AGENTS,
  imageGeneration: DEFAULT_IMAGE_GENERATION,
  openjev: { enabled: false, baseUrl: 'http://127.0.0.1:8080' },
  streamTimeout: DEFAULT_STREAM_TIMEOUT,
  enableThinking: false,
  isConfigured: false,
};

export const PROVIDER_PRESETS = API_PROVIDER_PRESETS;
const PI_AI_CURATED: Record<string, { piProvider: string; pick: string[] }> = PI_AI_CURATED_PRESETS;

// Cached dynamic presets — populated once by async import.
let cachedDynamicPresets: typeof PROVIDER_PRESETS | null = null;

/**
 * Build model presets dynamically from pi-ai registry.
 * Returns PROVIDER_PRESETS with models arrays replaced by registry data where available.
 * Uses async import() because pi-ai is ESM-only.
 */
export async function getPiAiModelPresets(): Promise<typeof PROVIDER_PRESETS> {
  if (cachedDynamicPresets) return cachedDynamicPresets;

  try {
    const { getModels } = (await import('@mariozechner/pi-ai')) as {
      getModels: (provider: string) => Array<{ id: string; name: string }> | undefined;
    };

    const result = { ...PROVIDER_PRESETS } as Record<
      string,
      (typeof PROVIDER_PRESETS)[keyof typeof PROVIDER_PRESETS]
    >;

    for (const [providerKey, curated] of Object.entries(PI_AI_CURATED)) {
      const preset = PROVIDER_PRESETS[providerKey as keyof typeof PROVIDER_PRESETS];
      if (!preset) continue;

      const registryModels = getModels(curated.piProvider);
      if (!registryModels || registryModels.length === 0) continue;

      const registryIds = new Set(registryModels.map((m) => m.id));
      const picked = curated.pick
        .filter((id) => registryIds.has(id))
        .map((id) => {
          const reg = registryModels.find((m) => m.id === id);
          return { id, name: reg?.name || id };
        });

      if (picked.length > 0) {
        result[providerKey] = { ...preset, models: picked };
      }
    }

    cachedDynamicPresets = result as unknown as typeof PROVIDER_PRESETS;
    return cachedDynamicPresets;
  } catch (err) {
    logWarn('[ConfigStore] Failed to load pi-ai model presets, using hardcoded fallback:', err);
    return PROVIDER_PRESETS;
  }
}

const PROFILE_KEYS: ProviderProfileKey[] = [
  'openrouter',
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'custom:anthropic',
  'custom:openai',
  'custom:gemini',
];
const SUB_AGENT_ROLE_KEYS: SubAgentRoleKey[] = ['architect', 'developer', 'reviewer', 'security'];
const VALID_THEMES: AppTheme[] = ['dark', 'light', 'system'];

function isProviderType(value: unknown): value is ProviderType {
  return (
    value === 'openrouter' ||
    value === 'anthropic' ||
    value === 'custom' ||
    value === 'openai' ||
    value === 'gemini' ||
    value === 'ollama'
  );
}

function isCustomProtocol(value: unknown): value is CustomProtocolType {
  return value === 'anthropic' || value === 'openai' || value === 'gemini';
}

function isProfileKey(value: unknown): value is ProviderProfileKey {
  return typeof value === 'string' && PROFILE_KEYS.includes(value as ProviderProfileKey);
}

function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && VALID_THEMES.includes(value as AppTheme);
}

function isMemoryModelRuntimeConfig(value: unknown): value is Partial<MemoryModelRuntimeConfig> {
  return typeof value === 'object' && value !== null;
}

function normalizeMemoryModelRuntimeConfig(
  raw: unknown,
  fallback: MemoryModelRuntimeConfig
): MemoryModelRuntimeConfig {
  const value = isMemoryModelRuntimeConfig(raw) ? raw : {};
  return {
    inheritFromActive: toBoolean(value.inheritFromActive, fallback.inheritFromActive),
    provider: isProviderType(value.provider) ? value.provider : fallback.provider,
    customProtocol: isCustomProtocol(value.customProtocol)
      ? value.customProtocol
      : fallback.customProtocol,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey : fallback.apiKey,
    baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : fallback.baseUrl,
    model: typeof value.model === 'string' ? value.model : fallback.model,
    timeoutMs:
      typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs)
        ? Math.max(5000, Math.round(value.timeoutMs))
        : fallback.timeoutMs,
  };
}

function normalizeMemoryRuntimeConfig(raw: unknown): MemoryRuntimeConfig {
  const value =
    typeof raw === 'object' && raw !== null ? (raw as Partial<MemoryRuntimeConfig>) : {};
  return {
    llm: normalizeMemoryModelRuntimeConfig(value.llm, defaultConfig.memoryRuntime.llm),
    embedding: normalizeMemoryModelRuntimeConfig(
      value.embedding,
      defaultConfig.memoryRuntime.embedding
    ),
    useEmbedding: toBoolean(value.useEmbedding, defaultConfig.memoryRuntime.useEmbedding),
    maxNavSteps:
      typeof value.maxNavSteps === 'number' && Number.isFinite(value.maxNavSteps)
        ? Math.max(0, Math.min(4, Math.round(value.maxNavSteps)))
        : defaultConfig.memoryRuntime.maxNavSteps,
    ingestionConcurrency:
      typeof value.ingestionConcurrency === 'number' && Number.isFinite(value.ingestionConcurrency)
        ? Math.max(1, Math.min(16, Math.round(value.ingestionConcurrency)))
        : defaultConfig.memoryRuntime.ingestionConcurrency,
    storageRoot:
      typeof value.storageRoot === 'string'
        ? value.storageRoot
        : defaultConfig.memoryRuntime.storageRoot,
    evalEnabled: toBoolean(value.evalEnabled, defaultConfig.memoryRuntime.evalEnabled ?? false),
    evalWorkspaces: Array.isArray(value.evalWorkspaces)
      ? value.evalWorkspaces.filter((item): item is string => typeof item === 'string')
      : defaultConfig.memoryRuntime.evalWorkspaces,
    evalMaxRounds:
      typeof value.evalMaxRounds === 'number' && Number.isFinite(value.evalMaxRounds)
        ? Math.max(1, Math.min(100, Math.round(value.evalMaxRounds)))
        : defaultConfig.memoryRuntime.evalMaxRounds,
    evalArtifactsRoot:
      typeof value.evalArtifactsRoot === 'string'
        ? value.evalArtifactsRoot
        : defaultConfig.memoryRuntime.evalArtifactsRoot,
    promptIterationRounds:
      typeof value.promptIterationRounds === 'number' &&
      Number.isFinite(value.promptIterationRounds)
        ? Math.max(0, Math.min(10, Math.round(value.promptIterationRounds)))
        : defaultConfig.memoryRuntime.promptIterationRounds,
  };
}

/** Normalize one { configSetId, modelId?, personaName?, systemPrompt? } selection. */
function normalizeProfileSelection(raw: unknown): SubAgentProfileSelection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const selection = raw as {
    configSetId?: unknown;
    modelId?: unknown;
    personaName?: unknown;
    systemPrompt?: unknown;
  };
  if (typeof selection.configSetId !== 'string' || !selection.configSetId.trim()) return undefined;
  return {
    configSetId: selection.configSetId.trim(),
    modelId:
      typeof selection.modelId === 'string' && selection.modelId.trim()
        ? selection.modelId.trim()
        : undefined,
    personaName:
      typeof selection.personaName === 'string' && selection.personaName.trim()
        ? selection.personaName.trim()
        : undefined,
    systemPrompt:
      typeof selection.systemPrompt === 'string' && selection.systemPrompt.trim()
        ? selection.systemPrompt.trim()
        : undefined,
  };
}

export function normalizeSubAgentsConfig(raw: unknown): SubAgentsConfig {
  const value = typeof raw === 'object' && raw !== null ? (raw as Partial<SubAgentsConfig>) : {};
  const perRole: Partial<Record<SubAgentRoleKey, SubAgentProfileSelection>> = {};
  if (typeof value.perRole === 'object' && value.perRole !== null) {
    for (const key of SUB_AGENT_ROLE_KEYS) {
      // Legacy format: perRole[role] was a bare configSet id string.
      const entry = (value.perRole as Record<string, unknown>)[key];
      if (typeof entry === 'string' && entry.trim()) {
        perRole[key] = { configSetId: entry.trim() };
      } else {
        const selection = normalizeProfileSelection(entry);
        if (selection) perRole[key] = selection;
      }
    }
  }

  const criticality: NonNullable<SubAgentsConfig['criticality']> = {};
  if (typeof value.criticality === 'object' && value.criticality !== null) {
    const critical = normalizeProfileSelection(value.criticality.critical);
    const economical = normalizeProfileSelection(value.criticality.economical);
    if (critical) criticality.critical = critical;
    if (economical) criticality.economical = economical;
  }

  return {
    configSetId:
      typeof value.configSetId === 'string'
        ? value.configSetId.trim()
        : DEFAULT_SUB_AGENTS.configSetId,
    modelId:
      typeof value.modelId === 'string' && value.modelId.trim() ? value.modelId.trim() : undefined,
    perRole,
    ...(Object.keys(criticality).length > 0 ? { criticality } : {}),
    timeoutMs:
      typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs)
        ? Math.max(10_000, Math.min(300_000, Math.round(value.timeoutMs)))
        : DEFAULT_SUB_AGENTS.timeoutMs,
    maxConcurrent:
      typeof value.maxConcurrent === 'number' && Number.isFinite(value.maxConcurrent)
        ? Math.max(1, Math.min(8, Math.round(value.maxConcurrent)))
        : DEFAULT_SUB_AGENTS.maxConcurrent,
    // Opt-in only: absent, or any non-`true` value, stays OFF. Never coerce a
    // truthy non-boolean here — a stray string must not silently enable a
    // ~1 GB verification pass. The key is omitted when unset (rather than
    // written as `false`) so a store round-trip through the UI does not gain a
    // field the user never set — same convention as `criticality`.
    ...(value.semanticVerification !== undefined
      ? { semanticVerification: value.semanticVerification === true }
      : {}),
    ...(typeof value.semanticVerificationBudgetMs === 'number' &&
    Number.isFinite(value.semanticVerificationBudgetMs)
      ? {
          semanticVerificationBudgetMs: Math.max(
            1_000,
            Math.min(120_000, Math.round(value.semanticVerificationBudgetMs))
          ),
        }
      : {}),
  };
}

const IMAGE_PROVIDER_VALUES: ReadonlySet<string> = new Set([
  'openrouter',
  'anthropic',
  'custom',
  'openai',
  'gemini',
  'ollama',
]);

const IMAGE_CUSTOM_PROTOCOLS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'gemini']);

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Normalize the dedicated image profile.
 *
 * Three resolution modes, in order of precedence:
 *   1. explicit provider + model  → any provider, own credentials (no ConfigSet)
 *   2. pinned ConfigSet           → that set's provider/model
 *   3. nothing                    → inherit the active ConfigSet (configSetId: '')
 *
 * Unknown/invalid provider or protocol values are dropped rather than trusted,
 * so a corrupted config can never select a bogus route.
 */
export function normalizeImageGenerationConfig(raw: unknown): ImageGenerationConfig {
  const value =
    typeof raw === 'object' && raw !== null ? (raw as Partial<ImageGenerationConfig>) : {};
  const threshold = value.costConfirmThresholdUsd;
  const provider = optionalTrimmedString(value.provider);
  const customProtocol = optionalTrimmedString(value.customProtocol);
  return {
    configSetId: typeof value.configSetId === 'string' ? value.configSetId.trim() : '',
    modelId: optionalTrimmedString(value.modelId),
    costConfirmThresholdUsd:
      typeof threshold === 'number' && Number.isFinite(threshold)
        ? Math.max(0, Math.min(100, threshold))
        : DEFAULT_IMAGE_GENERATION.costConfirmThresholdUsd,
    provider:
      provider && IMAGE_PROVIDER_VALUES.has(provider) ? (provider as ProviderType) : undefined,
    customProtocol:
      customProtocol && IMAGE_CUSTOM_PROTOCOLS.has(customProtocol)
        ? (customProtocol as CustomProtocolType)
        : undefined,
    apiKey: optionalTrimmedString(value.apiKey),
    baseUrl: optionalTrimmedString(value.baseUrl),
    model: optionalTrimmedString(value.model),
  };
}

function normalizeOpenJevConfig(raw: unknown): OpenJevConfig {
  const r = (raw ?? {}) as Partial<OpenJevConfig>;
  return {
    enabled: r.enabled === true,
    baseUrl:
      typeof r.baseUrl === 'string' && r.baseUrl.trim()
        ? r.baseUrl.trim()
        : 'http://127.0.0.1:8080',
  };
}

function profileKeyFromProvider(
  provider: ProviderType,
  customProtocol: CustomProtocolType = 'anthropic'
): ProviderProfileKey {
  if (provider !== 'custom') {
    return provider;
  }
  if (customProtocol === 'openai') {
    return 'custom:openai';
  }
  if (customProtocol === 'gemini') {
    return 'custom:gemini';
  }
  return 'custom:anthropic';
}

function profileKeyToProvider(profileKey: ProviderProfileKey): {
  provider: ProviderType;
  customProtocol: CustomProtocolType;
} {
  if (profileKey === 'custom:openai') {
    return { provider: 'custom', customProtocol: 'openai' };
  }
  if (profileKey === 'custom:gemini') {
    return { provider: 'custom', customProtocol: 'gemini' };
  }
  if (profileKey === 'custom:anthropic') {
    return { provider: 'custom', customProtocol: 'anthropic' };
  }
  if (profileKey === 'openai') {
    return { provider: 'openai', customProtocol: 'openai' };
  }
  if (profileKey === 'gemini') {
    return { provider: 'gemini', customProtocol: 'gemini' };
  }
  if (profileKey === 'ollama') {
    return { provider: 'ollama', customProtocol: 'openai' };
  }
  return { provider: profileKey, customProtocol: 'anthropic' };
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nowISO(): string {
  return new Date().toISOString();
}

function normalizeCustomProtocol(
  value: CustomProtocolType | undefined,
  fallback: CustomProtocolType = 'anthropic'
): CustomProtocolType {
  if (value === 'openai' || value === 'gemini' || value === 'anthropic') {
    return value;
  }
  return fallback;
}

function defaultProtocolForProvider(provider: ProviderType): CustomProtocolType {
  if (provider === 'openai' || provider === 'ollama') {
    return 'openai';
  }
  if (provider === 'gemini') {
    return 'gemini';
  }
  return 'anthropic';
}

export class ConfigStore {
  private store: Store<AppConfig>;
  /**
   * Non-null while an external vault resolution is still in flight. Boot
   * defers it off the critical path (see `applyToEnv` budget option); session
   * start awaits it only in that window, and is free otherwise.
   */
  private pendingExternalSecrets: Promise<void> | null = null;

  constructor() {
    const storeOptions: StoreOptions<AppConfig> & { projectName?: string } = {
      name: 'config',
      projectName: 'open-cowork',
      defaults: defaultConfig,
    };

    // Cast to satisfy the Record<string, unknown> constraint of the encrypted store utility;
    // AppConfig is a structurally compatible object type at runtime.
    type AppConfigRecord = AppConfig & Record<string, unknown>;

    // Security: the stable key is now a per-installation random key protected
    // by the OS keyring (safeStorage) instead of a scrypt over public source
    // constants. The old derived keys remain as legacy fallbacks so existing
    // installs migrate transparently via key rotation.
    let stableKey = 'open-cowork-config-stable-v1';
    let keyringLegacyKeys: string[] = [];
    let degradedStoreDir: string | null = null;
    try {
      stableKey = resolveStoreEncryptionKey();
      keyringLegacyKeys = ['open-cowork-config-stable-v1'];
    } catch (keyError) {
      if (keyError instanceof StoreKeyUnreadableError) {
        // The key file exists but this process cannot decode it — almost always
        // a re-signed build or a keychain that is still locked, not a wrong key.
        //
        // Opening the real store here is what destroyed users' configuration:
        // `createEncryptedStoreWithKeyRotation` cannot decrypt it with any
        // available key, so it moves `config.json` aside and starts from
        // defaults — taking every configured provider with it, permanently.
        //
        // Instead, run this session on a throwaway directory. The real
        // `config.json` is never read or written, so the next launch (with a
        // readable keychain) finds everything intact.
        degradedStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-config-unreadable-key-'));
        logError(
          '[ConfigStore] Store key is unreadable — running on a throwaway store; the existing config.json was NOT modified and will be used again once the key can be read.',
          keyError.message
        );
      } else {
        logWarn(
          '[ConfigStore] Falling back to derived store key (keyring unavailable):',
          keyError instanceof Error ? keyError.message : String(keyError)
        );
      }
    }

    if (degradedStoreDir) {
      storeOptions.cwd = degradedStoreDir;
    }

    this.store = createEncryptedStoreWithKeyRotation<AppConfigRecord>({
      stableKey,
      legacyKeys: [
        'open-cowork-config-v1',
        ...keyringLegacyKeys,
        ...getLegacyDerivedKeyHexes({
          moduleDirname: __dirname,
          stableSeed: 'open-cowork-config-stable-v1',
          legacySeed: 'open-cowork-config-v1',
          salt: 'open-cowork-config-salt',
        }),
      ],
      storeOptions: storeOptions as StoreOptions<AppConfigRecord> & { projectName?: string },
      logPrefix: '[ConfigStore]',
      log,
      warn: logWarn,
    }) as unknown as Store<AppConfig>;
    this.ensureNormalized();
  }

  private ensureNormalized(): void {
    const normalized = this.normalizeConfig(this.store.store as Partial<AppConfig>);
    this.store.set(normalized);
  }

  /**
   * Auto-fix model IDs that don't match pi-ai registry format.
   * Non-destructive: only applies known safe transformations at read time.
   */
  private normalizeModelIds(config: AppConfig): void {
    // Fix legacy "gemini/gemini-*" → "gemini-*" for gemini profiles
    // (pi-ai google provider uses bare model IDs, not prefixed)
    for (const key of ['gemini', 'custom:gemini'] as const) {
      const profile = config.profiles?.[key];
      if (profile?.model?.startsWith('gemini/')) {
        profile.model = profile.model.slice('gemini/'.length);
      }
    }
    // Fix openrouter baseUrl: /api → /api/v1
    const orProfile = config.profiles?.openrouter;
    if (orProfile?.baseUrl === 'https://openrouter.ai/api') {
      orProfile.baseUrl = 'https://openrouter.ai/api/v1';
    }
    // Fix openrouter model IDs: dashes → dots for claude models
    // Registry uses "anthropic/claude-sonnet-4.5", old config had "anthropic/claude-sonnet-4-5"
    if (orProfile?.model) {
      orProfile.model = orProfile.model.replace(
        /^(anthropic\/claude-(?:sonnet|opus|haiku)-\d+)-(\d+)/,
        '$1.$2'
      );
    }
    // Also fix the flat model field (legacy compat)
    if (config.model?.startsWith('gemini/')) {
      config.model = config.model.slice('gemini/'.length);
    }
    // Fix flat baseUrl for openrouter
    if (config.baseUrl === 'https://openrouter.ai/api' && config.provider === 'openrouter') {
      config.baseUrl = 'https://openrouter.ai/api/v1';
    }
  }

  private getDefaultProfile(profileKey: ProviderProfileKey): ProviderProfile {
    const fallback = defaultProfiles[profileKey];
    return {
      apiKey: fallback.apiKey,
      baseUrl: fallback.baseUrl,
      model: fallback.model,
    };
  }

  private normalizeProfile(
    profileKey: ProviderProfileKey,
    profile: Partial<ProviderProfile> | undefined
  ): ProviderProfile {
    const fallback = this.getDefaultProfile(profileKey);
    const model =
      typeof profile?.model === 'string' && profile.model.trim()
        ? profile.model.trim()
        : fallback.model;
    const rawBaseUrl =
      typeof profile?.baseUrl === 'string' && profile.baseUrl.trim()
        ? profile.baseUrl.trim()
        : fallback.baseUrl;
    const baseUrl =
      profileKey === 'ollama' ? normalizeOllamaBaseUrl(rawBaseUrl) || fallback.baseUrl : rawBaseUrl;
    const result: ProviderProfile = {
      apiKey: typeof profile?.apiKey === 'string' ? profile.apiKey : '',
      baseUrl,
      model,
    };
    // Preserve optional numeric fields so callers don't silently lose user-set values
    if (typeof profile?.contextWindow === 'number' && profile.contextWindow > 0) {
      result.contextWindow = profile.contextWindow;
    }
    if (typeof profile?.maxTokens === 'number' && profile.maxTokens > 0) {
      result.maxTokens = profile.maxTokens;
    }
    // Preserve user-configured custom model list
    if (Array.isArray(profile?.customModels) && profile.customModels.length > 0) {
      result.customModels = profile.customModels.filter(Boolean);
    }
    return result;
  }

  private cloneProfiles(
    profiles: Partial<Record<ProviderProfileKey, ProviderProfile>> | undefined
  ): Record<ProviderProfileKey, ProviderProfile> {
    const cloned = {} as Record<ProviderProfileKey, ProviderProfile>;
    for (const key of PROFILE_KEYS) {
      cloned[key] = this.normalizeProfile(key, profiles?.[key]);
    }
    return cloned;
  }

  private normalizeLegacyProjection(raw: Partial<AppConfig>): {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    activeProfileKey: ProviderProfileKey;
    profiles: Record<ProviderProfileKey, ProviderProfile>;
    enableThinking: boolean;
  } {
    const provider = isProviderType(raw.provider) ? raw.provider : defaultConfig.provider;
    const customProtocol: CustomProtocolType = isCustomProtocol(raw.customProtocol)
      ? raw.customProtocol
      : defaultProtocolForProvider(provider);
    const derivedProfileKey = profileKeyFromProvider(provider, customProtocol);

    const hasAnyRawProfiles = Boolean(raw.profiles && Object.keys(raw.profiles).length > 0);
    const hasProfileUserData = PROFILE_KEYS.some((key) => {
      const rawProfile = raw.profiles?.[key];
      if (!rawProfile) {
        return false;
      }
      const fallback = this.getDefaultProfile(key);
      if (typeof rawProfile.apiKey === 'string' && rawProfile.apiKey.trim()) {
        return true;
      }
      if (
        typeof rawProfile.baseUrl === 'string' &&
        rawProfile.baseUrl.trim() &&
        rawProfile.baseUrl.trim() !== fallback.baseUrl
      ) {
        return true;
      }
      if (
        typeof rawProfile.model === 'string' &&
        rawProfile.model.trim() &&
        rawProfile.model.trim() !== fallback.model
      ) {
        return true;
      }
      return false;
    });
    const shouldUseLegacyProjection = !hasAnyRawProfiles || !hasProfileUserData;

    let activeProfileKey: ProviderProfileKey = shouldUseLegacyProjection
      ? derivedProfileKey
      : isProfileKey(raw.activeProfileKey)
        ? raw.activeProfileKey
        : derivedProfileKey;

    const profiles = this.cloneProfiles(raw.profiles);
    const hasLegacyProjection =
      typeof raw.apiKey === 'string' ||
      typeof raw.baseUrl === 'string' ||
      typeof raw.model === 'string';

    if (shouldUseLegacyProjection && hasLegacyProjection) {
      profiles[derivedProfileKey] = this.normalizeProfile(derivedProfileKey, {
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
        baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined,
        model: typeof raw.model === 'string' ? raw.model : undefined,
      });
      activeProfileKey = derivedProfileKey;
    }

    if (
      activeProfileKey === 'custom:openai' &&
      isOllamaLegacyCustomOpenAIConfig({
        provider,
        customProtocol,
        baseUrl: profiles['custom:openai']?.baseUrl,
      })
    ) {
      profiles.ollama = this.normalizeProfile('ollama', profiles['custom:openai']);
    }

    if (!profiles[activeProfileKey]) {
      activeProfileKey = derivedProfileKey;
    }

    return {
      provider,
      customProtocol,
      activeProfileKey,
      profiles,
      enableThinking: toBoolean(raw.enableThinking, defaultConfig.enableThinking),
    };
  }

  private projectFromConfigSet(configSet: ApiConfigSet): {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    activeProfileKey: ProviderProfileKey;
    profiles: Record<ProviderProfileKey, ProviderProfile>;
    apiKey: string;
    baseUrl?: string;
    model: string;
    contextWindow?: number;
    maxTokens?: number;
    enableThinking: boolean;
  } {
    const profiles = this.cloneProfiles(configSet.profiles);
    const activeProfileKey = isProfileKey(configSet.activeProfileKey)
      ? configSet.activeProfileKey
      : profileKeyFromProvider(configSet.provider, configSet.customProtocol);
    const activeProfile = profiles[activeProfileKey] || this.getDefaultProfile(activeProfileKey);

    return {
      provider: configSet.provider,
      customProtocol: configSet.customProtocol,
      activeProfileKey,
      profiles,
      apiKey: activeProfile.apiKey,
      baseUrl: activeProfile.baseUrl,
      model: activeProfile.model,
      contextWindow: activeProfile.contextWindow,
      maxTokens: activeProfile.maxTokens,
      enableThinking: toBoolean(configSet.enableThinking, false),
    };
  }

  private normalizeConfigSet(
    rawSet: Partial<ApiConfigSet> | undefined,
    fallback: {
      id: string;
      name: string;
      provider: ProviderType;
      customProtocol: CustomProtocolType;
      activeProfileKey: ProviderProfileKey;
      profiles: Record<ProviderProfileKey, ProviderProfile>;
      enableThinking: boolean;
      isSystem?: boolean;
    }
  ): ApiConfigSet {
    const provider = isProviderType(rawSet?.provider) ? rawSet.provider : fallback.provider;
    const customProtocol: CustomProtocolType = isCustomProtocol(rawSet?.customProtocol)
      ? rawSet.customProtocol
      : defaultProtocolForProvider(provider);

    const derivedProfileKey = profileKeyFromProvider(provider, customProtocol);
    const activeProfileKey = isProfileKey(rawSet?.activeProfileKey)
      ? rawSet.activeProfileKey
      : fallback.activeProfileKey || derivedProfileKey;

    const profiles = this.cloneProfiles(rawSet?.profiles || fallback.profiles);

    if (!profiles[activeProfileKey]) {
      profiles[activeProfileKey] = this.getDefaultProfile(activeProfileKey);
    }

    const id = toNonEmptyString(rawSet?.id) || fallback.id;
    const name = toNonEmptyString(rawSet?.name) || fallback.name;
    const updatedAt = toNonEmptyString(rawSet?.updatedAt) || nowISO();

    return {
      id,
      name,
      isSystem: toBoolean(rawSet?.isSystem, Boolean(fallback.isSystem)),
      provider,
      customProtocol,
      activeProfileKey,
      profiles,
      enableThinking: toBoolean(rawSet?.enableThinking, fallback.enableThinking),
      updatedAt,
    };
  }

  private makeDefaultConfigSetFromLegacy(legacy: {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    activeProfileKey: ProviderProfileKey;
    profiles: Record<ProviderProfileKey, ProviderProfile>;
    enableThinking: boolean;
  }): ApiConfigSet {
    return this.normalizeConfigSet(
      {
        id: DEFAULT_CONFIG_SET_ID,
        name: defaultConfigSet.name,
        isSystem: true,
        provider: legacy.provider,
        customProtocol: legacy.customProtocol,
        activeProfileKey: legacy.activeProfileKey,
        profiles: legacy.profiles,
        enableThinking: legacy.enableThinking,
        updatedAt: nowISO(),
      },
      {
        id: DEFAULT_CONFIG_SET_ID,
        name: defaultConfigSet.name,
        isSystem: true,
        provider: legacy.provider,
        customProtocol: legacy.customProtocol,
        activeProfileKey: legacy.activeProfileKey,
        profiles: legacy.profiles,
        enableThinking: legacy.enableThinking,
      }
    );
  }

  private normalizeConfigSets(
    rawSets: unknown,
    legacy: {
      provider: ProviderType;
      customProtocol: CustomProtocolType;
      activeProfileKey: ProviderProfileKey;
      profiles: Record<ProviderProfileKey, ProviderProfile>;
      enableThinking: boolean;
    }
  ): ApiConfigSet[] {
    const list = Array.isArray(rawSets) ? rawSets : [];
    if (list.length === 0) {
      return [this.makeDefaultConfigSetFromLegacy(legacy)];
    }

    const normalized: ApiConfigSet[] = [];
    const usedIds = new Set<string>();

    for (let index = 0; index < list.length; index += 1) {
      const rawSet = (list[index] || {}) as Partial<ApiConfigSet>;
      const seedId = toNonEmptyString(rawSet.id) || `set-${index + 1}`;
      let nextId = seedId;
      let suffix = 2;
      while (usedIds.has(nextId)) {
        nextId = `${seedId}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(nextId);

      const normalizedSet = this.normalizeConfigSet(rawSet, {
        id: nextId,
        name: toNonEmptyString(rawSet.name) || `方案 ${index + 1}`,
        provider: legacy.provider,
        customProtocol: legacy.customProtocol,
        activeProfileKey: legacy.activeProfileKey,
        profiles: legacy.profiles,
        enableThinking: legacy.enableThinking,
        isSystem: Boolean(rawSet.isSystem),
      });
      normalizedSet.id = nextId;
      normalized.push(normalizedSet);
    }

    const hasSystemSet = normalized.some((set) => set.isSystem);
    if (!hasSystemSet) {
      normalized.unshift(this.makeDefaultConfigSetFromLegacy(legacy));
    }

    return normalized;
  }

  private hasLegacySignal(legacy: {
    provider: ProviderType;
    customProtocol: CustomProtocolType;
    activeProfileKey: ProviderProfileKey;
    profiles: Record<ProviderProfileKey, ProviderProfile>;
    enableThinking: boolean;
  }): boolean {
    if (
      legacy.provider !== defaultConfig.provider ||
      legacy.customProtocol !== (defaultConfig.customProtocol || 'anthropic') ||
      legacy.activeProfileKey !== defaultConfig.activeProfileKey ||
      legacy.enableThinking !== defaultConfig.enableThinking
    ) {
      return true;
    }

    const activeProfile = legacy.profiles[legacy.activeProfileKey];
    const fallbackActive = this.getDefaultProfile(legacy.activeProfileKey);
    return Boolean(
      activeProfile.apiKey.trim() ||
      (activeProfile.baseUrl || '') !== (fallbackActive.baseUrl || '') ||
      activeProfile.model !== fallbackActive.model
    );
  }

  private shouldPreferLegacyConfigSetProjection(
    normalizedSets: ApiConfigSet[],
    legacy: {
      provider: ProviderType;
      customProtocol: CustomProtocolType;
      activeProfileKey: ProviderProfileKey;
      profiles: Record<ProviderProfileKey, ProviderProfile>;
      enableThinking: boolean;
    }
  ): boolean {
    if (!this.hasLegacySignal(legacy)) {
      return false;
    }
    if (normalizedSets.length !== 1) {
      return false;
    }

    const onlySet = normalizedSets[0];
    if (!(onlySet.id === DEFAULT_CONFIG_SET_ID && onlySet.isSystem)) {
      return false;
    }

    const projected = this.projectFromConfigSet(onlySet);
    const legacyActive = legacy.profiles[legacy.activeProfileKey];
    return !(
      projected.provider === legacy.provider &&
      projected.customProtocol === legacy.customProtocol &&
      projected.activeProfileKey === legacy.activeProfileKey &&
      projected.enableThinking === legacy.enableThinking &&
      projected.apiKey === legacyActive.apiKey &&
      (projected.baseUrl || '') === (legacyActive.baseUrl || '') &&
      projected.model === legacyActive.model
    );
  }

  private normalizeConfig(rawConfig: Partial<AppConfig> | undefined): AppConfig {
    const raw = rawConfig || {};
    const legacy = this.normalizeLegacyProjection(raw);
    const normalizedFromRaw = this.normalizeConfigSets(raw.configSets, legacy);
    const configSets = this.shouldPreferLegacyConfigSetProjection(normalizedFromRaw, legacy)
      ? [this.makeDefaultConfigSetFromLegacy(legacy)]
      : normalizedFromRaw;

    const requestedActiveSetId = toNonEmptyString(raw.activeConfigSetId);
    const activeConfigSetId = configSets.some((set) => set.id === requestedActiveSetId)
      ? (requestedActiveSetId as string)
      : configSets[0].id;

    const activeConfigSet = configSets.find((set) => set.id === activeConfigSetId) || configSets[0];
    const projected = this.projectFromConfigSet(activeConfigSet);

    const result: AppConfig = {
      provider: projected.provider,
      customProtocol: projected.customProtocol,
      apiKey: projected.apiKey,
      baseUrl: projected.baseUrl,
      model: projected.model,
      activeProfileKey: projected.activeProfileKey,
      profiles: projected.profiles,
      activeConfigSetId,
      configSets,
      agentCliPath:
        typeof raw.agentCliPath === 'string' ? raw.agentCliPath : defaultConfig.agentCliPath,
      defaultWorkdir:
        typeof raw.defaultWorkdir === 'string' ? raw.defaultWorkdir : defaultConfig.defaultWorkdir,
      globalSkillsPath:
        typeof raw.globalSkillsPath === 'string'
          ? raw.globalSkillsPath
          : defaultConfig.globalSkillsPath,
      enableDevLogs: toBoolean(raw.enableDevLogs, defaultConfig.enableDevLogs),
      theme: isAppTheme(raw.theme) ? raw.theme : defaultConfig.theme,
      sandboxEnabled: toBoolean(raw.sandboxEnabled, defaultConfig.sandboxEnabled),
      sandboxRemoteMode:
        raw.sandboxRemoteMode === 'ssh' || raw.sandboxRemoteMode === 'daytona'
          ? raw.sandboxRemoteMode
          : 'off',
      memoryEnabled: toBoolean(raw.memoryEnabled, defaultConfig.memoryEnabled),
      coworkInstructions:
        typeof raw.coworkInstructions === 'string'
          ? raw.coworkInstructions
          : defaultConfig.coworkInstructions,
      tavilyApiKey:
        typeof raw.tavilyApiKey === 'string' ? raw.tavilyApiKey : defaultConfig.tavilyApiKey,
      braveApiKey:
        typeof raw.braveApiKey === 'string' ? raw.braveApiKey : defaultConfig.braveApiKey,
      trayEnabled: toBoolean(raw.trayEnabled, defaultConfig.trayEnabled),
      a2aEnabled: toBoolean(raw.a2aEnabled, defaultConfig.a2aEnabled),
      a2aToken: typeof raw.a2aToken === 'string' ? raw.a2aToken : defaultConfig.a2aToken,
      a2aPort:
        typeof raw.a2aPort === 'number' &&
        Number.isInteger(raw.a2aPort) &&
        raw.a2aPort > 0 &&
        raw.a2aPort < 65536
          ? raw.a2aPort
          : defaultConfig.a2aPort,
      memoryRuntime: normalizeMemoryRuntimeConfig(raw.memoryRuntime),
      subAgents: normalizeSubAgentsConfig(raw.subAgents),
      imageGeneration: normalizeImageGenerationConfig(raw.imageGeneration),
      openjev: normalizeOpenJevConfig(raw.openjev),
      enableThinking: projected.enableThinking,
      isConfigured: toBoolean(raw.isConfigured, defaultConfig.isConfigured),
    };
    // Resume point — carried through normalization, otherwise every read/write
    // dropped it and the last session was never restored. Assigned conditionally
    // because the JSON store refuses to persist an explicit `undefined`, and
    // `clearSessionResumePoint()` relies on the key's absence meaning "no
    // resume point".
    const lastActiveSessionId = toNonEmptyString(raw.lastActiveSessionId);
    const lastActiveCwd = toNonEmptyString(raw.lastActiveCwd);
    if (lastActiveSessionId) result.lastActiveSessionId = lastActiveSessionId;
    if (lastActiveCwd) result.lastActiveCwd = lastActiveCwd;
    if (typeof raw.lastActiveSessionUpdatedAt === 'number') {
      result.lastActiveSessionUpdatedAt = raw.lastActiveSessionUpdatedAt;
    }
    // Secret sources are validated on every read so a hand-edited or corrupted
    // store can never hand a malformed reference to the resolver. Assigned
    // conditionally for the same JSON-store reason as the resume point above.
    const secretSources = normalizeSecretSourceMap(raw.secretSources);
    if (secretSources) result.secretSources = secretSources;
    this.normalizeModelIds(result);
    return result;
  }

  private cloneConfigSet(configSet: ApiConfigSet): ApiConfigSet {
    return {
      ...configSet,
      profiles: this.cloneProfiles(configSet.profiles),
      updatedAt: toNonEmptyString(configSet.updatedAt) || nowISO(),
    };
  }

  private saveConfig(config: AppConfig): void {
    const normalized = this.normalizeConfig(config);
    this.store.set(normalized);
  }

  private composeProjectedConfig(
    base: AppConfig,
    nextConfigSets: ApiConfigSet[],
    requestedActiveConfigSetId: string
  ): AppConfig {
    const activeConfigSet =
      nextConfigSets.find((set) => set.id === requestedActiveConfigSetId) || nextConfigSets[0];
    const projected = this.projectFromConfigSet(activeConfigSet);
    return {
      ...base,
      provider: projected.provider,
      customProtocol: projected.customProtocol,
      apiKey: projected.apiKey,
      baseUrl: projected.baseUrl,
      model: projected.model,
      activeProfileKey: projected.activeProfileKey,
      profiles: projected.profiles,
      enableThinking: projected.enableThinking,
      activeConfigSetId: activeConfigSet.id,
      configSets: nextConfigSets,
    };
  }

  private buildUniqueConfigSetName(
    name: string,
    existingSets: ApiConfigSet[],
    excludeId?: string
  ): string {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Config set name is required');
    }

    const usedNames = new Set(
      existingSets.filter((set) => set.id !== excludeId).map((set) => set.name)
    );

    if (!usedNames.has(trimmed)) {
      return trimmed;
    }

    let suffix = 2;
    let candidate = `${trimmed} (${suffix})`;
    while (usedNames.has(candidate) && suffix <= 100) {
      suffix += 1;
      candidate = `${trimmed} (${suffix})`;
    }
    return candidate;
  }

  private generateConfigSetId(existingSets: ApiConfigSet[]): ConfigSetId {
    let index = existingSets.length + 1;
    let candidate = `set-${index}`;
    const used = new Set(existingSets.map((set) => set.id));
    while (used.has(candidate)) {
      index += 1;
      candidate = `set-${index}`;
    }
    return candidate;
  }

  private buildBlankConfigSet(payload: {
    id: ConfigSetId;
    name: string;
    provider: ProviderType;
    customProtocol: CustomProtocolType;
  }): ApiConfigSet {
    const activeProfileKey = profileKeyFromProvider(payload.provider, payload.customProtocol);
    const profiles = this.cloneProfiles(undefined);
    const defaultProfile = this.getDefaultProfile(activeProfileKey);
    profiles[activeProfileKey] = this.normalizeProfile(activeProfileKey, {
      apiKey: '',
      baseUrl: defaultProfile.baseUrl,
      model: defaultProfile.model,
    });

    return {
      id: payload.id,
      name: payload.name,
      isSystem: false,
      provider: payload.provider,
      customProtocol: payload.customProtocol,
      activeProfileKey,
      profiles,
      enableThinking: false,
      updatedAt: nowISO(),
    };
  }

  /**
   * Get all config
   */
  getAll(): AppConfig {
    return this.normalizeConfig(this.store.store as Partial<AppConfig>);
  }

  /**
   * Project a SPECIFIC ConfigSet into a full AppConfig without changing the
   * globally active set. Used by Projects so a project can pin its own
   * provider/model. When `modelId` is provided, that exact model is used
   * instead of the set's active one (same semantic as subAgents.perRole).
   * Returns undefined when the set id is unknown — callers fall back to the
   * active config.
   */
  getConfigSetProjectedConfig(setId: string, modelId?: string): AppConfig | undefined {
    const current = this.getAll();
    const set = current.configSets.find((s) => s.id === setId);
    if (!set) return undefined;
    const projected = this.composeProjectedConfig(current, current.configSets, set.id);
    const pinned = modelId?.trim();
    if (pinned) {
      projected.model = pinned;
    }
    return projected;
  }

  /**
   * Get a specific config value
   */
  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    if (DIRECT_READ_KEYS.has(key)) {
      const rawValue = this.store.get(key as string) as AppConfig[K] | undefined;
      if (rawValue !== undefined) {
        // Per-field guards: reject raw values that fail type/range checks
        if (key === 'provider' && !isProviderType(rawValue)) {
          return defaultConfig[key];
        }
        if (key === 'customProtocol' && !isCustomProtocol(rawValue)) {
          return defaultConfig[key];
        }
        if (key === 'activeProfileKey' && !isProfileKey(rawValue)) {
          return defaultConfig[key];
        }
        if (key === 'theme' && !isAppTheme(rawValue)) {
          return defaultConfig[key];
        }
        if (
          (key === 'enableDevLogs' ||
            key === 'sandboxEnabled' ||
            key === 'memoryEnabled' ||
            key === 'trayEnabled' ||
            key === 'a2aEnabled' ||
            key === 'enableThinking' ||
            key === 'isConfigured') &&
          typeof rawValue !== 'boolean'
        ) {
          return defaultConfig[key];
        }
        return rawValue;
      }
      return defaultConfig[key];
    }
    return this.getAll()[key];
  }

  /**
   * Set a specific config value
   */
  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.update({ [key]: value } as Partial<AppConfig>);
  }

  /**
   * Forget the persisted session resume point.
   *
   * `update()` cannot be used: its `set(object)` call merges key by key
   * (verified in `conf`), and it re-reads `getAll()` as its baseline, so a key
   * omitted from the payload is silently kept. `delete()` is the only removal
   * the store honours; the store also rejects an explicit `undefined`.
   */
  clearSessionResumePoint(): void {
    this.store.delete('lastActiveSessionId');
    this.store.delete('lastActiveCwd');
    this.store.delete('lastActiveSessionUpdatedAt');
  }

  /**
   * Create a new named config set.
   * - mode=blank: create a fresh set from current provider/protocol defaults
   * - mode=clone: clone current/selected set
   */
  createSet(payload: CreateConfigSetPayload): AppConfig {
    const current = this.getAll();
    if (current.configSets.length >= MAX_CONFIG_SET_COUNT) {
      throw new Error(`Config set limit reached: max ${MAX_CONFIG_SET_COUNT}`);
    }

    const id = this.generateConfigSetId(current.configSets);
    const name = this.buildUniqueConfigSetName(payload.name, current.configSets);
    const mode: CreateSetMode = payload.mode === 'blank' ? 'blank' : 'clone';
    let newSet: ApiConfigSet;

    if (mode === 'blank') {
      const activeSet =
        current.configSets.find((set) => set.id === current.activeConfigSetId) ||
        current.configSets[0];
      const seedProvider = activeSet?.provider || current.provider;
      const seedProtocol: CustomProtocolType = normalizeCustomProtocol(
        activeSet?.customProtocol,
        defaultProtocolForProvider(seedProvider)
      );
      newSet = this.buildBlankConfigSet({
        id,
        name,
        provider: seedProvider,
        customProtocol: seedProtocol,
      });
    } else {
      const source =
        current.configSets.find((set) => set.id === payload.fromSetId) ||
        current.configSets.find((set) => set.id === current.activeConfigSetId) ||
        current.configSets[0];

      if (!source) {
        throw new Error('Config set clone source not found');
      }

      const cloned = this.cloneConfigSet(source);
      newSet = {
        ...cloned,
        id,
        name,
        isSystem: false,
        updatedAt: nowISO(),
      };
    }

    this.saveConfig({
      ...this.composeProjectedConfig(current, [...current.configSets, newSet], id),
    } as AppConfig);

    return this.getAll();
  }

  renameSet(payload: { id: string; name: string }): AppConfig {
    const current = this.getAll();
    const target = current.configSets.find((set) => set.id === payload.id);
    if (!target) {
      throw new Error('Config set not found');
    }

    const nextName = this.buildUniqueConfigSetName(payload.name, current.configSets, payload.id);
    const nextSets = current.configSets.map((set) => {
      if (set.id !== payload.id) {
        return this.cloneConfigSet(set);
      }
      return {
        ...this.cloneConfigSet(set),
        name: nextName,
        updatedAt: nowISO(),
      };
    });

    this.saveConfig(this.composeProjectedConfig(current, nextSets, current.activeConfigSetId));

    return this.getAll();
  }

  deleteSet(payload: { id: string }): AppConfig {
    const current = this.getAll();
    const target = current.configSets.find((set) => set.id === payload.id);
    if (!target) {
      throw new Error('Config set not found');
    }
    if (target.isSystem) {
      throw new Error('System config set cannot be deleted');
    }
    if (current.configSets.length <= 1) {
      throw new Error('At least one config set must be kept');
    }

    const nextSets = current.configSets
      .filter((set) => set.id !== payload.id)
      .map((set) => this.cloneConfigSet(set));

    const fallbackActive = nextSets.find((set) => set.isSystem)?.id || nextSets[0]?.id;
    const nextActiveConfigSetId =
      current.activeConfigSetId === payload.id ? fallbackActive : current.activeConfigSetId;

    this.saveConfig(this.composeProjectedConfig(current, nextSets, nextActiveConfigSetId));

    return this.getAll();
  }

  switchSet(payload: { id: string }): AppConfig {
    const current = this.getAll();
    if (!current.configSets.some((set) => set.id === payload.id)) {
      throw new Error('Config set not found');
    }

    this.saveConfig(this.composeProjectedConfig(current, current.configSets, payload.id));

    return this.getAll();
  }

  /**
   * Update multiple config values
   */
  update(updates: Partial<AppConfig>): void {
    const current = this.getAll();
    let nextConfigSets = current.configSets.map((set) => this.cloneConfigSet(set));

    if (Array.isArray(updates.configSets) && updates.configSets.length > 0) {
      const normalizedSets = this.normalizeConfigSets(updates.configSets, {
        provider: current.provider,
        customProtocol: normalizeCustomProtocol(
          current.customProtocol,
          defaultProtocolForProvider(current.provider)
        ),
        activeProfileKey: current.activeProfileKey,
        profiles: this.cloneProfiles(current.profiles),
        enableThinking: current.enableThinking,
      });
      nextConfigSets = normalizedSets;
    }

    const requestedActiveConfigSetId =
      toNonEmptyString(updates.activeConfigSetId) || current.activeConfigSetId;
    const activeConfigSetId = nextConfigSets.some((set) => set.id === requestedActiveConfigSetId)
      ? requestedActiveConfigSetId
      : nextConfigSets[0].id;

    const targetIndex = nextConfigSets.findIndex((set) => set.id === activeConfigSetId);
    const targetSet =
      targetIndex >= 0
        ? this.cloneConfigSet(nextConfigSets[targetIndex])
        : this.cloneConfigSet(nextConfigSets[0]);

    const nextProfiles = this.cloneProfiles(targetSet.profiles);
    let nextActiveProfileKey = targetSet.activeProfileKey;
    let nextProvider = targetSet.provider;
    let nextCustomProtocol: CustomProtocolType = normalizeCustomProtocol(
      targetSet.customProtocol,
      defaultProtocolForProvider(targetSet.provider)
    );

    const mutatesActiveSet =
      updates.profiles !== undefined ||
      updates.activeProfileKey !== undefined ||
      updates.provider !== undefined ||
      updates.customProtocol !== undefined ||
      updates.apiKey !== undefined ||
      updates.baseUrl !== undefined ||
      updates.model !== undefined ||
      updates.enableThinking !== undefined;

    if (mutatesActiveSet) {
      if (updates.profiles) {
        for (const key of PROFILE_KEYS) {
          if (updates.profiles[key]) {
            nextProfiles[key] = this.normalizeProfile(key, updates.profiles[key]);
          }
        }
      }

      if (isProfileKey(updates.activeProfileKey)) {
        nextActiveProfileKey = updates.activeProfileKey;
        const fromProfile = profileKeyToProvider(nextActiveProfileKey);
        nextProvider = fromProfile.provider;
        nextCustomProtocol = fromProfile.customProtocol;
      }

      if (updates.provider || updates.customProtocol) {
        const requestedProvider = isProviderType(updates.provider)
          ? updates.provider
          : nextProvider;
        const requestedProtocol =
          requestedProvider === 'custom'
            ? isCustomProtocol(updates.customProtocol)
              ? updates.customProtocol
              : nextCustomProtocol
            : defaultProtocolForProvider(requestedProvider);
        nextActiveProfileKey = profileKeyFromProvider(requestedProvider, requestedProtocol);
        const fromProfile = profileKeyToProvider(nextActiveProfileKey);
        nextProvider = fromProfile.provider;
        nextCustomProtocol = fromProfile.customProtocol;
      }

      const nextActiveProfile = {
        ...nextProfiles[nextActiveProfileKey],
      };
      if (updates.apiKey !== undefined) {
        nextActiveProfile.apiKey = updates.apiKey;
      }
      if (updates.baseUrl !== undefined) {
        const baseUrl = updates.baseUrl?.trim();
        nextActiveProfile.baseUrl = baseUrl ?? '';
      }
      if (updates.model !== undefined) {
        const model = updates.model?.trim();
        nextActiveProfile.model = model ?? '';
      }
      nextProfiles[nextActiveProfileKey] = this.normalizeProfile(
        nextActiveProfileKey,
        nextActiveProfile
      );

      const updatedSet: ApiConfigSet = {
        ...targetSet,
        provider: nextProvider,
        customProtocol: nextCustomProtocol,
        activeProfileKey: nextActiveProfileKey,
        profiles: nextProfiles,
        enableThinking:
          updates.enableThinking !== undefined ? updates.enableThinking : targetSet.enableThinking,
        updatedAt: nowISO(),
      };

      if (targetIndex >= 0) {
        nextConfigSets[targetIndex] = updatedSet;
      }
    }

    const projectedConfig = this.composeProjectedConfig(current, nextConfigSets, activeConfigSetId);
    this.saveConfig({
      ...projectedConfig,
      agentCliPath:
        updates.agentCliPath !== undefined ? updates.agentCliPath : current.agentCliPath,
      defaultWorkdir:
        updates.defaultWorkdir !== undefined ? updates.defaultWorkdir : current.defaultWorkdir,
      globalSkillsPath:
        updates.globalSkillsPath !== undefined
          ? updates.globalSkillsPath
          : current.globalSkillsPath,
      enableDevLogs:
        updates.enableDevLogs !== undefined ? updates.enableDevLogs : current.enableDevLogs,
      theme: updates.theme !== undefined ? updates.theme : current.theme,
      // Resume point. These are re-stated here because `update()` ends in
      // `saveConfig({ ... })` — a literal that omits any key not named. Before
      // this, `configStore.set('lastActiveSessionId', ...)` was silently
      // dropped and session restore never happened. Absence in `updates` falls
      // back to the current value; clearing goes through
      // `clearSessionResumePoint()`, which deletes the keys from the store.
      ...('lastActiveSessionId' in updates
        ? { lastActiveSessionId: updates.lastActiveSessionId }
        : { lastActiveSessionId: current.lastActiveSessionId }),
      ...('lastActiveCwd' in updates
        ? { lastActiveCwd: updates.lastActiveCwd }
        : { lastActiveCwd: current.lastActiveCwd }),
      ...('lastActiveSessionUpdatedAt' in updates
        ? { lastActiveSessionUpdatedAt: updates.lastActiveSessionUpdatedAt }
        : { lastActiveSessionUpdatedAt: current.lastActiveSessionUpdatedAt }),
      sandboxEnabled:
        updates.sandboxEnabled !== undefined ? updates.sandboxEnabled : current.sandboxEnabled,
      memoryEnabled:
        updates.memoryEnabled !== undefined ? updates.memoryEnabled : current.memoryEnabled,
      coworkInstructions:
        updates.coworkInstructions !== undefined
          ? updates.coworkInstructions
          : current.coworkInstructions,
      tavilyApiKey:
        updates.tavilyApiKey !== undefined ? updates.tavilyApiKey : current.tavilyApiKey,
      braveApiKey: updates.braveApiKey !== undefined ? updates.braveApiKey : current.braveApiKey,
      memoryRuntime:
        updates.memoryRuntime !== undefined
          ? normalizeMemoryRuntimeConfig(updates.memoryRuntime)
          : current.memoryRuntime,
      subAgents:
        updates.subAgents !== undefined
          ? normalizeSubAgentsConfig(updates.subAgents)
          : current.subAgents,
      imageGeneration:
        updates.imageGeneration !== undefined
          ? normalizeImageGenerationConfig(updates.imageGeneration)
          : current.imageGeneration,
      openjev:
        updates.openjev !== undefined ? normalizeOpenJevConfig(updates.openjev) : current.openjev,
      isConfigured:
        updates.isConfigured !== undefined ? updates.isConfigured : current.isConfigured,
    });
  }

  /**
   * Check if the app is configured (has API key)
   */
  isConfigured(): boolean {
    return this.hasAnyUsableCredentials(this.getAll());
  }

  private hasUsableCredentialsForProjection(projection: {
    provider: ProviderType;
    customProtocol?: CustomProtocolType;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }): boolean {
    if (projection.provider === 'ollama' && !projection.model?.trim()) {
      return false;
    }
    const apiKey = projection.apiKey?.trim();
    if (apiKey) {
      return true;
    }
    if (
      shouldAllowEmptyAnthropicApiKey({
        provider: projection.provider,
        customProtocol: projection.customProtocol,
        baseUrl: projection.baseUrl,
      })
    ) {
      return true;
    }
    if (
      shouldAllowEmptyGeminiApiKey({
        provider: projection.provider,
        customProtocol: projection.customProtocol,
        baseUrl: projection.baseUrl,
      })
    ) {
      return true;
    }
    if (
      shouldAllowEmptyOllamaApiKey({
        provider: projection.provider,
        customProtocol: projection.customProtocol,
        baseUrl: projection.baseUrl,
      })
    ) {
      return true;
    }
    const protocol: CustomProtocolType = normalizeCustomProtocol(
      projection.customProtocol,
      defaultProtocolForProvider(projection.provider)
    );
    if (!isOpenAIProvider({ provider: projection.provider, customProtocol: protocol })) {
      return false;
    }
    return (
      (projection.provider === 'ollama'
        ? resolveOllamaCredentials({
            provider: projection.provider,
            customProtocol: protocol,
            apiKey: projection.apiKey ?? '',
            baseUrl: projection.baseUrl,
          })
        : resolveOpenAICredentials({
            provider: projection.provider,
            customProtocol: protocol,
            apiKey: projection.apiKey ?? '',
            baseUrl: projection.baseUrl,
          })) !== null
    );
  }

  hasUsableCredentials(config: AppConfig = this.getAll()): boolean {
    return this.hasUsableCredentialsForActiveSet(config);
  }

  hasUsableCredentialsForActiveSet(config: AppConfig = this.getAll()): boolean {
    const normalized = this.normalizeConfig(config);
    return this.hasUsableCredentialsForProjection({
      provider: normalized.provider,
      customProtocol: normalized.customProtocol,
      apiKey: normalized.apiKey,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
    });
  }

  hasAnyUsableCredentials(config: AppConfig = this.getAll()): boolean {
    const normalized = this.normalizeConfig(config);
    return normalized.configSets.some((configSet) => {
      const projected = this.projectFromConfigSet(configSet);
      return this.hasUsableCredentialsForProjection({
        provider: projected.provider,
        customProtocol: projected.customProtocol,
        apiKey: projected.apiKey,
        baseUrl: projected.baseUrl,
        model: projected.model,
      });
    });
  }

  /**
   * Apply config to environment variables
   * This should be called before creating sessions
   *
   * 环境变量映射：
   * - OpenAI 直连: OPENAI_API_KEY = apiKey, OPENAI_BASE_URL 可选
   * - Anthropic 直连: ANTHROPIC_API_KEY = apiKey
   * - Custom Anthropic: ANTHROPIC_API_KEY = apiKey
   * - OpenRouter: ANTHROPIC_AUTH_TOKEN = apiKey, ANTHROPIC_API_KEY = '' (proxy mode)
   */
  async applyToEnv(options?: {
    externalBudgetMs?: number;
  }): Promise<{ externalDeferred: boolean }> {
    const config = this.getAll();
    const activeProfile = config.profiles?.[config.activeProfileKey] || {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    };
    const storedApiKey = activeProfile.apiKey || '';

    // Resolve the active ConfigSet's key from its configured SecretSource. A
    // failure (missing CLI, locked vault) leaves the key empty and logs the
    // reason rather than throwing — the caller decides what to surface.
    //
    // `externalBudgetMs` bounds how long BOOT waits for the vault CLI: on
    // expiry the env keeps the local value and the resolution continues in the
    // background (tracked by `pendingExternalSecrets`), so a locked vault
    // cannot hold the window back. Omit the budget (settings save, headless)
    // to wait for the full resolution as before.
    let effectiveApiKey = storedApiKey;
    let externalDeferred = false;
    const source = config.secretSources?.[config.activeConfigSetId];
    if (source && source.kind !== 'local') {
      const resolution = getSecretResolver().resolveForConfigSet(
        config.activeConfigSetId,
        config.secretSources,
        storedApiKey
      );
      if (options?.externalBudgetMs !== undefined) {
        const budgeted = await withBudget(resolution, options.externalBudgetMs);
        if (budgeted === null) {
          // Budget expired: env keeps going with the local value; the vault
          // answer lands via the tracked promise and the caller re-applies it.
          externalDeferred = true;
          this.pendingExternalSecrets = resolution.then(
            () => {
              this.pendingExternalSecrets = null;
            },
            () => {
              this.pendingExternalSecrets = null;
            }
          );
          log(
            '[Config] External secret budget expired, deferring vault resolution to background:',
            {
              configSetId: config.activeConfigSetId,
              kind: source.kind,
            }
          );
        } else if (budgeted.error) {
          log('[Config] External secret could not be resolved:', {
            configSetId: config.activeConfigSetId,
            kind: source.kind,
            code: budgeted.error.code,
            reason: budgeted.error.message,
          });
          effectiveApiKey = '';
        } else {
          effectiveApiKey = budgeted.value ?? '';
        }
      } else {
        const outcome = await resolution;
        if (outcome.error) {
          log('[Config] External secret could not be resolved:', {
            configSetId: config.activeConfigSetId,
            kind: source.kind,
            code: outcome.error.code,
            reason: outcome.error.message,
          });
          effectiveApiKey = '';
        } else {
          effectiveApiKey = outcome.value ?? '';
        }
      }
    }

    const projectedConfig: AppConfig = {
      ...config,
      apiKey: effectiveApiKey,
      baseUrl: activeProfile.baseUrl,
      model: activeProfile.model || '',
    };

    // Clear all API-related env vars first to ensure clean state when switching providers
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;
    delete process.env.OPENAI_API_MODE;
    delete process.env.OPENAI_ACCOUNT_ID;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_BASE_URL;
    delete process.env.AGENT_CLI_PATH;
    delete process.env.COWORK_WORKDIR;

    const useOpenAI =
      projectedConfig.provider === 'openai' ||
      projectedConfig.provider === 'ollama' ||
      (projectedConfig.provider === 'custom' && projectedConfig.customProtocol === 'openai');
    const useGemini =
      projectedConfig.provider === 'gemini' ||
      (projectedConfig.provider === 'custom' && projectedConfig.customProtocol === 'gemini');

    if (useOpenAI) {
      const resolvedOpenAI =
        projectedConfig.provider === 'ollama'
          ? resolveOllamaCredentials(projectedConfig)
          : resolveOpenAICredentials(projectedConfig);
      if (resolvedOpenAI?.apiKey) {
        process.env.OPENAI_API_KEY = resolvedOpenAI.apiKey;
      }
      const openAIBaseUrl = resolvedOpenAI?.baseUrl || projectedConfig.baseUrl;
      if (openAIBaseUrl) {
        process.env.OPENAI_BASE_URL = openAIBaseUrl;
      }
      if (resolvedOpenAI?.accountId) {
        process.env.OPENAI_ACCOUNT_ID = resolvedOpenAI.accountId;
      }
      if (projectedConfig.model) {
        process.env.OPENAI_MODEL = projectedConfig.model;
      }
    } else if (useGemini) {
      const trimmedApiKey = projectedConfig.apiKey?.trim();
      if (trimmedApiKey) {
        process.env.GEMINI_API_KEY = trimmedApiKey;
      }
      const normalizedGeminiBaseUrl = projectedConfig.baseUrl?.trim().replace(/\/+$/, '');
      if (normalizedGeminiBaseUrl) {
        process.env.GEMINI_BASE_URL = normalizedGeminiBaseUrl;
      }
      if (projectedConfig.model) {
        process.env.CLAUDE_MODEL = projectedConfig.model;
      }
    } else {
      const effectiveAnthropicApiKey =
        projectedConfig.apiKey?.trim() ||
        (shouldAllowEmptyAnthropicApiKey(projectedConfig) ? LOCAL_ANTHROPIC_PLACEHOLDER_KEY : '');
      if (
        projectedConfig.provider === 'anthropic' ||
        (projectedConfig.provider === 'custom' && projectedConfig.customProtocol !== 'openai')
      ) {
        const useAuthToken = shouldUseAnthropicAuthToken({
          ...projectedConfig,
          apiKey: effectiveAnthropicApiKey,
        });
        if (effectiveAnthropicApiKey) {
          if (useAuthToken) {
            process.env.ANTHROPIC_AUTH_TOKEN = effectiveAnthropicApiKey;
          } else {
            process.env.ANTHROPIC_API_KEY = effectiveAnthropicApiKey;
          }
        }
        const normalizedAnthropicBaseUrl = normalizeAnthropicBaseUrl(projectedConfig.baseUrl);
        if (normalizedAnthropicBaseUrl) {
          process.env.ANTHROPIC_BASE_URL = normalizedAnthropicBaseUrl;
        }
        if (useAuthToken) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          delete process.env.ANTHROPIC_AUTH_TOKEN;
        }
      } else {
        // OpenRouter: use ANTHROPIC_AUTH_TOKEN for proxy authentication
        if (effectiveAnthropicApiKey) {
          process.env.ANTHROPIC_AUTH_TOKEN = effectiveAnthropicApiKey;
        }
        const normalizedAnthropicBaseUrl = normalizeAnthropicBaseUrl(projectedConfig.baseUrl);
        if (normalizedAnthropicBaseUrl) {
          process.env.ANTHROPIC_BASE_URL = normalizedAnthropicBaseUrl;
        }
        // ANTHROPIC_API_KEY must be absent to prevent SDK from using it
        delete process.env.ANTHROPIC_API_KEY;
      }

      if (projectedConfig.model) {
        process.env.CLAUDE_MODEL = projectedConfig.model;
        process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = projectedConfig.model;
      }
    }

    // agentCliPath is no longer used (the agent SDK handles model routing natively)

    if (projectedConfig.defaultWorkdir) {
      process.env.COWORK_WORKDIR = projectedConfig.defaultWorkdir;
    }

    log('[Config] Applied env vars for provider:', projectedConfig.provider, {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? '✓ Set' : '(empty/unset)',
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ? '✓ Set' : '(empty/unset)',
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '(default)',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '✓ Set' : '(empty/unset)',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '(default)',
      OPENAI_MODEL: process.env.OPENAI_MODEL || '(not set)',
      OPENAI_API_MODE: process.env.OPENAI_API_MODE || '(default)',
      OPENAI_ACCOUNT_ID: process.env.OPENAI_ACCOUNT_ID || '(not set)',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY ? '✓ Set' : '(empty/unset)',
      GEMINI_BASE_URL: process.env.GEMINI_BASE_URL || '(default)',
    });
    return { externalDeferred };
  }

  /** True while a background vault resolution from a budgeted `applyToEnv` is still running. */
  hasPendingExternalSecrets(): boolean {
    return this.pendingExternalSecrets !== null;
  }

  /**
   * Resolves when any in-flight background vault resolution settles.
   * Immediately resolved when idle, so gating on it is free on the hot path.
   */
  whenExternalSecretsSettled(): Promise<void> {
    return this.pendingExternalSecrets ?? Promise.resolve();
  }

  /**
   * Export non-sensitive config to a plaintext JSON file.
   * File location: {userData}/config.public.json
   */
  exportSafeConfig(): void {
    const config = this.getAll();
    const safeSubset: Partial<AppConfig> = {};
    for (const key of EXPORTABLE_FIELDS) {
      if (config[key] !== undefined) {
        (safeSubset as Record<string, unknown>)[key] = config[key];
      }
    }
    const filePath = this.getPublicConfigPath();
    fs.writeFileSync(filePath, JSON.stringify(safeSubset, null, 2), 'utf-8');
    log('[ConfigStore] Exported safe config to:', filePath);
  }

  /**
   * Import config from the plaintext JSON file, applying only safe fields.
   * Returns true if any fields were applied, false otherwise.
   */
  importSafeConfig(): boolean {
    const filePath = this.getPublicConfigPath();
    if (!fs.existsSync(filePath)) return false;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      logWarn('[ConfigStore] Failed to read public config file:', err);
      return false;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logWarn('[ConfigStore] Public config file contains malformed JSON, skipping import:', err);
      return false;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      logWarn('[ConfigStore] Public config file root is not an object, skipping import');
      return false;
    }

    // Only apply fields that are in the exportable set AND pass type validation
    const updates: Partial<AppConfig> = {};
    for (const key of EXPORTABLE_FIELDS) {
      if (key in parsed && parsed[key] !== undefined) {
        const validator = FIELD_VALIDATORS[key];
        if (validator && !validator(parsed[key])) {
          logWarn(`[ConfigStore] Skipping invalid value for "${key}":`, parsed[key]);
          continue;
        }
        (updates as Record<string, unknown>)[key] = parsed[key];
      }
    }

    if (Object.keys(updates).length > 0) {
      this.update(updates);
      log('[ConfigStore] Imported safe config from:', filePath, 'fields:', Object.keys(updates));
      return true;
    }
    return false;
  }

  /**
   * Get the path to the public plaintext config file.
   */
  getPublicConfigPath(): string {
    return path.join(path.dirname(this.getPath()), 'config.public.json');
  }

  /**
   * Reset config to defaults
   */
  reset(): void {
    this.store.clear();
    this.ensureNormalized();
  }

  /**
   * Get the store file path (for debugging)
   */
  getPath(): string {
    return this.store.path;
  }
}

// Singleton instance
export const configStore = new ConfigStore();
