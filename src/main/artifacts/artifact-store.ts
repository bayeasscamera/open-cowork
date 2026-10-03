/**
 * @module main/artifacts/artifact-store
 *
 * Persistent artifacts: content the agent produced that is *stored* rather than
 * left in the workspace, so it survives the session ending and the source file
 * being edited or deleted underneath it.
 *
 * Deliberately separate from reading a workspace file. That path is a view onto
 * whatever currently sits on disk and is not persisted; this is a record with
 * its own history. The two coexist rather than one replacing the other.
 *
 * Every save appends a version. Nothing is overwritten in place, so a reader
 * can always see what the content was at any earlier point, and a bad edit is
 * recoverable rather than destructive.
 */

import { randomUUID } from 'crypto';

/** Coarse content classification. Drives preview vs. raw in the UI. */
export type ArtifactKind = 'text' | 'markdown' | 'code' | 'json' | 'html' | 'image' | 'other';

export interface ArtifactVersion {
  version: number;
  content: string;
  mimeType: string | null;
  byteSize: number;
  createdAt: number;
}

export interface Artifact {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  title: string;
  kind: ArtifactKind;
  currentVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactWithContent extends Artifact {
  content: string;
  mimeType: string | null;
}

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactValidationError';
  }
}

/**
 * Upper bound on a single version's content.
 *
 * The point of an artifact is that it is stored, so this bounds database growth
 * rather than protecting the renderer from an oversized read. Large binary
 * output belongs on disk and referenced by path, not inlined here.
 */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

const KINDS: readonly ArtifactKind[] = [
  'text',
  'markdown',
  'code',
  'json',
  'html',
  'image',
  'other',
];

/** Best-effort classification from a title and/or mime type. */
export function inferArtifactKind(title: string, mimeType?: string | null): ArtifactKind {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.includes('json')) return 'json';
  if (mime.includes('markdown') || mime.endsWith('.md')) return 'markdown';
  if (mime.includes('html')) return 'html';
  if (mime.startsWith('image/')) return 'image';
  if (mime.includes('javascript') || mime.includes('typescript')) return 'code';

  const lower = title.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(lower)) return 'image';
  if (/\.(js|jsx|ts|tsx|py|rb|go|rs|java|c|h|cpp|sh|sql|php|swift|kt)$/.test(lower)) {
    return 'code';
  }
  return 'text';
}

function validateTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new ArtifactValidationError('Artifact title is required');
  if (trimmed.length > 300) {
    throw new ArtifactValidationError('Artifact title must be 300 characters or fewer');
  }
  return trimmed;
}

function validateContent(content: string): void {
  if (typeof content !== 'string') {
    throw new ArtifactValidationError('Artifact content must be a string');
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new ArtifactValidationError(
      `Artifact content must be ${MAX_ARTIFACT_BYTES} bytes or fewer (received ${bytes})`
    );
  }
}

interface ArtifactRow {
  id: string;
  session_id: string | null;
  project_id: string | null;
  title: string;
  kind: string;
  current_version: number;
  created_at: number;
  updated_at: number;
}

interface ArtifactVersionRow {
  artifact_id: string;
  version: number;
  content: string;
  mime_type: string | null;
  byte_size: number;
  created_at: number;
}

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    title: row.title,
    kind: (KINDS as readonly string[]).includes(row.kind) ? (row.kind as ArtifactKind) : 'other',
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateArtifactInput {
  title: string;
  content: string;
  sessionId?: string | null;
  projectId?: string | null;
  mimeType?: string | null;
  kind?: ArtifactKind;
}

export interface SaveVersionInput {
  artifactId: string;
  content: string;
  mimeType?: string | null;
  /** Optional new title, so a renamed file does not need a second artifact. */
  title?: string;
}

export class ArtifactStore {
  constructor(
    private readonly deps: {
      artifacts: {
        create: (row: ArtifactRow) => void;
        update: (id: string, updates: Partial<ArtifactRow>) => void;
        get: (id: string) => ArtifactRow | undefined;
        delete: (id: string) => void;
        listBySession: (sessionId: string) => ArtifactRow[];
        listByProject: (projectId: string) => ArtifactRow[];
        listAll: () => ArtifactRow[];
      };
      versions: {
        insert: (row: ArtifactVersionRow) => void;
        get: (artifactId: string, version: number) => ArtifactVersionRow | undefined;
        latest: (artifactId: string) => ArtifactVersionRow | undefined;
        list: (artifactId: string) => ArtifactVersionRow[];
        deleteByArtifact: (artifactId: string) => void;
      };
      /** Runs `fn` atomically; used so a version and its header never diverge. */
      transaction: <T>(fn: () => T) => T;
    }
  ) {}

  list(options: { sessionId?: string; projectId?: string } = {}): Artifact[] {
    let rows: ArtifactRow[];
    if (options.sessionId) {
      rows = this.deps.artifacts.listBySession(options.sessionId);
    } else if (options.projectId) {
      rows = this.deps.artifacts.listByProject(options.projectId);
    } else {
      rows = this.deps.artifacts.listAll();
    }
    return rows
      .map(rowToArtifact)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(artifactId: string): Artifact | undefined {
    const row = this.deps.artifacts.get(artifactId);
    return row ? rowToArtifact(row) : undefined;
  }

  /** The artifact with its current content resolved. */
  getWithContent(artifactId: string): ArtifactWithContent | undefined {
    const artifact = this.get(artifactId);
    if (!artifact) return undefined;
    const version = this.deps.versions.latest(artifactId);
    if (!version) return { ...artifact, content: '', mimeType: null };
    return {
      ...artifact,
      content: version.content,
      mimeType: version.mime_type,
    };
  }

  create(input: CreateArtifactInput): Artifact {
    const title = validateTitle(input.title);
    validateContent(input.content);
    const now = Date.now();
    const row: ArtifactRow = {
      id: `artifact-${randomUUID()}`,
      session_id: input.sessionId?.trim() || null,
      project_id: input.projectId?.trim() || null,
      title,
      kind: input.kind ?? inferArtifactKind(title, input.mimeType),
      current_version: 1,
      created_at: now,
      updated_at: now,
    };

    this.deps.transaction(() => {
      this.deps.artifacts.create(row);
      this.deps.versions.insert({
        artifact_id: row.id,
        version: 1,
        content: input.content,
        mime_type: input.mimeType?.trim() || null,
        byte_size: Buffer.byteLength(input.content, 'utf8'),
        created_at: now,
      });
    });

    return rowToArtifact(row);
  }

  /** Append a new version. The previous one is kept, never replaced. */
  saveVersion(input: SaveVersionInput): Artifact {
    validateContent(input.content);
    const existing = this.deps.artifacts.get(input.artifactId);
    if (!existing) {
      throw new ArtifactValidationError(`Unknown artifact: ${input.artifactId}`);
    }

    const now = Date.now();
    const version = existing.current_version + 1;
    const title = input.title !== undefined ? validateTitle(input.title) : existing.title;

    this.deps.transaction(() => {
      this.deps.versions.insert({
        artifact_id: existing.id,
        version,
        content: input.content,
        mime_type: input.mimeType?.trim() || null,
        byte_size: Buffer.byteLength(input.content, 'utf8'),
        created_at: now,
      });
      this.deps.artifacts.update(existing.id, {
        title,
        current_version: version,
        updated_at: now,
      });
    });

    return rowToArtifact(this.deps.artifacts.get(existing.id) as ArtifactRow);
  }

  versions(artifactId: string): ArtifactVersion[] {
    return this.deps.versions
      .list(artifactId)
      .map((row) => ({
        version: row.version,
        content: row.content,
        mimeType: row.mime_type,
        byteSize: row.byte_size,
        createdAt: row.created_at,
      }))
      .sort((a, b) => b.version - a.version);
  }

  /** The content at a specific version, for comparing or restoring. */
  getVersion(artifactId: string, version: number): ArtifactVersion | undefined {
    const row = this.deps.versions.get(artifactId, version);
    if (!row) return undefined;
    return {
      version: row.version,
      content: row.content,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      createdAt: row.created_at,
    };
  }

  delete(artifactId: string): boolean {
    if (!this.deps.artifacts.get(artifactId)) return false;
    this.deps.transaction(() => {
      this.deps.versions.deleteByArtifact(artifactId);
      this.deps.artifacts.delete(artifactId);
    });
    return true;
  }
}