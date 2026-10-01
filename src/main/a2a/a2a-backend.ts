/**
 * @module main/a2a/a2a-backend
 *
 * Production `A2ABackend` over the app's SessionManager.
 * Imported only from `src/main/index.ts` (never from tests — tests fake the
 * interface in `a2a-server.ts` instead).
 */
import type { SessionManager } from '../session/session-manager';
import {
  LOCKDOWN_ALLOWED_TOOLS,
  clearSessionToolLockdown,
  setSessionToolLockdown,
} from '../config/permission-rules-store';
import type { A2ABackend } from './a2a-server';

export function createProductionA2ABackend(sessionManager: SessionManager): A2ABackend {
  return {
    async createSession(title: string, prompt: string) {
      const session = await sessionManager.startSession(title, prompt);
      return { sessionId: session.id };
    },
    async continueSession(sessionId: string, prompt: string) {
      await sessionManager.continueSession(sessionId, prompt);
    },
    getSessionStatus(sessionId: string) {
      const session = sessionManager.loadSession(sessionId);
      return session ? session.status : null;
    },
    getAnswerText(sessionId: string) {
      return sessionManager.getLastAssistantText(sessionId);
    },
    cancelSession(sessionId: string) {
      sessionManager.stopSession(sessionId);
    },
    lockSession(sessionId: string) {
      setSessionToolLockdown(sessionId, LOCKDOWN_ALLOWED_TOOLS);
    },
    unlockSession(sessionId: string) {
      clearSessionToolLockdown(sessionId);
    },
    buildTitle(prompt: string) {
      const oneLine = prompt.replace(/\s+/g, ' ').trim();
      return oneLine.length > 80 ? `A2A: ${oneLine.slice(0, 77)}…` : `A2A: ${oneLine}`;
    },
  };
}
