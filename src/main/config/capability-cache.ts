/**
 * @module main/config/capability-cache
 *
 * 24h on-disk cache for capability/endpoint detection results (Hermes-style:
 * detection stays out of the critical path, disk cache survives restarts).
 *
 * What belongs here: facts that change rarely — "is the `op` CLI installed?",
 * "which Ollama endpoints answered last time?". What does NOT belong here:
 * live state (vault locked/unlocked) or secrets. A stale entry only ever
 * costs an extra background refresh, never a wrong security decision, because
 * every consumer re-validates live before acting on a cached "available".
 *
 * Corrupt or unreadable cache files degrade to "miss", never throw.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';

export const CAPABILITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheFileShape {
  entries?: Record<string, { value?: unknown; cachedAt?: unknown }>;
}

export class CapabilityDiskCache {
  constructor(private readonly dir: string) {}

  private filePath(): string {
    return path.join(this.dir, 'capability-cache.json');
  }

  private readAll(): Record<string, { value: unknown; cachedAt: number }> {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf8');
      const parsed = JSON.parse(raw) as CacheFileShape;
      if (!parsed || typeof parsed !== 'object' || !parsed.entries) return {};
      const out: Record<string, { value: unknown; cachedAt: number }> = {};
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (
          entry &&
          typeof entry === 'object' &&
          typeof entry.cachedAt === 'number' &&
          'value' in entry
        ) {
          out[key] = { value: entry.value, cachedAt: entry.cachedAt };
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  private writeAll(entries: Record<string, { value: unknown; cachedAt: number }>): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.filePath()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries }), 'utf8');
      fs.renameSync(tmp, this.filePath());
    } catch {
      // Cache writes are best-effort; a read-only profile must still boot.
    }
  }

  /** Fresh value or null. A corrupt file, a missing key or an expired TTL all read as miss. */
  get<T>(key: string, maxAgeMs: number = CAPABILITY_CACHE_TTL_MS): T | null {
    try {
      const entry = this.readAll()[key];
      if (!entry) return null;
      if (Date.now() - entry.cachedAt > maxAgeMs) return null;
      return entry.value as T;
    } catch {
      return null;
    }
  }

  /** Last stored value regardless of age — for stale-while-revalidate. */
  getStale<T>(key: string): T | null {
    try {
      const entry = this.readAll()[key];
      if (!entry) return null;
      return entry.value as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    try {
      const entries = this.readAll();
      entries[key] = { value, cachedAt: Date.now() };
      this.writeAll(entries);
    } catch {
      // Best-effort, see writeAll.
    }
  }

  clear(): void {
    try {
      fs.unlinkSync(this.filePath());
    } catch {
      // Missing file is already "cleared".
    }
  }
}

let sharedCache: CapabilityDiskCache | null = null;

/**
 * Process-wide cache rooted at `<userData>/capability-cache/`. Falls back to a
 * throwaway tmp dir when Electron is unavailable (tests, scripts) so callers
 * never branch on environment.
 */
export function getCapabilityCache(): CapabilityDiskCache {
  if (sharedCache) return sharedCache;
  let dir = path.join(os.tmpdir(), 'open-cowork-capability-cache-fallback');
  try {
    // Outside the Electron runtime `app` is the binary path string, so the
    // optional call below simply yields nothing and we keep the fallback.
    const root =
      typeof app === 'object' && app !== null && typeof app.getPath === 'function'
        ? app.getPath('userData')
        : '';
    if (root) dir = path.join(root, 'capability-cache');
  } catch {
    // Keep the tmp fallback.
  }
  sharedCache = new CapabilityDiskCache(dir);
  return sharedCache;
}

/** Test hook: forget the singleton so tests can rebind it. */
export function __resetCapabilityCacheForTest(): void {
  sharedCache = null;
}
