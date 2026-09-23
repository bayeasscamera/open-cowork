/**
 * @module main/ipc/model-routing-handlers
 *
 * Cowork 4.0 — Phase 7: model profiles, routing, local benchmarks, local
 * provider detection and registry validation. Every payload is validated here.
 */

import { ipcMain } from 'electron';
import type {
  LocalProviderKind,
  LocalProviderProbe,
  ModelBenchmark,
  ModelProfile,
  ModelProfileId,
  RegistryEntryInput,
  RegistryValidation,
  RoutingDecision,
  RoutingRequest,
  TaskKind,
} from '../../shared/model-routing-types';
import {
  LOCAL_PROVIDER_KINDS,
  MODEL_PROFILE_IDS,
  TASK_KINDS,
} from '../../shared/model-routing-types';
import { DEFAULT_MODEL_PROFILES, routeModel } from '../agent/model-profiles';
import { ModelBenchmarkStore } from '../agent/model-benchmark';
import { probeAllLocalProviders, probeLocalProvider } from '../agent/local-providers';
import { validateRegistryEntry } from '../agent/model-registry';
import { logError } from '../utils/logger';

export interface ModelRoutingIpcContext {
  profiles?: readonly ModelProfile[];
  benchmarks?: ModelBenchmarkStore;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(label + ' must be a non-empty string.');
  }
  return value;
}

function coerceTaskKind(value: unknown): TaskKind {
  if (typeof value !== 'string' || !(TASK_KINDS as readonly string[]).includes(value)) {
    throw new Error('Unknown task kind: ' + String(value));
  }
  return value as TaskKind;
}

function coerceProfileId(value: unknown): ModelProfileId {
  if (typeof value !== 'string' || !(MODEL_PROFILE_IDS as readonly string[]).includes(value)) {
    throw new Error('Unknown model profile: ' + String(value));
  }
  return value as ModelProfileId;
}

function coerceLocalProviderKind(value: unknown): LocalProviderKind {
  if (typeof value !== 'string' || !(LOCAL_PROVIDER_KINDS as readonly string[]).includes(value)) {
    throw new Error('Unknown local provider: ' + String(value));
  }
  return value as LocalProviderKind;
}

function coerceRoutingRequest(value: unknown): RoutingRequest {
  const candidate = (value ?? {}) as Partial<RoutingRequest>;
  const request: RoutingRequest = { taskKind: coerceTaskKind(candidate.taskKind) };
  if (typeof candidate.requiresTools === 'boolean') {
    request.requiresTools = candidate.requiresTools;
  }
  if (typeof candidate.requiresVision === 'boolean') {
    request.requiresVision = candidate.requiresVision;
  }
  if (typeof candidate.requiresJson === 'boolean') {
    request.requiresJson = candidate.requiresJson;
  }
  if (typeof candidate.confidential === 'boolean') {
    request.confidential = candidate.confidential;
  }
  if (typeof candidate.maxCostTier === 'number' && candidate.maxCostTier > 0) {
    request.maxCostTier = Math.floor(candidate.maxCostTier);
  }
  if (typeof candidate.minContextWindow === 'number' && candidate.minContextWindow > 0) {
    request.minContextWindow = Math.floor(candidate.minContextWindow);
  }
  if (candidate.preferredProfile !== undefined) {
    request.preferredProfile = coerceProfileId(candidate.preferredProfile);
  }
  return request;
}

function coerceBenchmarkInput(value: unknown): {
  modelId: string;
  taskKind: TaskKind;
  success: boolean;
  latencyMs: number;
  costUsd?: number;
} {
  const candidate = (value ?? {}) as {
    modelId?: unknown;
    taskKind?: unknown;
    success?: unknown;
    latencyMs?: unknown;
    costUsd?: unknown;
  };
  const input = {
    modelId: requireNonEmpty(candidate.modelId, 'Benchmark model id'),
    taskKind: coerceTaskKind(candidate.taskKind),
    success: candidate.success === true,
    latencyMs:
      typeof candidate.latencyMs === 'number' && Number.isFinite(candidate.latencyMs)
        ? Math.max(0, candidate.latencyMs)
        : 0,
  } as { modelId: string; taskKind: TaskKind; success: boolean; latencyMs: number; costUsd?: number };
  if (typeof candidate.costUsd === 'number' && Number.isFinite(candidate.costUsd)) {
    input.costUsd = Math.max(0, candidate.costUsd);
  }
  return input;
}

function coerceRegistryInput(value: unknown): RegistryEntryInput {
  const candidate = (value ?? {}) as Partial<RegistryEntryInput>;
  const input: RegistryEntryInput = {
    repoId: typeof candidate.repoId === 'string' ? candidate.repoId : '',
  };
  if (typeof candidate.url === 'string' && candidate.url.length > 0) {
    input.url = candidate.url;
  }
  if (typeof candidate.fileName === 'string' && candidate.fileName.length > 0) {
    input.fileName = candidate.fileName;
  }
  if (typeof candidate.sha256 === 'string' && candidate.sha256.length > 0) {
    input.sha256 = candidate.sha256;
  }
  if (typeof candidate.sizeBytes === 'number' && Number.isFinite(candidate.sizeBytes)) {
    input.sizeBytes = candidate.sizeBytes;
  }
  if (Array.isArray(candidate.taskKinds)) {
    input.taskKinds = candidate.taskKinds.filter(
      (kind): kind is TaskKind =>
        typeof kind === 'string' && (TASK_KINDS as readonly string[]).includes(kind)
    );
  }
  return input;
}

export function registerModelRoutingIpcHandlers(context: ModelRoutingIpcContext = {}): void {
  const profiles = context.profiles ?? DEFAULT_MODEL_PROFILES;
  const benchmarks = context.benchmarks ?? new ModelBenchmarkStore();

  ipcMain.handle('modelRouting.profiles', (): ModelProfile[] =>
    profiles.map((profile) => ({ ...profile, capabilities: { ...profile.capabilities } }))
  );

  ipcMain.handle('modelRouting.route', (_event, request: unknown): RoutingDecision =>
    routeModel(coerceRoutingRequest(request), profiles, benchmarks.list())
  );

  ipcMain.handle(
    'modelRouting.benchmarks',
    (_event, modelId?: unknown, taskKind?: unknown): ModelBenchmark[] =>
      benchmarks.list(
        typeof modelId === 'string' && modelId.length > 0 ? modelId : undefined,
        taskKind === undefined ? undefined : coerceTaskKind(taskKind)
      )
  );

  ipcMain.handle('modelRouting.recordBenchmark', (_event, input: unknown): ModelBenchmark =>
    benchmarks.record(coerceBenchmarkInput(input))
  );

  ipcMain.handle('modelRouting.clearBenchmarks', (): { cleared: number } => ({
    cleared: benchmarks.clear(),
  }));

  ipcMain.handle(
    'modelRouting.probeLocal',
    async (_event, kind?: unknown): Promise<LocalProviderProbe[]> => {
      try {
        if (kind === undefined || kind === null || kind === '') {
          return await probeAllLocalProviders();
        }
        return [await probeLocalProvider(coerceLocalProviderKind(kind))];
      } catch (error: unknown) {
        logError('[modelRouting] probeLocal failed', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    'modelRouting.validateRegistry',
    (_event, input: unknown): RegistryValidation => validateRegistryEntry(coerceRegistryInput(input))
  );
}
