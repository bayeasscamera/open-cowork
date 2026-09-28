/**
 * @module main/agent/create-pi-session
 *
 * Creates a fresh pi agent session for a cold start: resource loader (skills +
 * system prompt + compaction extension), Ollama-aware compaction settings,
 * `createAgentSession`, the SDK hooks, and the LRU-style session cache.
 *
 * Extracted from CoworkAgentRunner.run() so session construction is
 * unit-testable without a runner instance. The class-owned cache and hook
 * installers are injected; the compaction and payload policies stay imported.
 */
import {
  createAgentSession,
  createCodingTools,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
  type AgentSession as PiAgentSession,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { ModelRegistry } from './shared-auth';
import { createCompactionExtensionFactory } from './compaction-extension';
import { effectiveContextWindow, resolveCompactionSettings } from './compaction-policy';
import { log, logWarn } from '../utils/logger';
import type { Session } from '../../shared/types';

/** Cached pi session entry (owns the reuse signature bookkeeping). */
export interface CachedPiSession {
  session: PiAgentSession;
  modelId: string;
  thinkingLevel: string;
  runtimeSignature: string;
  skillsSignature?: string;
  sessionContextSignature?: string;
  ollamaNumCtx?: { value: number };
}

export interface PiPayloadHookOptions {
  provider?: string;
  customProtocol?: string;
  baseUrl?: string;
  modelId?: string;
  contextWindow?: number;
}

/** Fully-resolved options accepted by createAgentSession (options are optional). */
type ResolvedSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;

export interface CreatePiSessionDeps {
  session: Session;
  piModel: NonNullable<ResolvedSessionOptions['model']>;
  thinkingLevel: NonNullable<ResolvedSessionOptions['thinkingLevel']>;
  authStorage: ConstructorParameters<typeof ModelRegistry>[0];
  cwd: string;
  skillPaths: string[];
  coworkAppendPrompt: string;
  provider: string;
  customProtocol?: string;
  effectiveBaseUrl?: string;
  tools: ToolDefinition[];
  customTools: ResolvedSessionOptions['customTools'];
  runtimeSignature: string;
  skillsSignature: string;
  sessionContextSignature?: string;
  sessions: Map<string, CachedPiSession>;
  maxCachedSessions: number;
  installPermissionHook: (piSession: PiAgentSession) => void;
  installModsHooks: (piSession: PiAgentSession) => void;
  installPayloadHook: (piSession: PiAgentSession, options: PiPayloadHookOptions) => void;
}

export async function createPiSession(deps: CreatePiSessionDeps): Promise<PiAgentSession> {
  // First query in this session — create new agent session
  // ResourceLoader + ModelRegistry only needed for session creation — skip on reuse
  const { DefaultResourceLoader } = await import('@mariozechner/pi-coding-agent');

  // Per-session compaction instructions (from session metadata if present).
  // Capped at 2000 chars to limit prompt injection surface — this field
  // is only set programmatically (not from external user input).
  let sessionCompactInstructions: string | undefined =
    'compactInstructions' in deps.session &&
    typeof (deps.session as Record<string, unknown>).compactInstructions === 'string'
      ? ((deps.session as Record<string, unknown>).compactInstructions as string)
      : undefined;
  if (sessionCompactInstructions && sessionCompactInstructions.length > 2000) {
    sessionCompactInstructions = sessionCompactInstructions.slice(0, 2000);
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: deps.cwd,
    additionalSkillPaths: deps.skillPaths,
    appendSystemPrompt: deps.coworkAppendPrompt,
    extensionFactories: [
      createCompactionExtensionFactory({
        customInstructions: sessionCompactInstructions,
        pruneToolOutputAbove: 500,
        keepRecentToolResults: 3,
      }),
    ],
  });
  await resourceLoader.reload();

  const modelRegistry = new ModelRegistry(deps.authStorage);

  // Ollama-specific compaction tuning based on actual context window. The
  // decision itself lives in compaction-policy so the sub-agent paths apply the
  // same rule; only the log wording stays local to the main agent.
  const compactionInput = {
    contextWindow: deps.piModel.contextWindow,
    provider: deps.provider,
  };
  const contextWindow = effectiveContextWindow(compactionInput);
  const tuned = resolveCompactionSettings(compactionInput);
  const compactionSettings = tuned ?? { enabled: true };
  if (tuned && tuned.enabled === false) {
    log(
      '[CoworkAgentRunner] Ollama small context model, disabling auto-compaction (contextWindow:',
      contextWindow,
      ')'
    );
  } else if (tuned && tuned.reserveTokens !== undefined) {
    log(
      '[CoworkAgentRunner] Ollama medium context, scaled compaction:',
      JSON.stringify(compactionSettings)
    );
  }

  const { session: newPiSession } = await createAgentSession({
    model: deps.piModel,
    thinkingLevel: deps.thinkingLevel,
    authStorage: deps.authStorage,
    modelRegistry,
    tools: deps.tools as unknown as ReturnType<typeof createCodingTools>,
    customTools: deps.customTools,
    sessionManager: PiSessionManager.inMemory(),
    settingsManager: PiSettingsManager.inMemory({
      compaction: compactionSettings,
      retry: { enabled: true, maxRetries: 2 },
    }),
    resourceLoader,
    cwd: deps.cwd,
  });
  const piSession = newPiSession;

  // Install permission-gating hook via the SDK's tool_call extension event.
  // This must happen once per new session — the hook persists across reuses.
  deps.installPermissionHook(piSession);
  deps.installModsHooks(piSession);

  // Store session for reuse — evict oldest if cache is full
  if (deps.sessions.size >= deps.maxCachedSessions) {
    const oldestKey = deps.sessions.keys().next().value;
    if (oldestKey) {
      const oldest = deps.sessions.get(oldestKey);
      if (oldest) {
        try {
          oldest.session.dispose();
        } catch (e) {
          logWarn('[CoworkAgentRunner] dispose error on eviction:', e);
        }
      }
      deps.sessions.delete(oldestKey);
      log('[CoworkAgentRunner] Evicted oldest cached session:', oldestKey);
    }
  }
  deps.sessions.set(deps.session.id, {
    session: piSession,
    modelId: deps.piModel.id,
    thinkingLevel: deps.thinkingLevel,
    runtimeSignature: deps.runtimeSignature,
    skillsSignature: deps.skillsSignature,
    sessionContextSignature: deps.sessionContextSignature,
  });

  // Outgoing-payload hook (Ollama num_ctx + relay thinking-part repair).
  // The policy itself lives in ./openai-payload-sanitizer (unit-tested).
  deps.installPayloadHook(piSession, {
    provider: deps.provider,
    customProtocol: deps.customProtocol,
    baseUrl: deps.effectiveBaseUrl,
    modelId: deps.piModel.id,
    contextWindow: deps.piModel.contextWindow,
  });

  return piSession;
}
