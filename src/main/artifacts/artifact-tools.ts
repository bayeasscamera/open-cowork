/**
 * @module main/artifacts/artifact-tools
 *
 * Agent-facing tools for persistent artifacts.
 *
 * The store exists; without these tools the agent has no way to reach it, so
 * the table would stay empty. Registered through the extension surface like
 * every other capability, which is what puts the tools into the real agent
 * session rather than beside it.
 *
 * Reading and writing are routine and stay unprompted. Deletion is different:
 * it discards every version at once and cannot be undone from the store, so it
 * requires explicit human confirmation through an injected callback. With no
 * callback wired, deletion refuses rather than proceeding unconfirmed.
 */

import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import {
  ArtifactStore,
  ArtifactValidationError,
  MAX_ARTIFACT_BYTES,
} from './artifact-store';

export interface ArtifactToolsOptions {
  store: ArtifactStore;
  /** Session the artifact belongs to. */
  sessionId: string;
  /** Project the artifact belongs to, when the session is in one. */
  projectId?: string | null;
  /**
   * Ask the human before deleting. Absent means deletion is unavailable, which
   * is the safe direction: an agent must not be able to destroy history it
   * cannot restore.
   */
  confirmDelete?: (toolUseId: string, artifactId: string, title: string) => Promise<boolean>;
}

function result(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    details: undefined,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Validation failures are the model's own mistake and are reported back so it
  // can correct the call; anything else is reported the same way rather than
  // thrown, because an uncaught throw in a tool aborts the turn.
  const code = error instanceof ArtifactValidationError ? 'invalid_params' : 'artifact_error';
  return result({ error: code, message });
}

const CONTENT_LIMIT_HINT = `Content is capped at ${MAX_ARTIFACT_BYTES} bytes per version; write large output to a file and store its path instead.`;

function createArtifactCreateTool(options: ArtifactToolsOptions): AgentRuntimeCustomTool {
  return {
    name: 'artifact_create',
    label: 'artifact_create',
    description:
      'Store content the user produced as a persistent artifact. Unlike a workspace file, an ' +
      'artifact is kept by the app: it survives the session ending and the file being edited ' +
      'or deleted, and every save appends a version instead of overwriting. Use it for output ' +
      'worth revisiting (reports, generated documents, reviewed code). ' +
      CONTENT_LIMIT_HINT,
    parameters: Type.Object({
      title: Type.String({
        description:
          'Human-readable name. Include the extension so the content is classified correctly ' +
          '(e.g. "report.md", "data.json").',
      }),
      content: Type.String({ description: 'The full content of this version.' }),
      mime_type: Type.Optional(
        Type.String({ description: 'Content type, when it cannot be inferred from the title.' })
      ),
    }),
    async execute(_toolUseId: string, params: unknown) {
      try {
        const p = (params || {}) as { title?: string; content?: string; mime_type?: string };
        if (typeof p.title !== 'string' || typeof p.content !== 'string') {
          return result({ error: 'invalid_params', message: '"title" and "content" are required.' });
        }
        const artifact = options.store.create({
          title: p.title,
          content: p.content,
          mimeType: p.mime_type ?? null,
          sessionId: options.sessionId,
          projectId: options.projectId ?? null,
        });
        return result({ id: artifact.id, title: artifact.title, kind: artifact.kind, version: 1 });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

function createArtifactSaveVersionTool(options: ArtifactToolsOptions): AgentRuntimeCustomTool {
  return {
    name: 'artifact_save_version',
    label: 'artifact_save_version',
    description:
      'Append a new version to an existing artifact. The previous version is kept, not ' +
      'replaced, so the history stays readable. Use this instead of re-creating the artifact, ' +
      'which would orphan the earlier versions. ' +
      CONTENT_LIMIT_HINT,
    parameters: Type.Object({
      artifact_id: Type.String({ description: 'Id returned by artifact_create.' }),
      content: Type.String({ description: 'The new content for this version.' }),
      title: Type.Optional(
        Type.String({ description: 'New title, when the artifact has been renamed.' })
      ),
      mime_type: Type.Optional(Type.String({ description: 'Content type, when it has changed.' })),
    }),
    async execute(_toolUseId: string, params: unknown) {
      try {
        const p = (params || {}) as {
          artifact_id?: string;
          content?: string;
          title?: string;
          mime_type?: string;
        };
        if (typeof p.artifact_id !== 'string' || typeof p.content !== 'string') {
          return result({
            error: 'invalid_params',
            message: '"artifact_id" and "content" are required.',
          });
        }
        const updated = options.store.saveVersion({
          artifactId: p.artifact_id,
          content: p.content,
          title: p.title,
          mimeType: p.mime_type,
        });
        return result({
          id: updated.id,
          title: updated.title,
          version: updated.currentVersion,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

function createArtifactListTool(options: ArtifactToolsOptions): AgentRuntimeCustomTool {
  return {
    name: 'artifact_list',
    label: 'artifact_list',
    description:
      'List the artifacts of this session (or of a project), most recently updated first. ' +
      'Returns metadata only; use artifact_read for the content.',
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([Type.Literal('session'), Type.Literal('project')], {
          description:
            'Which artifacts to list. Defaults to the current session; "project" spans every ' +
            'session in the same project.',
        })
      ),
      include_content: Type.Optional(
        Type.Boolean({ description: 'Include the current content of each artifact. Off by default.' })
      ),
    }),
    async execute(_toolUseId: string, params: unknown) {
      try {
        const p = (params || {}) as { scope?: string; include_content?: boolean };
        const scope = p.scope === 'project' ? 'project' : 'session';
        if (scope === 'project' && !options.projectId) {
          return result({ error: 'invalid_params', message: 'This session has no project.' });
        }
        const artifacts = options.store.list(
          scope === 'project' ? { projectId: options.projectId as string } : { sessionId: options.sessionId }
        );

        return result({
          artifacts: artifacts.map((artifact) => {
            const base = {
              id: artifact.id,
              title: artifact.title,
              kind: artifact.kind,
              version: artifact.currentVersion,
              updatedAt: artifact.updatedAt,
            };
            if (!p.include_content) return base;
            const withContent = options.store.getWithContent(artifact.id);
            return { ...base, content: withContent?.content ?? '' };
          }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

function createArtifactReadTool(options: ArtifactToolsOptions): AgentRuntimeCustomTool {
  return {
    name: 'artifact_read',
    label: 'artifact_read',
    description:
      'Read an artifact. By default returns the current version; pass "version" to read an ' +
      'earlier one, which is how you compare against what the content was before a change.',
    parameters: Type.Object({
      artifact_id: Type.String({ description: 'Id of the artifact to read.' }),
      version: Type.Optional(
        Type.Number({ description: 'Specific version to read. Defaults to the current version.' })
      ),
      list_versions: Type.Optional(
        Type.Boolean({ description: 'Return the version history with their sizes instead of content.' })
      ),
    }),
    async execute(_toolUseId: string, params: unknown) {
      try {
        const p = (params || {}) as {
          artifact_id?: string;
          version?: number;
          list_versions?: boolean;
        };
        if (typeof p.artifact_id !== 'string') {
          return result({ error: 'invalid_params', message: '"artifact_id" is required.' });
        }

        if (p.list_versions) {
          const history = options.store.versions(p.artifact_id);
          if (history.length === 0 && !options.store.get(p.artifact_id)) {
            return result({ error: 'not_found', message: `Unknown artifact: ${p.artifact_id}` });
          }
          return result({
            versions: history.map((v) => ({
              version: v.version,
              byteSize: v.byteSize,
              createdAt: v.createdAt,
            })),
          });
        }

        if (p.version !== undefined) {
          const version = options.store.getVersion(p.artifact_id, p.version);
          if (!version) {
            return result({
              error: 'not_found',
              message: `No version ${p.version} for artifact ${p.artifact_id}.`,
            });
          }
          return result({ artifactId: p.artifact_id, version: version.version, content: version.content });
        }

        const artifact = options.store.getWithContent(p.artifact_id);
        if (!artifact) {
          return result({ error: 'not_found', message: `Unknown artifact: ${p.artifact_id}` });
        }
        return result({
          id: artifact.id,
          title: artifact.title,
          kind: artifact.kind,
          version: artifact.currentVersion,
          content: artifact.content,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

function createArtifactDeleteTool(options: ArtifactToolsOptions): AgentRuntimeCustomTool {
  return {
    name: 'artifact_delete',
    label: 'artifact_delete',
    description:
      'Delete an artifact and every version it holds. This cannot be undone from the app, so it ' +
      'always asks the human first. Prefer leaving an artifact in place and starting a new one ' +
      'when the intent is to revise rather than discard.',
    parameters: Type.Object({
      artifact_id: Type.String({ description: 'Id of the artifact to delete.' }),
      reason: Type.Optional(
        Type.String({ description: 'Why it is being deleted, shown to the human when asked.' })
      ),
    }),
    async execute(toolUseId: string, params: unknown) {
      try {
        const p = (params || {}) as { artifact_id?: string; reason?: string };
        if (typeof p.artifact_id !== 'string') {
          return result({ error: 'invalid_params', message: '"artifact_id" is required.' });
        }
        const artifact = options.store.get(p.artifact_id);
        if (!artifact) {
          return result({ error: 'not_found', message: `Unknown artifact: ${p.artifact_id}` });
        }
        // Fail closed: without a confirmation channel there is nobody to ask,
        // so the deletion does not happen.
        if (!options.confirmDelete) {
          return result({
            error: 'confirmation_unavailable',
            message:
              'Deleting an artifact needs human confirmation and none is available in this ' +
              'context. Ask the user to remove it themselves.',
          });
        }
        const approved = await options.confirmDelete(toolUseId, artifact.id, artifact.title);
        if (approved !== true) {
          return result({ error: 'confirmation_denied', message: 'The user declined the deletion.' });
        }
        options.store.delete(artifact.id);
        return result({ deleted: true, id: artifact.id, title: artifact.title });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

/** All artifact tools for one session, ready to hand to the extension surface. */
export function createArtifactTools(options: ArtifactToolsOptions): AgentRuntimeCustomTool[] {
  return [
    createArtifactCreateTool(options),
    createArtifactSaveVersionTool(options),
    createArtifactListTool(options),
    createArtifactReadTool(options),
    createArtifactDeleteTool(options),
  ];
}