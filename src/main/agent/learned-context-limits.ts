/**
 * @module main/agent/learned-context-limits
 *
 * Learn the REAL upstream context window from 400 overflow errors and use it
 * as ground truth for pre-flight guards and fallback routing.
 *
 * Why this exists: synthetic models for unknown relay models assume a fictive
 * window (200k conservative default). When the real upstream is smaller, every
 * guard reasons on the wrong number — the 80% compaction trigger never fires
 * and the user gets a raw 400 ("estimated 201274 input tokens, limit 200000").
 * Upstream error messages usually carry the real limit, so the first overflow
 * teaches the runner the true window for that model id and later turns reason
 * on it instead of the fiction.
 *
 * The store is a tiny JSON file under userData (`learned-context-limits.json`)
 * with an in-memory cache. Only the smallest observed limit per model is kept:
 * a smaller number is always the safer belief. All I/O is best-effort and
 * never throws — telemetry must never break the run loop.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const STORE_FILENAME = 'learned-context-limits.json';

/** Plausible bounds for a real context window — anything outside is noise. */
const MIN_SANE_LIMIT = 1_024;
const MAX_SANE_LIMIT = 10_000_000;

/** Rough chars-per-token for prompt-size estimation (matches ~4 for English). */
const CHARS_PER_TOKEN = 4;

type LimitsMap = Record<string, { limit: number; updatedAt: number }>;

let cache: LimitsMap | null = null;

function storePath(): string | undefined {
  try {
    const base =
      app?.getPath?.('userData') || path.join(process.cwd(), '.cowork');
    if (!base) return undefined;
    return path.join(base, STORE_FILENAME);
  } catch {
    return undefined;
  }
}

function loadCache(): LimitsMap {
  if (cache) return cache;
  cache = {};
  try {
    const file = storePath();
    if (!file || !fs.existsSync(file)) return cache;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw as LimitsMap)) {
        const limit = (value as { limit?: unknown })?.limit;
        if (typeof key === 'string' && typeof limit === 'number' && isSaneLimit(limit)) {
          cache[key] = {
            limit: Math.floor(limit),
            updatedAt:
              typeof (value as { updatedAt?: unknown })?.updatedAt === 'number'
                ? (value as { updatedAt: number }).updatedAt
                : 0,
          };
        }
      }
    }
  } catch {
    cache = {};
  }
  return cache;
}

function persistCache(): void {
  try {
    const file = storePath();
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache ?? {}, null, 2), 'utf8');
  } catch {
    // Best-effort persistence only.
  }
}

function isSaneLimit(limit: number): boolean {
  return (
    typeof limit === 'number' &&
    Number.isFinite(limit) &&
    limit >= MIN_SANE_LIMIT &&
    limit <= MAX_SANE_LIMIT
  );
}

/** Normalize a model id for store keys — case-insensitive, trimmed. */
export function normalizeModelKey(modelId: string | undefined): string {
  return (modelId ?? '').trim().toLowerCase();
}

function parseRawNumber(raw: string): number | undefined {
  const cleaned = raw.replace(/[\s,]/g, '');
  if (!/^\d+$/.test(cleaned)) return undefined;
  const value = parseInt(cleaned, 10);
  return isSaneLimit(value) ? value : undefined;
}

/**
 * Extract the real upstream context limit from an overflow error message.
 * Handles the phrasings seen across relays:
 * - "estimated 201274 input tokens, limit 200000"
 * - "prompt is too long: 250000 tokens > 200000 maximum"
 * - "This model's maximum context length is 8192 tokens"
 * - "context_length_exceeded ... max 128000"
 * Returns undefined when no plausible limit is found.
 */
export function parseUpstreamContextLimit(errorText: string): number | undefined {
  if (!errorText) return undefined;
  const patterns: RegExp[] = [
    /\blimit\b\s*[:=]?\s*(\d[\d\s,]*)/i,
    /maximum(?: context (?:length|window))?\s*(?:is|:)?\s*(\d[\d\s,]*)/i,
    /(\d[\d\s,]*)\s*(?:input )?tokens?\s+maximum/i,
    // "250000 tokens > 200000 maximum" — the cap precedes the word maximum.
    /(\d[\d\s,]*)\s+maximum/i,
    /\bmax(?:imum)?\b\s*[:=]?\s*(\d[\d\s,]*)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(errorText);
    if (match?.[1]) {
      const value = parseRawNumber(match[1]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/**
 * Record an observed upstream limit for a model. Keeps the smallest value:
 * the tightest known window is the safe belief for future guards. No-op for
 * empty model ids or implausible limits. Never throws.
 */
export function recordLearnedContextLimit(
  modelId: string | undefined,
  limit: number | undefined
): void {
  try {
    const key = normalizeModelKey(modelId);
    if (!key || limit === undefined || !isSaneLimit(limit)) return;
    const map = loadCache();
    const existing = map[key]?.limit;
    if (existing === undefined || limit < existing) {
      map[key] = { limit: Math.floor(limit), updatedAt: Date.now() };
      persistCache();
    }
  } catch {
    // Learning must never break the run.
  }
}

/** Read a previously learned upstream limit for a model, if any. */
export function getLearnedContextLimit(modelId: string | undefined): number | undefined {
  try {
    const key = normalizeModelKey(modelId);
    if (!key) return undefined;
    return loadCache()[key]?.limit;
  } catch {
    return undefined;
  }
}

/** Test hook — clears the in-memory cache (and the file when reachable). */
export function resetLearnedContextLimits(): void {
  cache = {};
  try {
    const file = storePath();
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // Best-effort only.
  }
}

export interface EffectiveWindowInput {
  /** Full model string as routed (e.g. "opencode-go/space-bunny-free"). */
  modelId?: string;
  /** Configured or resolved window (0/undefined = unknown). */
  configuredWindow?: number;
  /** Last-resort default when nothing else is known. */
  fallbackWindow: number;
}

/**
 * The window guards should reason about: the smallest credible number wins.
 * An explicit user setting is a cap, a learned upstream limit is ground truth
 * — either way the minimum is the safe belief. Never returns <= 0.
 */
export function resolveEffectiveContextWindow(input: EffectiveWindowInput): number {
  const candidates: number[] = [];
  if (typeof input.configuredWindow === 'number' && input.configuredWindow > 0) {
    candidates.push(input.configuredWindow);
  }
  const learned = getLearnedContextLimit(input.modelId);
  if (learned !== undefined) candidates.push(learned);
  if (candidates.length === 0) {
    return input.fallbackWindow > 0 ? input.fallbackWindow : 128_000;
  }
  return Math.min(...candidates);
}

/** Rough input-size estimate for the pre-flight guard (chars / 4, rounded up). */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export interface PreflightInput {
  estimatedTokens: number;
  effectiveWindow: number;
}

/**
 * Pure pre-flight decision: refuse only when the prompt ALONE already exceeds
 * the window — a certain 400. Warm-session history living inside the SDK is
 * invisible here, so near-misses only warn (the caller logs the ratio).
 */
export function shouldRefusePromptPreflight(input: PreflightInput): boolean {
  if (input.effectiveWindow <= 0) return false;
  return input.estimatedTokens > input.effectiveWindow;
}
