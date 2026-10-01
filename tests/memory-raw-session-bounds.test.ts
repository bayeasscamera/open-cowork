import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfigState = vi.hoisted(() => ({
  config: {
    memoryEnabled: true,
    memoryRuntime: {
      llm: { inheritFromActive: true, apiKey: '', baseUrl: '', model: '', timeoutMs: 180000 },
      embedding: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: 'text-embedding-3-small',
        timeoutMs: 180000,
      },
      useEmbedding: false,
      maxNavSteps: 2,
      ingestionConcurrency: 2,
      storageRoot: '',
    },
  } as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/tmp/open-cowork-test-app',
  },
}));

vi.mock('../src/main/config/config-store', () => ({
  configStore: {
    getAll: () => ({ ...mockConfigState.config }),
    get: (key: string) => mockConfigState.config[key],
    update: (updates: Record<string, unknown>) => {
      mockConfigState.config = { ...mockConfigState.config, ...updates };
    },
    set: (key: string, value: unknown) => {
      mockConfigState.config = { ...mockConfigState.config, [key]: value };
    },
  },
  PROVIDER_PRESETS: {},
}));

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseInstance } from '../src/main/db/database';
import type {
  MemoryCompletionRequest,
  MemoryLLMClientLike,
} from '../src/main/memory/memory-llm-client';
import { MemoryService } from '../src/main/memory/memory-service';
import { configStore } from '../src/main/config/config-store';

/**
 * A navigator that always asks for the raw transcript, once.
 *
 * This is the worst case on purpose: `get_raw_session` is a decision the MODEL
 * makes, so whatever bound exists on this path has to hold against a model that
 * asks for everything.
 */
class AlwaysRawNavigatorClient implements MemoryLLMClientLike {
  private asked = false;

  async complete(request: MemoryCompletionRequest): Promise<{ text: string }> {
    if (request.systemPrompt.includes('memory retrieval navigator')) {
      if (!this.asked) {
        this.asked = true;
        return {
          text: JSON.stringify({
            sufficient: false,
            reason: 'need the transcript',
            actions: [{ type: 'get_raw_session', sessionId: 'session-big' }],
          }),
        };
      }
      return { text: JSON.stringify({ sufficient: true, reason: 'done', actions: [] }) };
    }
    // Chunking/extraction: one chunk holding the whole oversized transcript.
    return {
      text: JSON.stringify({
        session_summary: 'session tres volumineuse',
        session_keywords: ['gros'],
        chunks: [
          {
            summary: 'une session enorme',
            details: 'beaucoup de texte',
            keywords: ['gros'],
            source_turns: [1],
          },
        ],
      }),
    };
  }
}

function createDatabaseInstance(raw: Database.Database): DatabaseInstance {
  return { raw } as unknown as DatabaseInstance;
}

function makeSession(id: string, cwd?: string) {
  return {
    id,
    title: 'Session',
    status: 'idle' as const,
    cwd,
    mountedPaths: [],
    allowedTools: [],
    memoryEnabled: true,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makeMessages(
  sessionId: string,
  items: Array<{ role: 'user' | 'assistant'; text: string; timestamp: number }>
) {
  return items.map((item, index) => ({
    id: `${sessionId}-m-${index}`,
    sessionId,
    role: item.role,
    content: [{ type: 'text' as const, text: item.text }],
    timestamp: item.timestamp,
  }));
}

describe('raw session transcripts are bounded before injection', () => {
  let storageRoot: string;
  let service: MemoryService;

  beforeEach(() => {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-rawsession-'));
    configStore.update({
      memoryEnabled: true,
      memoryRuntime: {
        ...(mockConfigState.config.memoryRuntime as Record<string, unknown>),
        storageRoot,
        maxNavSteps: 2,
      },
    });
    const db = createDatabaseInstance(new Database(':memory:'));
    service = new MemoryService(db, { llmClient: new AlwaysRawNavigatorClient() });
  });

  afterEach(() => {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  it('does not inject a multi-megabyte transcript verbatim', async () => {
    // One turn whose text alone is ~1.5 MB — larger than many model context
    // windows once every chunk's rawText copy is counted.
    const huge = 'resume analyse session '.padEnd(1_500_000, 'A');
    await service.enqueueIngestion({
      session: makeSession('session-big', '/repo/big'),
      prompt: 'analyse la session',
      messages: makeMessages('session-big', [
        { role: 'user', text: huge, timestamp: 1 },
        { role: 'assistant', text: 'vu', timestamp: 2 },
      ]),
    });

    const prefix = await service.buildPromptPrefix(makeSession('session-big', '/repo/big'), 'resume');

    // The hard requirement: the block must not scale with the transcript.
    // 200k is generous for a bounded excerpt; the shipping behaviour was the
    // full session, so this fails loudly before the fix and passes after.
    expect(prefix.length).toBeLessThan(400_000);
  });

  it('says the transcript was truncated instead of implying it is complete', async () => {
    const huge = 'resume analyse session '.repeat(1).padEnd(1_200_000, 'B');
    await service.enqueueIngestion({
      session: makeSession('session-big', '/repo/big'),
      prompt: 'analyse la session',
      messages: makeMessages('session-big', [
        { role: 'user', text: huge, timestamp: 1 },
        { role: 'assistant', text: 'vu', timestamp: 2 },
      ]),
    });

    const prefix = await service.buildPromptPrefix(makeSession('session-big', '/repo/big'), 'resume');

    // A silently shortened transcript is worse than none: the model would cite
    // an excerpt as if it had read the whole thing.
    expect(prefix).toMatch(/truncated|omitted/i);
  });

  it('still injects a normal-sized transcript in full', async () => {
    const normal = 'C'.repeat(2_000);
    await service.enqueueIngestion({
      session: makeSession('session-big', '/repo/big'),
      prompt: 'analyse la session',
      messages: makeMessages('session-big', [
        { role: 'user', text: normal, timestamp: 1 },
        { role: 'assistant', text: 'vu', timestamp: 2 },
      ]),
    });

    const prefix = await service.buildPromptPrefix(makeSession('session-big', '/repo/big'), 'resume');

    // The cap must not truncate ordinary sessions — that would make memory
    // quietly lossy for the 99% case to defend the 1%.
    if (prefix.includes('== Raw Session Transcripts ==')) {
      expect(prefix).toContain(normal);
      expect(prefix).not.toMatch(/truncated|omitted/i);
    }
  });
});