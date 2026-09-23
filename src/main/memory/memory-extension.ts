import { createHash } from 'node:crypto';
import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { MemoryService } from './memory-service';

/**
 * Stable signature of the creation-time memory context: the system-prompt block
 * plus the tool surface. The runner rebuilds a cached SDK session only when this
 * changes, so an unchanged memory context keeps the conversation — and the model
 * hot-swap path — reusable across turns.
 */
export function buildMemorySessionContextSignature(
  systemContext: string,
  tools: ReadonlyArray<{ name?: string; description?: string }>
): string {
  // Canonical tool surface: only the name and description are creation-time
  // state the SDK sees, and the order the service returns them in carries no
  // meaning. Sorting keeps the signature stable across equivalent tool sets so
  // the runner does not rebuild the cached SDK session for a reorder.
  const toolSurface = tools
    .map((tool) => `${tool.name ?? ''}\u0000${tool.description ?? ''}`)
    .sort();
  return createHash('sha256')
    .update(systemContext)
    .update('\u0000')
    .update(toolSurface.join('\u0001'))
    .digest('hex');
}

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
      const systemContext = this.memoryService.buildFileSystemContext(session);
      const customTools = this.memoryService.getTools(session);
      return {
        promptPrefix,
        systemContext,
        customTools,
        memoryEnabled: true,
        sessionContextSignature: buildMemorySessionContextSignature(systemContext, customTools),
      };
    } catch {
      // No signature on failure: the runner treats it as a context change and
      // rebuilds a session that previously carried memory state.
      return { memoryEnabled: false };
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
