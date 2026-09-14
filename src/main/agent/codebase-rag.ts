/**
 * @module main/agent/codebase-rag
 *
 * Pilier 2 — RAG Code Search (Retrieval-Augmented Generation for the codebase)
 *
 * Indexes all TypeScript/JavaScript source files into embedding vectors using
 * the existing MemoryLLMClient embed() API. Exposes a semantic search tool
 * `search_codebase(query)` that returns the top-k most relevant code snippets
 * so the agent can discover existing patterns before writing new code.
 */

import * as fs from 'fs';
import * as path from 'path';
import { log, logError } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  embedding?: number[];
}

export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Split a file into overlapping chunks of ~40 lines */
function chunkFile(filePath: string, chunkSize = 40, overlap = 8): CodeChunk[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const chunks: CodeChunk[] = [];
    for (let start = 0; start < lines.length; start += chunkSize - overlap) {
      const end = Math.min(start + chunkSize, lines.length);
      const text = lines.slice(start, end).join('\n').trim();
      if (text.length > 30) {
        chunks.push({ filePath, startLine: start + 1, endLine: end, content: text });
      }
      if (end >= lines.length) break;
    }
    return chunks;
  } catch {
    return [];
  }
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'dist-lima-agent', '.git', 'release']);

function walkSourceFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkSourceFiles(full));
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(full);
      }
    }
  } catch { /* ignore permission errors */ }
  return results;
}

// ---------------------------------------------------------------------------
// CodebaseRAG — main class
// ---------------------------------------------------------------------------

type EmbedFn = (text: string) => Promise<number[]>;

export class CodebaseRAG {
  private static instance: CodebaseRAG;
  private chunks: CodeChunk[] = [];
  private indexed = false;
  private indexing = false;

  private constructor(
    private readonly projectRoot: string,
    private readonly embedFn: EmbedFn,
  ) {}

  static getInstance(projectRoot: string, embedFn: EmbedFn): CodebaseRAG {
    if (!CodebaseRAG.instance) {
      CodebaseRAG.instance = new CodebaseRAG(projectRoot, embedFn);
    }
    return CodebaseRAG.instance;
  }

  /**
   * Build (or rebuild) the index. Runs in background — do not await in hot path.
   * Chunks each source file and computes embeddings in batches.
   */
  async buildIndex(maxFiles = 200): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;
    log('[CodebaseRAG] 🔍 Building codebase index…');

    try {
      const files = walkSourceFiles(this.projectRoot).slice(0, maxFiles);
      const allChunks: CodeChunk[] = [];
      for (const file of files) {
        allChunks.push(...chunkFile(file));
      }

      // Embed in batches of 10 to avoid rate limits
      const batchSize = 10;
      const embedded: CodeChunk[] = [];
      for (let i = 0; i < allChunks.length; i += batchSize) {
        const batch = allChunks.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (chunk) => {
            try {
              chunk.embedding = await this.embedFn(chunk.content.slice(0, 1000));
            } catch {
              // skip chunks that fail to embed
            }
          })
        );
        embedded.push(...batch.filter((c) => c.embedding && c.embedding.length > 0));
      }

      this.chunks = embedded;
      this.indexed = true;
      log(`[CodebaseRAG] ✅ Indexed ${this.chunks.length} chunks from ${files.length} files`);
    } catch (err) {
      logError('[CodebaseRAG] Failed to build index:', err);
    } finally {
      this.indexing = false;
    }
  }

  /**
   * Semantic search: embed the query and return top-k chunks by cosine similarity.
   */
  async search(query: string, topK = 5): Promise<SearchResult[]> {
    if (!this.indexed) {
      return [{ filePath: '', startLine: 0, endLine: 0, content: 'Index not ready yet. Call buildIndex() first.', score: 0 }];
    }

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedFn(query.slice(0, 500));
    } catch (err) {
      logError('[CodebaseRAG] Failed to embed query:', err);
      return [];
    }

    const scored = this.chunks
      .filter((c) => c.embedding && c.embedding.length > 0)
      .map((c) => ({
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        score: cosineSimilarity(queryEmbedding, c.embedding!),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  isIndexed(): boolean { return this.indexed; }
  chunkCount(): number { return this.chunks.length; }
}
