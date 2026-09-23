/**
 * @module main/utils/health-report-collector
 *
 * Gathers the observable facts behind the diagnostics page and hands them to
 * the shared classifier. Every probe is defensive: a diagnostic page that
 * throws while diagnosing is worse than useless, so a failed probe degrades to
 * the pessimistic value instead.
 */

import { accessSync, constants } from 'fs';
import { execFileSync } from 'child_process';
import { app } from 'electron';
import { configStore } from '../config/config-store';
import { getSandboxAdapter } from '../sandbox/sandbox-adapter';
import { resolveSettingsLadder } from '../../shared/settings-levels';
import {
  buildHealthReport,
  type HealthFacts,
  type HealthReport,
} from '../../shared/health-report';
import type { Project, Session } from '../../shared/types';

/** Everything the collector needs that main/index.ts already owns. */
export interface HealthReportContext {
  /** Session whose settings and workspace are being diagnosed, when any. */
  session?: Session | null;
  /** Project that session belongs to, when any. */
  project?: Project | null;
}

/** git version, or null when the probe failed. Never throws. */
function probeGitVersion(): string | null {
  try {
    const output = execFileSync('git', ['--version'], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return typeof output === 'string' && output.trim() ? output.trim() : null;
  } catch {
    return null;
  }
}

/** Whether a directory exists and accepts writes. Never throws. */
function isDirectoryWritable(path: string | null): boolean {
  if (!path) return false;
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function exists(path: string | null): boolean {
  if (!path) return false;
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the ConfigSet that is actually in effect for the session (global ->
 * project -> session) and whether it carries usable credentials. Falls back to
 * the globally active set when there is no session.
 */
export function resolveCredentialFacts(context: HealthReportContext): {
  credentialsUsable: boolean;
  provider: string;
  model: string;
  configSetName: string;
} {
  try {
    const globalConfig = configStore.getAll();
    const ladder = resolveSettingsLadder({
      global: {
        activeConfigSetId: globalConfig.activeConfigSetId,
        configSets: globalConfig.configSets,
      },
      project: context.project
        ? {
            id: context.project.id,
            name: context.project.name,
            configSetId: context.project.configSetId,
            modelId: context.project.modelId,
          }
        : null,
      session: context.session
        ? { configSetId: context.session.configSetId, modelId: context.session.configModelId }
        : null,
    });
    const projected = ladder.configSetId
      ? configStore.getConfigSetProjectedConfig(ladder.configSetId, ladder.model || undefined)
      : undefined;
    return {
      credentialsUsable: projected ? configStore.hasUsableCredentials(projected) : false,
      provider: ladder.provider,
      model: ladder.model,
      configSetName: ladder.configSetName || ladder.configSetId,
    };
  } catch {
    return { credentialsUsable: false, provider: '', model: '', configSetName: '' };
  }
}

/** The working directory the session would actually run in. */
function resolveWorkingDir(context: HealthReportContext): string | null {
  try {
    const fromSession = context.session?.cwd?.trim();
    if (fromSession) return fromSession;
    return configStore.get('defaultWorkdir')?.trim() || null;
  } catch {
    return null;
  }
}

function resolveStoragePath(): string | null {
  try {
    return app.getPath('userData') || null;
  } catch {
    return null;
  }
}

function resolveSandboxBackend(sandboxEnabled: boolean): 'wsl' | 'lima' | null {
  if (!sandboxEnabled) return null;
  try {
    const adapter = getSandboxAdapter();
    if (adapter.isWSL) return 'wsl';
    if (adapter.isLima) return 'lima';
    return null;
  } catch {
    return null;
  }
}

export function collectHealthFacts(context: HealthReportContext = {}): HealthFacts {
  const credentials = resolveCredentialFacts(context);
  const workingDir = resolveWorkingDir(context);
  const storagePath = resolveStoragePath();
  let sandboxEnabled = false;
  try {
    sandboxEnabled = configStore.get('sandboxEnabled') === true;
  } catch {
    sandboxEnabled = false;
  }
  return {
    ...credentials,
    workingDir,
    workingDirExists: exists(workingDir),
    sandboxEnabled,
    sandboxBackend: resolveSandboxBackend(sandboxEnabled),
    storageWritable: isDirectoryWritable(storagePath),
    storagePath,
    gitVersion: probeGitVersion(),
  };
}

/** Collect the facts and classify them. Never throws. */
export function collectHealthReport(context: HealthReportContext = {}): HealthReport {
  try {
    return buildHealthReport(collectHealthFacts(context));
  } catch {
    return buildHealthReport({
      credentialsUsable: false,
      provider: '',
      model: '',
      configSetName: '',
      workingDir: null,
      workingDirExists: false,
      sandboxEnabled: false,
      sandboxBackend: null,
      storageWritable: false,
      storagePath: null,
      gitVersion: null,
    });
  }
}
