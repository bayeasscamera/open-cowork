/**
 * Renderer-facing contract for persistent artifacts.
 *
 * Shared so the preload bridge, the IPC handlers and the renderer panel all
 * agree on one shape. Deliberately narrow: the renderer gets what it needs to
 * display and browse history, and nothing about how content is stored.
 */

export type ArtifactKindUi = 'text' | 'markdown' | 'code' | 'json' | 'html' | 'image' | 'other';

/** Metadata only, as listed in the panel. Never carries content. */
export interface PersistentArtifact {
  id: string;
  title: string;
  kind: ArtifactKindUi;
  /** Current version number; 1 for an artifact that has never been revised. */
  version: number;
  updatedAt: number;
  createdAt?: number;
}

export interface PersistentArtifactContent extends PersistentArtifact {
  content: string;
}

/** One entry of an artifact's history. Metadata only, by design. */
export interface PersistentArtifactVersion {
  version: number;
  byteSize: number;
  createdAt: number;
}