export type PersonalFilesErrorCode =
  | 'forbidden'
  | 'unavailable'
  | 'invalid_input'
  | 'not_found'
  | 'version_conflict'
  | 'failed';

export type PersonalFilesResult<T> =
  | { success: true; data: T }
  | { success: false; error: PersonalFilesErrorCode };

export interface PersonalFileSummary {
  path: string;
  version: string;
  sizeBytes: number;
  updatedAt: number;
}

export interface PersonalFile extends PersonalFileSummary {
  content: string;
}

export interface PersonalFileRevision {
  generation: number;
  revision: number;
  version: string | null;
  content: string | null;
  deleted: boolean;
  timestamp: number;
}

export interface PersonalFileRestoreRequest {
  path: string;
  generation: number;
  revision: number;
  /** Current version from read; missing files are intentionally not restorable in this UI. */
  expectedVersion: string;
}

export interface PersonalFilesAPI {
  list: () => Promise<PersonalFilesResult<PersonalFileSummary[]>>;
  read: (path: string) => Promise<PersonalFilesResult<PersonalFile>>;
  history: (path: string) => Promise<PersonalFilesResult<PersonalFileRevision[]>>;
  restore: (request: PersonalFileRestoreRequest) => Promise<PersonalFilesResult<PersonalFile>>;
}
