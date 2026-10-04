import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { deriveBankId, HindsightBridge } from '../src/main/memory/hindsight-bridge';

describe('HindsightBridge', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('derives deterministic bank IDs', () => {
    const bank1 = deriveBankId('/path/to/my-repo');
    expect(bank1).toMatch(/^(coding-agent::|workspace::)/);

    const bank2 = deriveBankId('/path/to/my-repo');
    expect(bank1).toBe(bank2); // Deterministic
  });

  it('initializes SQLite cache table and caches knowledge pages', () => {
    const bridge = new HindsightBridge({ db });
    const bankId = 'coding-agent::test-project';

    bridge.cacheKnowledgePage(bankId, {
      id: 'page-1',
      title: 'Architecture Overview',
      content: 'System uses Electron and SQLite.',
      tags: ['arch', 'db'],
      updatedAt: 1000,
    });

    const cached = bridge.getCachedKnowledgePages(bankId);
    expect(cached).toHaveLength(1);
    expect(cached[0].title).toBe('Architecture Overview');
    expect(cached[0].tags).toEqual(['arch', 'db']);
  });

  it('updates existing cached page on conflict', () => {
    const bridge = new HindsightBridge({ db });
    const bankId = 'coding-agent::test-project';

    bridge.cacheKnowledgePage(bankId, {
      id: 'page-1',
      title: 'Architecture v1',
      content: 'Initial version.',
      updatedAt: 1000,
    });

    bridge.cacheKnowledgePage(bankId, {
      id: 'page-1',
      title: 'Architecture v2',
      content: 'Updated version.',
      updatedAt: 2000,
    });

    const cached = bridge.getCachedKnowledgePages(bankId);
    expect(cached).toHaveLength(1);
    expect(cached[0].title).toBe('Architecture v2');
    expect(cached[0].content).toBe('Updated version.');
  });

  it('redacts secrets when retaining documents', async () => {
    const bridge = new HindsightBridge({ db });
    const secretApiKey = 'sk-ant-api03-abcdef1234567890abcdef1234567890';
    const secretGitHubToken = 'ghp_123456789012345678901234567890123456';

    const success = await bridge.retain('/test/workspace', {
      title: `Config with ${secretApiKey}`,
      content: `Use token: ${secretGitHubToken} for access`,
    });

    expect(success).toBe(true);

    const bankId = deriveBankId('/test/workspace');
    const cached = bridge.getCachedKnowledgePages(bankId);
    expect(cached).toHaveLength(1);
    expect(cached[0].title).toContain('[REDACTED-KEY]');
    expect(cached[0].title).not.toContain(secretApiKey);
    expect(cached[0].content).toContain('[REDACTED-TOKEN]');
    expect(cached[0].content).not.toContain(secretGitHubToken);
  });

  it('searches cached knowledge pages offline without throwing', async () => {
    const bridge = new HindsightBridge({ db });
    const bankId = deriveBankId('/test/offline');

    bridge.cacheKnowledgePage(bankId, {
      id: 'page-offline',
      title: 'Navigation Guidelines',
      content: 'Always use keyboard shortcuts.',
      updatedAt: Date.now(),
    });

    const results = await bridge.searchKnowledgePages('/test/offline', 'navigation');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Navigation Guidelines');

    const empty = await bridge.searchKnowledgePages('/test/offline', 'nonexistent');
    expect(empty).toHaveLength(0);
  });

  it('returns sync status gracefully', async () => {
    const bridge = new HindsightBridge({ db });
    const status = await bridge.getSyncStatus('/test/status');

    expect(status.synced).toBe(true);
    expect(status.bankId).toBeDefined();
    expect(status.cachedPagesCount).toBe(0);
    expect(status.serverReachable).toBe(false); // No API key configured
  });
});
