/**
 * @module main/artifacts/artifact-extension
 *
 * Registers the artifact tools on the agent runtime extension surface, which is
 * the only path that puts a tool into the live agent session. Registering them
 * anywhere else would leave the store unreachable by the model.
 *
 * Artifacts are scoped to the session, so the session id is captured per run
 * rather than at construction: a single extension instance serves every session.
 */

import type {
  AgentRuntimeExtension,
  BeforeSessionRunResult,
} from '../extensions/agent-runtime-extension';
import type { ArtifactStore } from './artifact-store';
import { createArtifactTools } from './artifact-tools';

export interface ArtifactExtensionOptions {
  /**
   * Resolve the store per call. Reading it lazily keeps the extension safe to
   * construct before the database is initialised, matching how the project
   * store is consumed elsewhere.
   */
  getStore: () => ArtifactStore;
  /** Project the session belongs to, when it is in one. */
  getProjectId?: (sessionId: string) => string | null;
  /**
   * Ask the human before deleting an artifact. Omitted in contexts without a
   * dialog (background subagents), which makes deletion refuse rather than
   * proceed unconfirmed.
   */
  confirmDelete?: (toolUseId: string, artifactId: string, title: string) => Promise<boolean>;
}

export class ArtifactExtension implements AgentRuntimeExtension {
  readonly name = 'artifacts';

  constructor(private readonly options: ArtifactExtensionOptions) {}

  async beforeSessionRun(context: {
    session: { id: string };
  }): Promise<BeforeSessionRunResult> {
    const sessionId = context.session.id;
    return {
      customTools: createArtifactTools({
        store: this.options.getStore(),
        sessionId,
        projectId: this.options.getProjectId?.(sessionId) ?? null,
        confirmDelete: this.options.confirmDelete,
      }),
    };
  }
}