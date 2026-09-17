import type {
  PersonalFile,
  PersonalFileRevision,
  PersonalFileSummary,
  PersonalFilesResult,
} from '../../shared/personal-files';
import {
  canonicalizeMemoryPath,
  MemoryFilesError,
  type MemoryFilesStore,
} from './memory-files-store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Only constructed by the trusted main process. No operation accepts an owner. */
export class PersonalFilesManager {
  constructor(
    private readonly store: () => MemoryFilesStore,
    private readonly owner: () => string | undefined
  ) {}

  private run<T>(operation: (store: MemoryFilesStore, owner: string) => T): PersonalFilesResult<T> {
    try {
      const owner = this.owner();
      if (!owner || !owner.trim() || owner.length > 256)
        return { success: false, error: 'unavailable' };
      return { success: true, data: operation(this.store(), owner) };
    } catch (error) {
      const code = error instanceof MemoryFilesError ? error.code : 'db_error';
      return {
        success: false,
        error:
          code === 'version_conflict' || code === 'not_found'
            ? code
            : code.startsWith('invalid_')
              ? 'invalid_input'
              : 'failed',
      };
    }
  }

  private path(input: unknown): string {
    if (typeof input !== 'string') throw new MemoryFilesError('invalid_input', 'Invalid request.');
    return canonicalizeMemoryPath(input);
  }

  list(): PersonalFilesResult<PersonalFileSummary[]> {
    return this.run((store, owner) => store.list(owner));
  }

  read(input: unknown): PersonalFilesResult<PersonalFile> {
    return this.run((store, owner) => store.read(owner, this.path(input)));
  }

  history(input: unknown): PersonalFilesResult<PersonalFileRevision[]> {
    return this.run((store, owner) =>
      store
        .readHistory(owner, this.path(input))
        .map(({ generation, revision, version, content, deleted, timestamp }) => ({
          generation,
          revision,
          version,
          content,
          deleted,
          timestamp,
        }))
    );
  }

  restore(input: unknown): PersonalFilesResult<PersonalFile> {
    return this.run((store, owner) => {
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new MemoryFilesError('invalid_input', 'Invalid request.');
      const request = input as Record<string, unknown>;
      if (
        Object.keys(request).sort().join(',') !== 'expectedVersion,generation,path,revision' ||
        !Number.isSafeInteger(request.generation) ||
        Number(request.generation) < 1 ||
        !Number.isSafeInteger(request.revision) ||
        Number(request.revision) < 1 ||
        typeof request.expectedVersion !== 'string' ||
        !UUID.test(request.expectedVersion)
      ) {
        throw new MemoryFilesError('invalid_input', 'Invalid request.');
      }
      const path = this.path(request.path);
      // Resolve content only from this owner's retained SQLite revision identity.
      const revision = store
        .readHistory(owner, path)
        .find(
          (item) => item.generation === request.generation && item.revision === request.revision
        );
      if (!revision) throw new MemoryFilesError('not_found', 'Revision no longer retained.');
      if (revision.deleted || revision.content === null)
        throw new MemoryFilesError('invalid_input', 'Deletion markers cannot be restored.');
      // 'new' is deliberately rejected: this UI never creates or resurrects missing files.
      store.write(owner, path, revision.content, request.expectedVersion);
      return store.read(owner, path);
    });
  }
}

interface SenderEvent {
  sender: unknown;
  senderFrame: unknown;
}
interface TrustedWindow {
  isDestroyed(): boolean;
  webContents: { mainFrame: unknown; isDestroyed(): boolean };
}

/** Exact current mainWindow and main-frame identity; never trust renderer-supplied ownership. */
export function personalFilesHandler<T>(
  getWindow: () => TrustedWindow | null,
  operation: (input: unknown) => PersonalFilesResult<T>
) {
  return (event: SenderEvent, input?: unknown): PersonalFilesResult<T> => {
    try {
      const window = getWindow();
      if (
        !window ||
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        event.sender !== window.webContents ||
        !event.senderFrame ||
        event.senderFrame !== window.webContents.mainFrame
      ) {
        return { success: false, error: 'forbidden' };
      }
      return operation(input);
    } catch {
      return { success: false, error: 'failed' };
    }
  };
}
