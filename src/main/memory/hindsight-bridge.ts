/**
 * @module main/memory/hindsight-bridge
 *
 * Robust, persistent bridge for Hindsight Long-Term Memory integration in Cowork.
 * Provides:
 * - Deterministic per-workspace Bank ID derivation
 * - Local persistent SQLite & in-memory caching for knowledge pages
 * - Graceful degradation on network timeout or unreachable server
 * - Mandatory secret redaction before remote retention
 * - Timeout protection on all network calls
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { redactSecrets } from '../utils/secret-redaction';
import { logWarn } from '../utils/logger';

export interface KnowledgePage {
  id: string;
  title: string;
  content: string;
  tags?: string[];
  updatedAt: number;
}

export interface HindsightSyncStatus {
  synced: boolean;
  bankId: string;
  cachedPagesCount: number;
  lastSyncAt: number | null;
  serverReachable: boolean;
}

export interface HindsightBridgeOptions {
  db?: Database.Database;
  serverUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Derives a deterministic bank ID for a given workspace path.
 * Follows the Hindsight convention: `coding-agent::<repo_name>`
 */
export function deriveBankId(workspaceDir: string): string {
  try {
    const resolved = path.resolve(workspaceDir);
    // If inside a git repository, try to read the repo root directory name
    const gitDir = path.join(resolved, '.git');
    if (fs.existsSync(gitDir)) {
      const baseName = path.basename(resolved);
      return `coding-agent::${sanitizeBankKey(baseName)}`;
    }

    // Check parent directories for .git
    let current = path.dirname(resolved);
    while (current && current !== path.dirname(current)) {
      if (fs.existsSync(path.join(current, '.git'))) {
        return `coding-agent::${sanitizeBankKey(path.basename(current))}`;
      }
      current = path.dirname(current);
    }

    // Fallback: directory basename + short hash of full path
    const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
    return `workspace::${sanitizeBankKey(path.basename(resolved))}-${hash}`;
  } catch {
    return 'coding-agent::default';
  }
}

function sanitizeBankKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

/**
 * Execute a promise with a hard timeout cap.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[HindsightBridge] Operation '${operationName}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class HindsightBridge {
  private db?: Database.Database;
  private serverUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private inMemoryCache: Map<string, KnowledgePage[]> = new Map();
  private lastSyncTimes: Map<string, number> = new Map();

  constructor(options: HindsightBridgeOptions = {}) {
    this.db = options.db;
    this.serverUrl = (options.serverUrl || process.env.HINDSIGHT_API_URL || 'http://localhost:8888').replace(/\/$/, '');
    this.apiKey = options.apiKey || process.env.HINDSIGHT_API_KEY || '';
    this.timeoutMs = options.timeoutMs || 4000;

    this.ensureTables();
  }

  private ensureTables(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS hindsight_knowledge_cache (
          id TEXT PRIMARY KEY,
          bank_id TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          tags TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_hindsight_bank ON hindsight_knowledge_cache(bank_id);
      `);
    } catch (err) {
      logWarn('[HindsightBridge] Failed to initialize SQLite cache table, using memory cache:', err);
    }
  }

  /**
   * Cache a knowledge page locally in SQLite and memory.
   */
  public cacheKnowledgePage(bankId: string, page: KnowledgePage): void {
    // 1. Update in-memory cache
    const existing = this.inMemoryCache.get(bankId) || [];
    const index = existing.findIndex((p) => p.id === page.id);
    if (index >= 0) {
      existing[index] = page;
    } else {
      existing.push(page);
    }
    this.inMemoryCache.set(bankId, existing);

    // 2. Persist to SQLite if DB available
    if (this.db) {
      try {
        const stmt = this.db.prepare(`
          INSERT INTO hindsight_knowledge_cache (id, bank_id, title, content, tags, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            content = excluded.content,
            tags = excluded.tags,
            updated_at = excluded.updated_at
        `);
        stmt.run(
          page.id,
          bankId,
          page.title,
          page.content,
          page.tags ? JSON.stringify(page.tags) : null,
          page.updatedAt
        );
      } catch (err) {
        logWarn('[HindsightBridge] SQLite cache write error:', err);
      }
    }
  }

  /**
   * Retrieve cached knowledge pages for a given bank.
   */
  public getCachedKnowledgePages(bankId: string): KnowledgePage[] {
    // Check SQLite first
    if (this.db) {
      try {
        const rows = this.db
          .prepare('SELECT id, bank_id, title, content, tags, updated_at FROM hindsight_knowledge_cache WHERE bank_id = ? ORDER BY updated_at DESC')
          .all(bankId) as Array<{
          id: string;
          bank_id: string;
          title: string;
          content: string;
          tags: string | null;
          updated_at: number;
        }>;

        if (rows.length > 0) {
          return rows.map((r) => ({
            id: r.id,
            title: r.title,
            content: r.content,
            tags: r.tags ? JSON.parse(r.tags) : [],
            updatedAt: r.updated_at,
          }));
        }
      } catch (err) {
        logWarn('[HindsightBridge] SQLite cache read error:', err);
      }
    }

    // Fall back to in-memory cache
    return this.inMemoryCache.get(bankId) || [];
  }

  /**
   * Search knowledge pages with fallback to local persistent cache.
   */
  public async searchKnowledgePages(workspaceDir: string, query: string): Promise<KnowledgePage[]> {
    const bankId = deriveBankId(workspaceDir);
    const cached = this.getCachedKnowledgePages(bankId);

    // If no API key or remote server disabled, return local matching pages
    if (!this.apiKey && this.serverUrl === 'http://localhost:8888') {
      return this.filterLocalPages(cached, query);
    }

    try {
      const sanitizedQuery = encodeURIComponent(query.trim());
      const response = await withTimeout(
        fetch(`${this.serverUrl}/v1/banks/${encodeURIComponent(bankId)}/pages?query=${sanitizedQuery}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        }),
        this.timeoutMs,
        'searchKnowledgePages'
      );

      if (!response.ok) {
        logWarn(`[HindsightBridge] Server responded with HTTP ${response.status}, using cached pages`);
        return this.filterLocalPages(cached, query);
      }

      const data = (await response.json()) as { pages?: KnowledgePage[] };
      const pages = data.pages || [];
      for (const page of pages) {
        this.cacheKnowledgePage(bankId, page);
      }
      this.lastSyncTimes.set(bankId, Date.now());
      return pages;
    } catch (error) {
      logWarn('[HindsightBridge] searchKnowledgePages failed, degrading gracefully to cache:', error);
      return this.filterLocalPages(cached, query);
    }
  }

  /**
   * Retain a memory or document into the workspace's bank.
   * Redacts secrets before any remote transmission.
   */
  public async retain(
    workspaceDir: string,
    doc: { title: string; content: string; tags?: string[] }
  ): Promise<boolean> {
    const bankId = deriveBankId(workspaceDir);
    const redactedContent = redactSecrets(doc.content);
    const redactedTitle = redactSecrets(doc.title);

    // Save locally as knowledge page cache
    const pageId = `local-${createHash('sha256').update(redactedTitle).digest('hex').slice(0, 12)}`;
    this.cacheKnowledgePage(bankId, {
      id: pageId,
      title: redactedTitle,
      content: redactedContent,
      tags: doc.tags,
      updatedAt: Date.now(),
    });

    if (!this.apiKey) {
      return true; // Retained locally
    }

    try {
      const response = await withTimeout(
        fetch(`${this.serverUrl}/v1/banks/${encodeURIComponent(bankId)}/documents`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: redactedTitle,
            content: redactedContent,
            tags: doc.tags || [],
          }),
        }),
        this.timeoutMs,
        'retain'
      );

      if (response.ok) {
        this.lastSyncTimes.set(bankId, Date.now());
        return true;
      }
      logWarn(`[HindsightBridge] Retain failed with HTTP ${response.status}`);
      return false;
    } catch (err) {
      logWarn('[HindsightBridge] Retain network error, stored in local cache only:', err);
      return false;
    }
  }

  /**
   * Recall observations relevant to a query.
   */
  public async recall(workspaceDir: string, query: string): Promise<string[]> {
    const bankId = deriveBankId(workspaceDir);
    if (!this.apiKey) {
      // Return extracts from local knowledge pages
      const pages = this.filterLocalPages(this.getCachedKnowledgePages(bankId), query);
      return pages.map((p) => `[${p.title}] ${p.content.slice(0, 300)}...`);
    }

    try {
      const response = await withTimeout(
        fetch(`${this.serverUrl}/v1/banks/${encodeURIComponent(bankId)}/recall`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query }),
        }),
        this.timeoutMs,
        'recall'
      );

      if (!response.ok) return [];
      const data = (await response.json()) as { observations?: string[] };
      return data.observations || [];
    } catch (err) {
      logWarn('[HindsightBridge] Recall network failure:', err);
      const pages = this.filterLocalPages(this.getCachedKnowledgePages(bankId), query);
      return pages.map((p) => `[${p.title}] ${p.content.slice(0, 300)}...`);
    }
  }

  /**
   * Get sync status for the current workspace.
   */
  public async getSyncStatus(workspaceDir: string): Promise<HindsightSyncStatus> {
    const bankId = deriveBankId(workspaceDir);
    const cachedPages = this.getCachedKnowledgePages(bankId);
    let serverReachable = false;

    if (this.apiKey) {
      try {
        const res = await withTimeout(
          fetch(`${this.serverUrl}/health`, { method: 'GET' }),
          1500,
          'health'
        );
        serverReachable = res.ok;
      } catch {
        serverReachable = false;
      }
    }

    return {
      synced: true,
      bankId,
      cachedPagesCount: cachedPages.length,
      lastSyncAt: this.lastSyncTimes.get(bankId) || null,
      serverReachable,
    };
  }

  private filterLocalPages(pages: KnowledgePage[], query: string): KnowledgePage[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return pages;

    return pages.filter((page) => {
      const text = `${page.title} ${page.content} ${(page.tags || []).join(' ')}`.toLowerCase();
      return terms.some((term) => text.includes(term));
    });
  }
}
