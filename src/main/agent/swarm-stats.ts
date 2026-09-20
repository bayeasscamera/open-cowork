/**
 * @module main/agent/swarm-stats
 *
 * Lightweight execution statistics for the swarm, surfaced in the Sub-agents
 * settings screen (cost & transparency section). Deliberately cheap: one
 * atomic JSON file, updated once per executed plan — no database migration,
 * no per-event bookkeeping.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { MultiAgentPlan } from './multi-agent-coordinator';
import type { SwarmStats } from '../../shared/types';
import { logError } from '../utils/logger';

export type { SwarmStats };

let stats: SwarmStats = {
  totalSwarms: 0,
  succeededSwarms: 0,
  totalTasks: 0,
  fallbackTasks: 0,
};
let file: string | null = null;
let loaded = false;

function statsFile(): string {
  if (file) return file;
  let userData = '';
  try {
    userData = app?.getPath ? app.getPath('userData') : '';
  } catch {
    userData = '';
  }
  file = path.join(userData || path.join(process.cwd(), '.cowork'), 'swarm_stats.json');
  return file;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const p = statsFile();
    if (fs.existsSync(p)) {
      stats = { ...stats, ...(JSON.parse(fs.readFileSync(p, 'utf-8')) as SwarmStats) };
    }
  } catch (err) {
    logError('[SwarmStats] Failed to load persisted stats:', err);
  }
}

/** Test/optional hook: pin the storage location before first use. */
export function initSwarmStats(userDataDir: string): void {
  file = path.join(userDataDir, 'swarm_stats.json');
  stats = { totalSwarms: 0, succeededSwarms: 0, totalTasks: 0, fallbackTasks: 0 };
  loaded = false;
  ensureLoaded();
}

function persist(): void {
  try {
    const p = statsFile();
    const tmp = `${p}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  } catch (err) {
    logError('[SwarmStats] Failed to persist:', err);
  }
}

/**
 * Record a finished swarm execution (called by the orchestrate tool with the
 * executed plan and its wall-clock duration).
 */
export function recordSwarmExecution(plan: MultiAgentPlan, durationMs: number): void {
  ensureLoaded();
  stats.totalSwarms += 1;
  if (plan.status === 'done') stats.succeededSwarms += 1;
  stats.totalTasks += plan.tasks.length;
  stats.fallbackTasks += plan.tasks.filter((t) => t.usedFallback).length;
  const input = plan.tasks.reduce((sum, t) => sum + (t.tokenUsage?.input ?? 0), 0);
  const output = plan.tasks.reduce((sum, t) => sum + (t.tokenUsage?.output ?? 0), 0);
  stats.lastRunMs = durationMs;
  stats.lastRunAt = Date.now();
  // Only expose tokens when the provider actually reported usage — a flat
  // 0/0 from a local gateway must not read as "free".
  stats.lastRunTokens = input > 0 || output > 0 ? { input, output } : undefined;
  persist();
}

export function getSwarmStats(): SwarmStats {
  ensureLoaded();
  return { ...stats };
}

/** Test hook. */
export function __resetSwarmStatsForTest(): void {
  stats = { totalSwarms: 0, succeededSwarms: 0, totalTasks: 0, fallbackTasks: 0 };
  loaded = true;
}