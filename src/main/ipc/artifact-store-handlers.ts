/**
 * @module main/ipc/artifact-store-handlers
 *
 * Renderer access to persistent artifacts (artifacts.persistent.*).
 *
 * Separate from the existing `artifacts.*` channels, which read workspace files
 * on demand and are deliberately not persisted. These expose the stored record
 * and its history.
 *
 * The session scope is *verified* rather than trusted: a caller names the
 * session it believes is active, and every read is refused unless the artifact
 * actually belongs to it. The renderer already passes session ids throughout
 * (diagnostics, memory), so this matches the existing surface while still
 * holding the boundary — a stale or wrong id returns nothing rather than
 * another conversation's artifacts.
 *
 * Deletion goes through a confirmation callback supplied by the caller. Without
 * one it fails closed — the same direction the agent tool takes, because
 * discarding every version is not reversible from the store.
 */

import { ipcMain } from 'electron';
import type { ArtifactStore } from '../artifacts/artifact-store';

export interface ArtifactStoreIpcContext {
  getStore(): ArtifactStore;
  /** Project of the given session, when it is in one. */
  getProjectId?(sessionId: string): string | null;
  /**
   * Ask the human before deleting. Omitted in contexts with no dialog, which
   * makes deletion refuse instead of proceeding.
   */
  confirmDelete?(artifactId: string, title: string): Promise<boolean>;
}

/** Whether this artifact may be shown to the renderer looking at `sessionId`. */
function belongsToSession(
  artifact: { sessionId: string | null; projectId: string | null },
  sessionId: string,
  projectId: string | null
): boolean {
  if (artifact.sessionId === sessionId) return true;
  // Project-scoped viewing legitimately spans the project's other sessions.
  return projectId !== null && artifact.projectId === projectId;
}

export function registerArtifactStoreIpcHandlers(context: ArtifactStoreIpcContext): void {
  ipcMain.handle(
    'artifacts.persistent.list',
    (_event, sessionId: string | null, scope?: 'session' | 'project') => {
      if (!sessionId) return [];
      const store = context.getStore();
      const projectId = context.getProjectId?.(sessionId) ?? null;
      if (scope === 'project') {
        if (!projectId) return [];
        return store.list({ projectId });
      }
      return store.list({ sessionId });
    }
  );

  ipcMain.handle('artifacts.persistent.get', (_event, sessionId: string | null, artifactId: string) => {
    if (!sessionId) return null;
    const store = context.getStore();
    const artifact = store.getWithContent(artifactId);
    if (!artifact) return null;
    const projectId = context.getProjectId?.(sessionId) ?? null;
    if (!belongsToSession(artifact, sessionId, projectId)) return null;
    return {
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      version: artifact.currentVersion,
      content: artifact.content,
      updatedAt: artifact.updatedAt,
    };
  });

  ipcMain.handle('artifacts.persistent.versions', (_event, sessionId: string | null, artifactId: string) => {
    if (!sessionId) return [];
    const store = context.getStore();
    const artifact = store.get(artifactId);
    if (!artifact) return [];
    const projectId = context.getProjectId?.(sessionId) ?? null;
    if (!belongsToSession(artifact, sessionId, projectId)) return [];
    // Metadata only: listing the history must not pull every version's content
    // into the renderer.
    return store.versions(artifactId).map((v) => ({
      version: v.version,
      byteSize: v.byteSize,
      createdAt: v.createdAt,
    }));
  });

  ipcMain.handle(
    'artifacts.persistent.version',
    (_event, sessionId: string | null, artifactId: string, version: number) => {
      if (!sessionId) return null;
      const store = context.getStore();
      const artifact = store.get(artifactId);
      if (!artifact) return null;
      const projectId = context.getProjectId?.(sessionId) ?? null;
      if (!belongsToSession(artifact, sessionId, projectId)) return null;
      const found = store.getVersion(artifactId, version);
      if (!found) return null;
      return { version: found.version, content: found.content, createdAt: found.createdAt };
    }
  );

  ipcMain.handle(
    'artifacts.persistent.delete',
    async (_event, sessionId: string | null, artifactId: string) => {
      const store = context.getStore();
      const artifact = store.get(artifactId);
      if (!artifact) {
        return { success: false as const, error: 'not_found' };
      }
      const projectId = sessionId ? (context.getProjectId?.(sessionId) ?? null) : null;
      // Same ownership check as the reads: a caller cannot delete an artifact
      // from a session it is not looking at.
      if (!sessionId || !belongsToSession(artifact, sessionId, projectId)) {
        return { success: false as const, error: 'not_found' };
      }
      if (!context.confirmDelete) {
        return {
          success: false as const,
          error: 'confirmation_unavailable',
        };
      }
      const approved = await context.confirmDelete(artifact.id, artifact.title);
      if (approved !== true) {
        return { success: false as const, error: 'confirmation_denied' };
      }
      store.delete(artifact.id);
      return { success: true as const };
    }
  );
}