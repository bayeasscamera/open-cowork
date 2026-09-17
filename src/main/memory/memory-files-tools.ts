import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type { MemoryFilesStore } from './memory-files-store';

export interface MemoryFileToolOptions {
  store: MemoryFilesStore;
  owner: string;
  sessionId: string;
  isEnabled: () => boolean;
  legacyRead: AgentRuntimeCustomTool;
  // Trusted host callback only; no model-supplied consent or owner.
  confirmDelete?: (toolUseId: string, path: string, version: string) => Promise<boolean>;
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
}

export function memoryFileError(error: unknown) {
  if (error instanceof Error && 'code' in error) {
    const failure = error as Error & {
      code: string;
      conflict?: { currentContent: string; currentVersion: string };
    };
    return {
      error: failure.code,
      current_content: failure.conflict?.currentContent,
      current_version: failure.conflict?.currentVersion,
    };
  }
  return { error: 'internal_error' };
}

export function createMemoryFileTools(options: MemoryFileToolOptions): AgentRuntimeCustomTool[] {
  const { store, owner } = options;
  const path = Type.String({ minLength: 1 });
  const version = Type.String({ minLength: 1 });
  const schemas = {
    memory_list: Type.Object(
      { path_prefix: Type.Optional(Type.String()), include_preview: Type.Optional(Type.Boolean()) },
      { additionalProperties: false }
    ),
    memory_read: Type.Object(
      {
        path: Type.Optional(Type.Union([path, Type.Array(path, { minItems: 1, maxItems: 20 })])),
        id: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false }
    ),
    memory_write: Type.Object(
      { path, content: Type.String(), if_version: version },
      { additionalProperties: false }
    ),
    memory_append: Type.Object(
      { path, content: Type.String(), if_version: version },
      { additionalProperties: false }
    ),
    memory_str_replace: Type.Object(
      { path, old_str: Type.String({ minLength: 1 }), new_str: Type.String(), if_version: version },
      { additionalProperties: false }
    ),
    memory_delete: Type.Object({ path, if_version: version }, { additionalProperties: false }),
  };
  const descriptions = {
    memory_list: 'List versioned memory-file metadata and optional previews.',
    memory_read:
      'Read complete memory files and versions by path (up to 20), OR a legacy memory_search item by id. Supply exactly one of path or id.',
    memory_write:
      'Create or replace a memory file. Read first; use its version, or "new" only for creation.',
    memory_append: 'Append to an existing memory file using its previously read version.',
    memory_str_replace: 'Replace an exact unique passage using the previously read file version.',
    memory_delete:
      'Delete only on explicit user request. Every call requires fresh trusted UI confirmation, even in full access mode.',
  };
  return (Object.keys(schemas) as Array<keyof typeof schemas>).map((name) => ({
    name,
    label: name,
    description: descriptions[name],
    parameters: schemas[name],
    async execute(toolUseId, params, signal, onUpdate, context) {
      try {
        if (!owner || !options.isEnabled() || signal?.aborted)
          return result({ error: 'memory_disabled' });
        if (!Value.Check(schemas[name], params)) return result({ error: 'invalid_params' });
        // Runtime schema validation above checks every field before narrowing.
        const p = params as {
          path: string;
          id?: string;
          content: string;
          if_version: string;
          old_str: string;
          new_str: string;
          path_prefix?: string;
          include_preview?: boolean;
        };
        switch (name) {
          case 'memory_list':
            return result({
              files: store.list(owner, {
                pathPrefix: p.path_prefix,
                includePreview: p.include_preview,
              }),
            });
          case 'memory_read':
            if ((p.id === undefined) === (p.path === undefined))
              return result({ error: 'invalid_params' });
            if (p.id !== undefined)
              return await options.legacyRead.execute(toolUseId, params, signal, onUpdate, context);
            return result(store.read(owner, p.path));
          case 'memory_write':
            return result(store.write(owner, p.path, p.content, p.if_version));
          case 'memory_append':
            return result(store.append(owner, p.path, p.content, p.if_version));
          case 'memory_str_replace':
            return result(store.strReplace(owner, p.path, p.old_str, p.new_str, p.if_version));
          case 'memory_delete': {
            if (!options.confirmDelete) return result({ error: 'confirmation_required' });
            const approved = await options.confirmDelete(toolUseId, p.path, p.if_version);
            if (approved !== true) return result({ error: 'confirmation_denied' });
            if (!options.isEnabled() || signal?.aborted)
              return result({ error: 'memory_disabled' });
            // Store performs CAS after approval, so intervening changes cannot be deleted.
            return result(store.delete(owner, p.path, p.if_version));
          }
        }
      } catch (error) {
        return result(memoryFileError(error));
      }
    },
  }));
}
