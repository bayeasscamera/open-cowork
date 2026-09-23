/**
 * @module main/ipc/project-memory-handlers
 *
 * Cowork 4.0 — Phase 4.4: the "what Cowork knows about this project" surface.
 * Read, edit, delete and expire memory items per workspace, and expose the exact
 * injection that would be sent for a task.
 */

import { ipcMain } from 'electron';
import type {
  MemoryLayer,
  MemoryProvenance,
  MemoryQuery,
  ProjectMemoryItem,
  ProjectMemoryOverview,
  UpsertMemoryInput,
} from '../../shared/project-memory-types';
import { MEMORY_LAYERS } from '../../shared/project-memory-types';
import type { ProjectMemoryStore } from '../memory/project-memory-store';
import { provenance } from '../memory/project-memory-store';
import { logError } from '../utils/logger';

export interface ProjectMemoryIpcContext {
  /** Resolve the store and workspace key for a session. */
  resolve: (sessionId: string) => { store: ProjectMemoryStore; workspaceKey: string } | null;
  /** Called after a mutation so the agent cache can be invalidated. */
  onChanged?: (workspaceKey: string) => void;
}

function coerceLayer(value: unknown): MemoryLayer {
  if (typeof value === 'string' && (MEMORY_LAYERS as readonly string[]).includes(value)) {
    return value as MemoryLayer;
  }
  throw new Error('Unknown memory layer: ' + String(value));
}

function coerceProvenance(value: unknown): MemoryProvenance {
  const candidate = (value ?? {}) as Partial<MemoryProvenance>;
  const source = candidate.source;
  if (
    source !== 'commit' &&
    source !== 'test' &&
    source !== 'adr' &&
    source !== 'doc' &&
    source !== 'user-decision' &&
    source !== 'session' &&
    source !== 'agent'
  ) {
    throw new Error('Unknown memory source: ' + String(source));
  }
  if (typeof candidate.reference !== 'string' || candidate.reference.length === 0) {
    throw new Error('Memory provenance requires a reference.');
  }
  return provenance(source, candidate.reference, candidate.locator);
}

export function registerProjectMemoryIpcHandlers(context: ProjectMemoryIpcContext): void {
  const requireTarget = (sessionId: string) => {
    const target = context.resolve(sessionId);
    if (!target) {
      throw new Error('No workspace is available for session "' + sessionId + '".');
    }
    return target;
  };

  ipcMain.handle('projectMemory.overview', (_event, sessionId: string): ProjectMemoryOverview => {
    const { store, workspaceKey } = requireTarget(sessionId);
    return store.overview(workspaceKey);
  });

  ipcMain.handle(
    'projectMemory.list',
    (_event, sessionId: string, layer?: string): ProjectMemoryItem[] => {
      const { store, workspaceKey } = requireTarget(sessionId);
      return store.list(workspaceKey, layer ? coerceLayer(layer) : undefined);
    }
  );

  ipcMain.handle('projectMemory.upsert', (_event, sessionId: string, input: UpsertMemoryInput) => {
    const { store, workspaceKey } = requireTarget(sessionId);
    if (!input || typeof input.statement !== 'string' || input.statement.trim().length === 0) {
      throw new Error('Memory statement must be a non-empty string.');
    }
    const item = store.upsert({
      id: typeof input.id === 'string' ? input.id : undefined,
      workspaceKey,
      layer: coerceLayer(input.layer),
      statement: input.statement,
      provenance: coerceProvenance(input.provenance),
      tags: Array.isArray(input.tags) ? input.tags.filter((tag) => typeof tag === 'string') : [],
      confidence:
        typeof input.confidence === 'number' && input.confidence >= 0 && input.confidence <= 1
          ? input.confidence
          : undefined,
      ttlMs: input.ttlMs === undefined ? undefined : input.ttlMs,
    });
    context.onChanged?.(workspaceKey);
    return item;
  });

  ipcMain.handle('projectMemory.remove', (_event, sessionId: string, id: string) => {
    const { store, workspaceKey } = requireTarget(sessionId);
    const removed = store.remove(id);
    if (removed) {
      context.onChanged?.(workspaceKey);
    }
    return { removed };
  });

  ipcMain.handle(
    'projectMemory.clear',
    (_event, sessionId: string, layer?: string): { removed: number } => {
      const { store, workspaceKey } = requireTarget(sessionId);
      const removed = store.clearWorkspace(workspaceKey, layer ? coerceLayer(layer) : undefined);
      context.onChanged?.(workspaceKey);
      return { removed };
    }
  );

  ipcMain.handle('projectMemory.purgeExpired', (_event, sessionId: string): { removed: string[] } => {
    const { store, workspaceKey } = requireTarget(sessionId);
    const removed = store.purgeExpired(workspaceKey);
    if (removed.length > 0) {
      context.onChanged?.(workspaceKey);
    }
    return { removed };
  });

  ipcMain.handle(
    'projectMemory.preview',
    (_event, sessionId: string, query: string, limit?: number) => {
      const { store, workspaceKey } = requireTarget(sessionId);
      const request: MemoryQuery = {
        workspaceKey,
        query: typeof query === 'string' ? query : '',
        limit: typeof limit === 'number' && limit > 0 ? limit : 20,
      };
      return store.buildInjection(request);
    }
  );

  ipcMain.handle('projectMemory.seedFromAudit', (_event, sessionId: string, entries: unknown[]) => {
    try {
      const { store, workspaceKey } = requireTarget(sessionId);
      if (!Array.isArray(entries)) {
        return { added: 0 };
      }
      let added = 0;
      for (const raw of entries) {
        const entry = (raw ?? {}) as {
          action?: unknown;
          justification?: unknown;
          taskId?: unknown;
          authorization?: unknown;
        };
        if (typeof entry.action !== 'string' || typeof entry.justification !== 'string') {
          continue;
        }
        if (entry.authorization !== 'forbidden' && entry.authorization !== 'rejected') {
          continue;
        }
        if (entry.justification.trim().length === 0) {
          continue;
        }
        store.upsert({
          workspaceKey,
          layer: 'errors',
          statement: entry.action + ': ' + entry.justification,
          provenance: provenance('session', sessionId, typeof entry.taskId === 'string' ? entry.taskId : undefined),
          tags: [entry.action],
          confidence: 0.7,
        });
        added += 1;
      }
      if (added > 0) {
        context.onChanged?.(workspaceKey);
      }
      return { added };
    } catch (error: unknown) {
      logError('[projectMemory] seedFromAudit failed', error);
      throw error;
    }
  });
}
