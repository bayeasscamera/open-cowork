import type Database from 'better-sqlite3';
import type { Message, MemoryEntry, ContentBlock } from '../../shared/types';
import { v4 as uuidv4 } from 'uuid';
import { logError, logWarn } from '../utils/logger';
import type { MemoryLLMClientLike } from './memory-llm-client';

interface ContextStrategy {
  type: 'full' | 'compressed' | 'rolling';
  messages: Message[];
  summary?: string;
}

/** A recorded error pattern to avoid repeating the same mistakes */
export interface ErrorPattern {
  id: string;
  pattern: string;       // What went wrong (normalized)
  rootCause: string;     // Why it happened
  fix: string;           // How it was resolved
  context: string;       // In what situation (tool, file, operation)
  occurrences: number;   // Times seen
  lastSeenAt: number;
  createdAt: number;
}

/** User preference and dialectic knowledge entry (Honcho / Hermes-inspired) */
export interface UserPreference {
  id: string;
  key: string;           // Normalized preference key, e.g. "lang", "workflow", "coding_style"
  value: string;         // Observation or preference details
  confidence: number;    // 0.0 - 1.0 confidence score
  updatedAt: number;
  createdAt: number;
}

/**
 * MemoryManager - Handles message history, intelligent context management,
 * and causal error-pattern learning for self-improvement.
 *
 * Three main functions:
 * 1. Message storage and retrieval
 * 2. Intelligent context compression via real LLM calls
 * 3. Error-pattern memory: learn from failures, avoid repetition
 */
export class MemoryManager {
  private db: Database.Database;
  private maxContextTokens: number;
  private llmClient?: MemoryLLMClientLike;

  constructor(
    db: Database.Database,
    maxContextTokens = 180000,
    llmClient?: MemoryLLMClientLike
  ) {
    this.db = db;
    this.maxContextTokens = maxContextTokens;
    this.llmClient = llmClient;
    this.ensureErrorPatternTable();
  }

  /** Ensure the error_patterns table exists (idempotent) */
  private ensureErrorPatternTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS error_patterns (
          id TEXT PRIMARY KEY,
          pattern TEXT NOT NULL,
          root_cause TEXT NOT NULL,
          fix TEXT NOT NULL,
          context TEXT NOT NULL DEFAULT '',
          occurrences INTEGER NOT NULL DEFAULT 1,
          last_seen_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_error_patterns_pattern
          ON error_patterns(pattern);

        CREATE TABLE IF NOT EXISTS user_preferences (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL UNIQUE,
          value TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          updated_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_preferences_key
          ON user_preferences(key);
      `);
    } catch (error) {
      logError('[MemoryManager] Failed to create error_patterns / user_preferences tables:', error);
    }
  }

  /** Record or update a dialectic user preference / habit observation */
  recordUserPreference(key: string, value: string, confidence = 1.0): void {
    try {
      const now = Date.now();
      const existing = this.db
        .prepare('SELECT id FROM user_preferences WHERE key = ?')
        .get(key) as { id: string } | undefined;

      if (existing) {
        this.db
          .prepare(
            'UPDATE user_preferences SET value = ?, confidence = ?, updated_at = ? WHERE key = ?'
          )
          .run(value, confidence, now, key);
      } else {
        this.db
          .prepare(
            'INSERT INTO user_preferences (id, key, value, confidence, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(uuidv4(), key, value, confidence, now, now);
      }
    } catch (error) {
      logError('[MemoryManager] Failed to record user preference:', error);
    }
  }

  /** Retrieve all persisted user preferences */
  getAllUserPreferences(): UserPreference[] {
    try {
      const rows = this.db
        .prepare('SELECT * FROM user_preferences ORDER BY updated_at DESC')
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        id: r.id as string,
        key: r.key as string,
        value: r.value as string,
        confidence: Number(r.confidence || 1.0),
        updatedAt: r.updated_at as number,
        createdAt: r.created_at as number,
      }));
    } catch {
      return [];
    }
  }

  /** Format user preferences into a system prompt section */
  formatUserPreferencesForContext(): string {
    const prefs = this.getAllUserPreferences();
    if (prefs.length === 0) return '';
    const lines = prefs.map((p) => `- ${p.key}: ${p.value}`);
    return `\n\n<user_preferences>\nLearned habits, preferences, and workflows for this user:\n${lines.join('\n')}\n</user_preferences>`;
  }

  /**
   * Save a message to the database
   */
  saveMessage(sessionId: string, message: Message): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp, token_usage)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        message.id,
        sessionId,
        message.role,
        JSON.stringify(message.content),
        message.timestamp,
        message.tokenUsage ? JSON.stringify(message.tokenUsage) : null
      );
    } catch (error) {
      logError('[MemoryManager] Error saving message:', error);
    }
  }

  /**
   * Get message history for a session
   */
  getMessageHistory(sessionId: string, limit?: number): Message[] {
    let query = 'SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC';
    const params: (string | number)[] = [sessionId];
    if (limit) {
      query += ' LIMIT ?';
      params.push(limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Record<string, unknown>[];

    return rows.map((row) => {
      let content: ContentBlock[];
      try {
        content = JSON.parse(row.content as string) as ContentBlock[];
      } catch {
        content = [{ type: 'text', text: row.content as string } as ContentBlock];
      }

      let tokenUsage;
      try {
        tokenUsage = row.token_usage ? JSON.parse(row.token_usage as string) : undefined;
      } catch {
        tokenUsage = undefined;
      }

      return {
        id: row.id as string,
        sessionId: row.session_id as string,
        role: row.role as Message['role'],
        content,
        timestamp: row.timestamp as number,
        tokenUsage,
      };
    });
  }

  /**
   * Search messages using full-text search
   */
  searchMessages(sessionId: string, query: string): Message[] {
    // First get all messages for the session
    const messages = this.getMessageHistory(sessionId);

    // Simple text search (FTS5 would be more efficient for large datasets)
    const queryLower = query.toLowerCase();

    return messages.filter((message) => {
      return message.content.some((block) => {
        if (block.type === 'text') {
          return block.text.toLowerCase().includes(queryLower);
        }
        return false;
      });
    });
  }

  /**
   * Manage context for a session - determine best strategy based on token usage
   */
  manageContext(sessionId: string): ContextStrategy {
    const messages = this.getMessageHistory(sessionId);
    const tokenCount = this.estimateTokens(messages);

    // If within limits, return full context
    if (tokenCount < this.maxContextTokens * 0.9) {
      return {
        type: 'full',
        messages,
      };
    }

    // If approaching limit, compress
    return this.compressContext(messages);
  }

  /**
   * Compress context by summarizing older messages
   */
  compressContext(messages: Message[]): ContextStrategy {
    const recentCount = 20; // Keep last 20 messages

    if (messages.length <= recentCount) {
      return {
        type: 'full',
        messages,
      };
    }

    const recent = messages.slice(-recentCount);
    const older = messages.slice(0, -recentCount);

    // Generate summary of older messages (sync fallback; use compressContextAsync for LLM quality)
    const summary = this.generateSummaryFallback(older);

    return {
      type: 'compressed',
      messages: recent,
      summary,
    };
  }

  /**
   * Get relevant context based on current prompt (for retrieval)
   */
  getRelevantContext(sessionId: string, currentPrompt: string): Message[] {
    const messages = this.getMessageHistory(sessionId);

    // Simple relevance scoring based on keyword overlap
    const promptWords = new Set(
      currentPrompt
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3)
    );

    const scoredMessages = messages.map((message) => {
      let score = 0;

      for (const block of message.content) {
        if (block.type === 'text') {
          const messageWords = block.text.toLowerCase().split(/\s+/);
          for (const word of messageWords) {
            if (promptWords.has(word)) {
              score++;
            }
          }
        }
      }

      return { message, score };
    });

    // Return messages sorted by relevance, limited to top 10
    return scoredMessages
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(({ message }) => message);
  }

  /**
   * Estimate token count for messages (rough approximation)
   */
  private estimateTokens(messages: Message[]): number {
    let charCount = 0;

    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'text') {
          charCount += block.text.length;
        } else if (block.type === 'tool_use') {
          charCount += JSON.stringify(block.input).length;
        } else if (block.type === 'tool_result') {
          charCount += block.content.length;
        }
      }
    }

    // Rough estimate: 1 token ≈ 4 characters for English
    return Math.ceil(charCount / 4);
  }

  /**
   * Generate an intelligent summary of messages using the LLM.
   * Falls back to keyword extraction if no LLM client is available.
   */
  private async generateSummaryAsync(messages: Message[]): Promise<string> {
    if (!this.llmClient) {
      return this.generateSummaryFallback(messages);
    }

    try {
      const transcript = messages
        .map((m) => {
          const text = m.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { type: 'text'; text: string }).text)
            .join('\n');
          return `[${m.role.toUpperCase()}]: ${text}`;
        })
        .join('\n\n');

      const result = await this.llmClient.complete({
        systemPrompt: `You are a concise conversation summarizer. 
Produce a dense, factual summary (3-5 sentences max) of the conversation below.
Focus on: decisions made, problems solved, key facts established, and any open issues.
Do NOT include greetings or meta-commentary.`,
        userPrompt: `Summarize this conversation:\n\n${transcript.slice(0, 12000)}`,
        temperature: 0,
        maxTokens: 512,
      });

      return result.text.trim() || this.generateSummaryFallback(messages);
    } catch (error) {
      logWarn('[MemoryManager] LLM summary failed, using fallback:', error);
      return this.generateSummaryFallback(messages);
    }
  }

  /**
   * Keyword-based fallback summary (no LLM required).
   */
  private generateSummaryFallback(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === 'user');
    const topicSet = new Set<string>();

    for (const message of userMessages) {
      for (const block of message.content) {
        if (block.type === 'text') {
          const words = block.text.split(/\s+/).filter((w) => w.length > 5);
          words.slice(0, 3).forEach((w) => topicSet.add(w.toLowerCase()));
        }
      }
    }

    const topics = Array.from(topicSet).slice(0, 5).join(', ');
    return (
      `Previous conversation covered topics including: ${topics}. ` +
      `The conversation had ${messages.length} messages.`
    );
  }

  /**
   * Compress context using real LLM summary (async version).
   */
  async compressContextAsync(messages: Message[]): Promise<ContextStrategy> {
    const recentCount = 20;

    if (messages.length <= recentCount) {
      return { type: 'full', messages };
    }

    const recent = messages.slice(-recentCount);
    const older = messages.slice(0, -recentCount);
    const summary = await this.generateSummaryAsync(older);

    return { type: 'compressed', messages: recent, summary };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CAUSAL ERROR-PATTERN MEMORY
  // Learn from failures to avoid repeating the same mistakes across sessions.
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Record an error pattern. If a similar pattern already exists, increment
   * its occurrence count rather than creating a duplicate.
   */
  recordErrorPattern(
    pattern: string,
    rootCause: string,
    fix: string,
    context = ''
  ): ErrorPattern {
    const normalizedPattern = pattern.toLowerCase().trim().slice(0, 500);
    const now = Date.now();

    // Check for an existing similar pattern (exact normalized match)
    const existing = this.db
      .prepare('SELECT * FROM error_patterns WHERE pattern = ? LIMIT 1')
      .get(normalizedPattern) as Record<string, unknown> | undefined;

    if (existing) {
      this.db
        .prepare(
          'UPDATE error_patterns SET occurrences = occurrences + 1, last_seen_at = ?, root_cause = ?, fix = ? WHERE id = ?'
        )
        .run(now, rootCause, fix, existing.id as string);
      return this.rowToErrorPattern({ ...existing, occurrences: (existing.occurrences as number) + 1, last_seen_at: now });
    }

    const id = uuidv4();
    this.db
      .prepare(
        'INSERT INTO error_patterns (id, pattern, root_cause, fix, context, occurrences, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
      )
      .run(id, normalizedPattern, rootCause, fix, context, now, now);

    return { id, pattern: normalizedPattern, rootCause, fix, context, occurrences: 1, lastSeenAt: now, createdAt: now };
  }

  /**
   * Find error patterns similar to a given query (keyword overlap).
   * Returns the top matches sorted by relevance × recency.
   */
  getSimilarErrorPatterns(query: string, limit = 5): ErrorPattern[] {
    const queryWords = new Set(
      query.toLowerCase().split(/\s+/).filter((w) => w.length > 3)
    );

    const rows = this.db
      .prepare('SELECT * FROM error_patterns ORDER BY last_seen_at DESC LIMIT 100')
      .all() as Record<string, unknown>[];

    const scored = rows.map((row) => {
      const patternWords = (row.pattern as string).split(/\s+/);
      const score = patternWords.filter((w) => queryWords.has(w)).length;
      return { row, score };
    });

    return scored
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row }) => this.rowToErrorPattern(row));
  }

  /**
   * Format known error patterns as a context block to inject into the agent prompt,
   * so it avoids repeating past mistakes.
   */
  formatErrorPatternsForContext(query: string): string {
    const patterns = this.getSimilarErrorPatterns(query);
    if (patterns.length === 0) return '';

    const lines = patterns.map(
      (p, i) =>
        `${i + 1}. PATTERN: ${p.pattern}\n   ROOT CAUSE: ${p.rootCause}\n   FIX: ${p.fix}${p.context ? `\n   CONTEXT: ${p.context}` : ''}\n   (seen ${p.occurrences}x)`
    );

    return `\n\n<known_error_patterns>\nAvoid these previously encountered failure patterns:\n${lines.join('\n\n')}\n</known_error_patterns>`;
  }

  /** Get all recorded error patterns */
  getAllErrorPatterns(): ErrorPattern[] {
    const rows = this.db
      .prepare('SELECT * FROM error_patterns ORDER BY occurrences DESC, last_seen_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToErrorPattern(r));
  }

  /** Delete an error pattern by id */
  deleteErrorPattern(id: string): void {
    this.db.prepare('DELETE FROM error_patterns WHERE id = ?').run(id);
  }

  private rowToErrorPattern(row: Record<string, unknown>): ErrorPattern {
    return {
      id: row.id as string,
      pattern: row.pattern as string,
      rootCause: row.root_cause as string,
      fix: row.fix as string,
      context: (row.context as string) || '',
      occurrences: row.occurrences as number,
      lastSeenAt: row.last_seen_at as number,
      createdAt: row.created_at as number,
    };
  }

  /**
   * Save a memory entry (for explicit memory storage)
   */
  saveMemoryEntry(
    sessionId: string,
    content: string,
    metadata: { source: string; tags: string[] }
  ): MemoryEntry {
    const entry: MemoryEntry = {
      id: uuidv4(),
      sessionId,
      content,
      metadata: {
        ...metadata,
        timestamp: Date.now(),
      },
      createdAt: Date.now(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO memory_entries (id, session_id, content, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.sessionId,
      entry.content,
      JSON.stringify(entry.metadata),
      entry.createdAt
    );

    return entry;
  }

  /**
   * Search memory entries using LIKE-based text search
   */
  searchMemory(sessionId: string, query: string): MemoryEntry[] {
    const escapedQuery = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const stmt = this.db.prepare(`
      SELECT * FROM memory_entries
      WHERE session_id = ? AND content LIKE ? ESCAPE '\\'
      ORDER BY created_at DESC
      LIMIT 20
    `);

    const rows = stmt.all(sessionId, `%${escapedQuery}%`) as Record<string, unknown>[];

    return rows.map((row) => {
      let metadata;
      try {
        metadata = JSON.parse(row.metadata as string);
      } catch {
        metadata = row.metadata;
      }

      return {
        id: row.id as string,
        sessionId: row.session_id as string,
        content: row.content as string,
        metadata,
        createdAt: row.created_at as number,
      };
    });
  }

  /**
   * Delete messages for a session
   */
  deleteSessionMessages(sessionId: string): void {
    try {
      const stmt = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
      stmt.run(sessionId);
    } catch (error) {
      logError('[MemoryManager] Error deleting session messages:', error);
    }
  }

  /**
   * Delete memory entries for a session
   */
  deleteSessionMemory(sessionId: string): void {
    try {
      const stmt = this.db.prepare('DELETE FROM memory_entries WHERE session_id = ?');
      stmt.run(sessionId);
    } catch (error) {
      logError('[MemoryManager] Error deleting session memory:', error);
    }
  }
}
