/**
 * @module main/machine-access/injection-guard
 *
 * Prompt-injection defence (spec 9): file content, web pages, tool results
 * and file NAMES are DATA, never instructions.
 *
 * - Untrusted content is sanitized (control sequences stripped, size capped)
 *   before it can influence an action.
 * - A destructive, sensitive or out-of-scope action that follows untrusted
 *   reading forces a reconfirmation naming the source — including under
 *   "allow-all".
 * - A hostile file content or filename produces NO action at all.
 */

import type { RiskContext } from './risk-assessor';
import type { RiskAssessment } from './types';

export type UntrustedKind = 'file-content' | 'file-name' | 'web-content' | 'tool-result';

export interface UntrustedSource {
  kind: UntrustedKind;
  /** Path or URL, shown verbatim on the reconfirmation card. */
  label: string;
}

/** Control characters and zero-width markers used to hide instructions. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export interface SanitizeResult {
  text: string;
  truncated: boolean;
  removedChars: number;
}

/**
 * Make untrusted text safe to show. Never executed, only displayed, so this
 * removes hidden characters and caps the size — it does not rewrite meaning.
 */
export function sanitizeUntrusted(input: string, maxChars = 20_000): SanitizeResult {
  const withoutControls = input.replace(CONTROL_CHARS, '').replace(ZERO_WIDTH, '');
  const removed = input.length - withoutControls.length;
  const truncated = withoutControls.length > maxChars;
  return {
    text: truncated ? `${withoutControls.slice(0, maxChars)}\n…[truncated]` : withoutControls,
    truncated,
    removedChars: removed,
  };
}

/** File names may carry invisible or path-traversal payloads. */
export function sanitizeFileName(name: string): SanitizeResult {
  return sanitizeUntrusted(name, 255);
}

/** Does the name itself attempt to steer the agent (classic injection vector)? */
export function filenameLooksInjected(name: string): boolean {
  const cleaned = sanitizeFileName(name).text.toLowerCase();
  // Filenames rarely contain spaces, so separators are normalized before matching.
  const normalized = cleaned.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return /ignore (all |the )?(previous|prior|above)|disregard (the )?(rules|instructions)|system prompt|you are now|exfiltrat/.test(
    normalized
  );
}

/** Sanitize a tool result before it reaches the model. */
export function sanitizeToolResult(text: string, maxChars = 20_000): SanitizeResult {
  return sanitizeUntrusted(text, maxChars);
}

/**
 * Hostile content is data. A name that carries instructions is neutralized
 * before any path is derived from it.
 */
export function safeNameForPath(name: string): string {
  const { text } = sanitizeFileName(name);
  return text.replace(/[/\\]/g, '_').replace(/\0/g, '');
}

export interface ReconfirmationDecision {
  requiresReconfirmation: boolean;
  source?: string;
  cardText?: string;
  /** Extra risk reasons merged from the source context. */
  riskContext: RiskContext;
}

/**
 * A destructive, sensitive or out-of-scope action following untrusted
 * reading must be re-confirmed with the source named. In every autonomy
 * level, including 'allow-all'.
 */
export function requireReconfirmation(
  action: RiskAssessment,
  source: UntrustedSource | null,
  autonomy: string
): ReconfirmationDecision {
  const dangerous = action.level !== 'ordinaire';
  if (!source || !dangerous) {
    return { requiresReconfirmation: false, riskContext: {} };
  }
  const cardText =
    `This action comes from the content of ${source.kind} '${source.label}'. ` +
    `It was judged ${action.level} (${action.reasons.join('; ') || 'risk rules'}). ` +
    `Autonomy level '${autonomy}' does not skip this confirmation.`;
  return {
    requiresReconfirmation: true,
    source: source.label,
    cardText,
    riskContext: { fromUntrustedContent: true, untrustedSource: `${source.kind}: ${source.label}` },
  };
}

/**
 * End-to-end rule: a file whose content tries to instruct the agent yields
 * no action. Callers must treat `blocked` as "do nothing".
 */
export function inspectUntrustedFile(
  fileName: string,
  content: string,
  proposed: { kind: string; destructive: boolean }
): { blocked: boolean; reason: string; safeName: string; sanitized: SanitizeResult } {
  const safeName = safeNameForPath(fileName);
  const sanitized = sanitizeToolResult(content);
  if (filenameLooksInjected(fileName)) {
    return {
      blocked: true,
      reason: `Filename '${sanitizeFileName(fileName).text}' carries instruction-like text; treated as data.`,
      safeName,
      sanitized,
    };
  }
  if (proposed.destructive && /ignore (all |the )?(previous|prior|above)|disregard (the )?(rules|instructions)|you are now|rm -rf|sudo /.test(sanitized.text)) {
    return {
      blocked: true,
      reason: `Content of '${fileName}' contains instruction-like text and a destructive action was proposed; refused.`,
      safeName,
      sanitized,
    };
  }
  return { blocked: false, reason: '', safeName, sanitized };
}