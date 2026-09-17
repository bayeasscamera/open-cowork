import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { MemoryService } from './memory-service';

export class MemoryExtension implements AgentRuntimeExtension {
  readonly name = 'memory';

  constructor(private readonly memoryService: MemoryService) {}

  async beforeSessionRun({
    session,
    prompt,
  }: Parameters<
    NonNullable<AgentRuntimeExtension['beforeSessionRun']>
  >[0]): Promise<BeforeSessionRunResult> {
    try {
      if (!this.memoryService.isSessionEnabled(session)) return { memoryEnabled: false };
      let promptPrefix = '';
      try {
        promptPrefix = await this.memoryService.buildPromptPrefix(session, prompt);
      } catch {
        // Auxiliary retrieval must not disable the independent local file store.
      }
      if (!this.memoryService.isSessionEnabled(session)) return { memoryEnabled: false };
      return {
        promptPrefix,
        systemContext: this.memoryService.buildFileSystemContext(session),
        customTools: this.memoryService.getTools(session),
        memoryEnabled: true,
        refreshSession: true,
      };
    } catch {
      return { memoryEnabled: false, refreshSession: true };
    }
  }

  async afterSessionRun({
    session,
    prompt,
    messages,
  }: Parameters<NonNullable<AgentRuntimeExtension['afterSessionRun']>>[0]): Promise<void> {
    try {
      if (!this.memoryService.isSessionEnabled(session)) return;
      await this.memoryService.enqueueIngestion({ session, prompt, messages });
    } catch {
      /* Memory failures must not fail a conversation or expose its content. */
    }
  }

  async onSessionDeleted({
    sessionId,
  }: Parameters<NonNullable<AgentRuntimeExtension['onSessionDeleted']>>[0]): Promise<void> {
    try {
      await this.memoryService.deleteSession(sessionId);
    } catch {
      /* Best effort legacy cleanup. */
    }
  }
}
