/**
 * @module main/mods/skill-doctor
 *
 * `/skill doctor` — context-cost analyzer for loaded skills. 100% local:
 * token estimates from content size, usage counters persisted locally.
 */

import Store from 'electron-store';
import * as fs from 'fs';
import * as path from 'path';
import { getModsRegistry } from './mods-runtime';

interface SkillUsageSchema {
  usage: Record<string, { count: number; lastUsedAt: number }>;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface SkillDoctorEntry {
  name: string;
  path: string;
  tokenEstimate: number;
  useCount: number;
  lastUsedAt: number | null;
  recommendation: 'disable' | 'keep';
}

interface SkillDoctorReport {
  entries: SkillDoctorEntry[];
  totalSkillTokens: number;
  contextWindow: number | null;
}

export interface SkillDoctorSkillSource {
  name: string;
  path: string;
  /** Full SKILL.md content for token estimation. */
  content: string;
}

class SkillUsageTracker {
  private readonly store = new Store<SkillUsageSchema>({ name: 'skill-usage' });

  record(skillPath: string): void {
    const usage = this.store.get('usage') ?? {};
    const entry = usage[skillPath] ?? { count: 0, lastUsedAt: 0 };
    entry.count += 1;
    entry.lastUsedAt = Date.now();
    usage[skillPath] = entry;
    this.store.set('usage', usage);
  }

  get(skillPath: string): { count: number; lastUsedAt: number } {
    const usage = this.store.get('usage') ?? {};
    return usage[skillPath] ?? { count: 0, lastUsedAt: 0 };
  }
}

const tracker = new SkillUsageTracker();

/**
 * Track a skill "use" — called by the mods pre-hook when the model reads a
 * file inside a skill directory (the pi SDK loads skills as context; using
 * one means reading its files).
 */
export function recordSkillUseIfApplicable(toolName: string, args: Record<string, unknown>): void {
  if (toolName !== 'read') return;
  const raw = (args as { path?: unknown }).path;
  if (typeof raw !== 'string') return;
  const normalized = raw.replace(/\\/g, '/');
  if (!normalized.includes('/skills/')) return;
  tracker.record(path.resolve(raw));
}

/** Rough token estimate: ~4 characters per token, floor at 1 for non-empty. */
export function estimateTokens(content: string): number {
  if (!content) return 0;
  return Math.max(1, Math.ceil(content.length / 4));
}

export function buildSkillDoctorReport(
  skills: SkillDoctorSkillSource[],
  contextWindow: number | null
): SkillDoctorReport {
  const now = Date.now();
  const entries: SkillDoctorEntry[] = skills.map((skill) => {
    const usage = tracker.get(skill.path);
    const neverUsed = usage.count === 0 || now - usage.lastUsedAt > THIRTY_DAYS_MS;
    return {
      name: skill.name,
      path: skill.path,
      tokenEstimate: estimateTokens(skill.content),
      useCount: usage.count,
      lastUsedAt: usage.count > 0 ? usage.lastUsedAt : null,
      recommendation: neverUsed ? 'disable' : 'keep',
    };
  });
  entries.sort((a, b) => b.tokenEstimate - a.tokenEstimate);
  return {
    entries,
    totalSkillTokens: entries.reduce((total, entry) => total + entry.tokenEstimate, 0),
    contextWindow,
  };
}

/** Convenience for tests: read SKILL.md sources from a directory. */
export function loadSkillSourcesFromDir(skillsDir: string): SkillDoctorSkillSource[] {
  const sources: SkillDoctorSkillSource[] = [];
  try {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
      try {
        if (fs.existsSync(skillMd)) {
          sources.push({
            name: entry.name,
            path: skillMd,
            content: fs.readFileSync(skillMd, 'utf-8'),
          });
        }
      } catch {
        // unreadable skill — skip
      }
    }
  } catch {
    // unreadable dir — empty report
  }
  return sources;
}

/** Test seam. */
export function setSkillUsageStoreForTest(): SkillUsageTracker {
  return tracker;
}

// Re-exported so the caller wiring the registry can compose in one place.
export { getModsRegistry };
