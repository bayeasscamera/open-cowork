/**
 * The helper API handed to a mod (`ctx`).
 *
 * This is a convenience surface, NOT a boundary. A mod can `import('node:fs')`
 * and reach everything anyway. The reason to prefer `ctx` is narrow and worth
 * stating plainly: `ctx.tools.invoke` re-enters Cowork's own tool pipeline, so
 * the preset allow-list, permissions, the path guard and `assessRisk()` still
 * apply and the approval card can name the mod that asked. A mod that reaches for
 * `node:fs` instead gets none of that, and that difference is the whole reason
 * this API exists.
 *
 * Every backend is injected. A mod must never be the reason `invokeTool`, the
 * database or Electron become hard dependencies of a testable module.
 */

import { log } from '../../utils/logger';
import type {
  ModContext,
  ModFsHelper,
  ModLog,
  ModManifest,
  ModModelAskOptions,
  ModStorage,
  ModToolResultEnvelope,
  ModUiApi,
  ModUiContribution,
} from '@cowork/mod-api';

/** Per-mod storage quota. Small on purpose: this is convenience state, not a database. */
export const MOD_STORAGE_QUOTA_BYTES = 256 * 1024;
export const MOD_STORAGE_MAX_VALUE_BYTES = 64 * 1024;

export interface ModStorageBackend {
  read(modId: string, key: string): Promise<unknown>;
  write(modId: string, key: string, value: string): Promise<void>;
  remove(modId: string, key: string): Promise<void>;
  keys(modId: string): Promise<string[]>;
  bytes(modId: string): Promise<number>;
}

export interface ModSettingsBackend {
  get<T>(modId: string, key: string): Promise<T | undefined>;
  set<T>(modId: string, key: string, value: T): Promise<void>;
}

export interface ModToolsBackend {
  /**
   * Invoke a Cowork tool on the mod's behalf.
   *
   * The implementation MUST route through `invokeTool()` so the shared gate runs
   * — `modId` is carried for the approval card's attribution ("requested by mod
   * X"). A backend that calls a tool's `execute` directly would let a mod bypass
   * permissions entirely, which is the one thing this API must not do.
   */
  invoke(modId: string, toolName: string, args: Record<string, unknown>): Promise<ModToolResultEnvelope>;
}

export interface ModModelBackend {
  ask(modId: string, prompt: string, options: ModModelAskOptions): Promise<string>;
}

export interface ModUiBackend {
  contribute(modId: string, contribution: ModUiContribution): Promise<void>;
  notify(modId: string, message: string, level: 'info' | 'warn' | 'error'): Promise<void>;
  readValue(modId: string, nodeId: string): Promise<unknown>;
}

export interface ModContextDeps {
  readonly storage?: ModStorageBackend;
  readonly settings?: ModSettingsBackend;
  readonly tools: ModToolsBackend;
  readonly model?: ModModelBackend;
  readonly ui?: ModUiBackend;
  readonly fs?: ModFsHelper;
  readonly log?: ModLog;
  /** Read-only session view. */
  readonly session?: { readonly id: string; readonly projectId?: string; readonly cwd: string; readonly createdAt?: string };
  readonly storageQuotaBytes?: number;
  readonly maxValueBytes?: number;
}

/**
 * Storage keys are opaque identifiers, not paths.
 *
 * Refusing `/`, `\` and whitespace removes an entire class of traversal and
 * collision questions (two keys normalising to the same file, a key escaping the
 * mod's directory). A mod that wants structure stores JSON in the value.
 */
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isValidStorageKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !key.includes('..');
}

function estimateBytes(value: string): number {
  return Buffer.byteLength(value, 'utf-8');
}

/** Size of a stored value once re-serialised, or 0 when absent. */
function bucketSize(stored: unknown): number {
  if (stored === undefined) return 0;
  try {
    return estimateBytes(JSON.stringify(stored) ?? '');
  } catch {
    return 0;
  }
}

class QuotaExceededError extends Error {
  constructor(readonly scope: string) {
    super(`Mod storage quota exceeded (${scope}). Reduce the data this mod stores.`);
    this.name = 'QuotaExceededError';
  }
}

class InvalidKeyError extends Error {
  constructor(readonly key: string) {
    super(`Invalid storage key: ${JSON.stringify(key)}`);
    this.name = 'InvalidKeyError';
  }
}

/**
 * In-memory storage backend. The on-disk implementation belongs to the install
 * layer (phase 4); this exists so the context is exercisable without a store and
 * so quota behaviour is testable in isolation.
 */
export class MemoryModStorage implements ModStorageBackend {
  private readonly data = new Map<string, Map<string, string>>();

  private scope(modId: string): Map<string, string> {
    let bucket = this.data.get(modId);
    if (!bucket) {
      bucket = new Map();
      this.data.set(modId, bucket);
    }
    return bucket;
  }

  async read(modId: string, key: string): Promise<unknown> {
    const raw = this.scope(modId).get(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  async write(modId: string, key: string, value: string): Promise<void> {
    const bucket = this.scope(modId);
    const existing = bucket.get(key);
    const projected = this.bytesOf(bucket) - (existing ? estimateBytes(existing) : 0) + estimateBytes(value);
    if (projected > this.quota) throw new QuotaExceededError('mod total');
    bucket.set(key, value);
  }

  async remove(modId: string, key: string): Promise<void> {
    this.scope(modId).delete(key);
  }

  async keys(modId: string): Promise<string[]> {
    return [...this.scope(modId).keys()];
  }

  async bytes(modId: string): Promise<number> {
    return this.bytesOf(this.scope(modId));
  }

  /** Per-mod total, in bytes. */
  private quota = MOD_STORAGE_QUOTA_BYTES;

  setQuota(bytes: number): void {
    this.quota = bytes;
  }

  private bytesOf(bucket: Map<string, string>): number {
    let total = 0;
    for (const value of bucket.values()) total += estimateBytes(value);
    return total;
  }
}

/** Build the `ctx` a mod receives. */
export function buildModContext(manifest: ModManifest, deps: ModContextDeps): ModContext {
  const modId = manifest.id;
  const quotaBytes = deps.storageQuotaBytes ?? MOD_STORAGE_QUOTA_BYTES;
  const maxValueBytes = deps.maxValueBytes ?? MOD_STORAGE_MAX_VALUE_BYTES;
  const memory = deps.storage ?? new MemoryModStorage();
  const logSink = deps.log ?? silentLog(manifest.name);

  const storage: ModStorage = {
    async get<T>(key: string): Promise<T | undefined> {
      assertKey(key);
      return (await memory.read(modId, key)) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      assertKey(key);
      const serialised = JSON.stringify(value ?? null);
      if (estimateBytes(serialised) > maxValueBytes) {
        throw new QuotaExceededError(`single value > ${maxValueBytes} bytes`);
      }
      // Total quota is checked against the backend's own accounting rather than
      // a counter kept here, so it holds for a persistent store too — a mod's
      // quota must not depend on which backend the host happened to install.
      const before = await memory.bytes(modId);
      const previous = bucketSize(await memory.read(modId, key));
      if (before - previous + estimateBytes(serialised) > quotaBytes) {
        throw new QuotaExceededError(`mod total > ${quotaBytes} bytes`);
      }
      await memory.write(modId, key, serialised);
    },
    async delete(key: string): Promise<void> {
      assertKey(key);
      await memory.remove(modId, key);
    },
    async list(): Promise<string[]> {
      return memory.keys(modId);
    },
    async usage(): Promise<number> {
      return memory.bytes(modId);
    },
  };

  const ui: ModUiApi = {
    async contribute(contribution: ModUiContribution): Promise<void> {
      if (!deps.ui) throw new Error('This mod has no UI channel (ui capability not granted by the host).');
      await deps.ui.contribute(modId, contribution);
    },
    async notify(message, level): Promise<void> {
      if (deps.ui) {
        await deps.ui.notify(modId, message, level ?? 'info');
        return;
      }
      logSink.warn(`[mod notice] ${message}`);
    },
    async readValue(nodeId: string): Promise<unknown> {
      if (!deps.ui) return undefined;
      return deps.ui.readValue(modId, nodeId);
    },
  };

  return {
    modId,
    manifest,
    log: logSink,
    storage,
    settings: {
      async get<T>(key: string): Promise<T | undefined> {
        return deps.settings?.get<T>(modId, key);
      },
      async set<T>(key: string, value: T): Promise<void> {
        await deps.settings?.set(modId, key, value);
      },
    },
    session: deps.session ?? { id: 'unknown', cwd: process.cwd() },
    fs: deps.fs ?? noFs(),
    tools: {
      async invoke(toolName: string, args: Record<string, unknown>): Promise<ModToolResultEnvelope> {
        return deps.tools.invoke(modId, toolName, args);
      },
    },
    model: {
      async ask(prompt: string, options?: ModModelAskOptions): Promise<string> {
        if (!deps.model) throw new Error('This mod has no model channel (model capability not granted by the host).');
        // The host owns the cost ceiling; a mod asking for one is a request, not
        // a guarantee. Never let an absent option mean "no limit".
        return deps.model.ask(modId, prompt, { maxCostUsd: options?.maxCostUsd ?? 0.25, ...options });
      },
    },
    ui,
  };

  function assertKey(key: string): void {
    if (!isValidStorageKey(key)) throw new InvalidKeyError(key);
  }
}

function silentLog(label: string): ModLog {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => log(`[${label}] ${message}`),
    error: (message: string) => log(`[${label}] ${message}`),
  };
}

/**
 * No filesystem without a host-provided helper.
 *
 * Returning a helper that throws beats returning one that silently succeeds:
 * "fs is unavailable" is a state a mod author can handle, whereas a stub that
 * appears to work makes a broken mod look like a working one.
 */
function noFs(): ModFsHelper {
  const refuse = (): never => {
    throw new Error('This mod has no filesystem helper (the host did not provide one).');
  };
  return { readFile: async () => refuse(), listDir: async () => refuse(), exists: async () => refuse() };
}