/**
 * @module main/agent/reuse-pi-session
 *
 * Reuses a cached pi session for a follow-up turn. The SDK retains the full
 * conversation history across turns, so the only work is the native hot-swap of
 * the model and the thinking level when either changed since the session was
 * created, plus refreshing the Ollama `num_ctx` reference.
 *
 * Extracted from CoworkAgentRunner.run() so the reuse path is unit-testable
 * without a runner instance. Logging goes through the shared logger, which is
 * Electron-free.
 */
import type { AgentSession as PiAgentSession } from '@mariozechner/pi-coding-agent';
import { log, logCtx, logTiming } from '../utils/logger';
import type { CachedPiSession } from './create-pi-session';

export interface ReusePiSessionDeps {
  cachedSession: CachedPiSession;
  sessionId: string;
  /** Model resolved for this turn; hot-swapped onto the live session if it changed. */
  piModel: Parameters<PiAgentSession['setModel']>[0];
  thinkingLevel: Parameters<PiAgentSession['setThinkingLevel']>[0];
  runStartTime: number;
}

export async function reusePiSession(deps: ReusePiSessionDeps): Promise<PiAgentSession> {
  const { cachedSession } = deps;

  // Reuse existing session — SDK retains full conversation history and handles compaction
  const piSession = cachedSession.session;

  // Hot-swap model/thinking if changed — SDK supports this natively
  if (cachedSession.modelId !== deps.piModel.id) {
    logCtx(
      '[CoworkAgentRunner] Model changed, hot-swapping:',
      cachedSession.modelId,
      '→',
      deps.piModel.id
    );
    await piSession.setModel(deps.piModel);
    cachedSession.modelId = deps.piModel.id;
    // Update Ollama num_ctx ref if present
    if (cachedSession.ollamaNumCtx) {
      cachedSession.ollamaNumCtx.value = deps.piModel.contextWindow || 128000;
      log(
        '[CoworkAgentRunner] Updated Ollama num_ctx on hot-swap:',
        cachedSession.ollamaNumCtx.value
      );
    }
  }
  if (cachedSession.thinkingLevel !== deps.thinkingLevel) {
    logCtx(
      '[CoworkAgentRunner] Thinking level changed, hot-swapping:',
      cachedSession.thinkingLevel,
      '→',
      deps.thinkingLevel
    );
    piSession.setThinkingLevel(deps.thinkingLevel);
    cachedSession.thinkingLevel = deps.thinkingLevel;
  }

  logCtx('[CoworkAgentRunner] Reusing cached pi session for:', deps.sessionId);
  logTiming('agent session reused', deps.runStartTime);

  return piSession;
}
