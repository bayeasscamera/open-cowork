/**
 * Tests for the pure whole-app diagnostics classifier. The collector's job is
 * only to observe facts; every severity decision lives here, so these tests pin
 * what the diagnostics page will actually tell the user.
 */

import { describe, expect, it } from 'vitest';
import {
  buildHealthReport,
  buildHealthChecks,
  overallHealthStatus,
  type HealthFacts,
} from '../src/shared/health-report';

function facts(over: Partial<HealthFacts> = {}): HealthFacts {
  return {
    credentialsUsable: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    configSetName: 'Deep',
    workingDir: '/tmp/workspace',
    workingDirExists: true,
    sandboxEnabled: true,
    sandboxBackend: 'lima',
    storageWritable: true,
    storagePath: '/tmp/userData',
    gitVersion: 'git version 2.42.0',
    ...over,
  };
}

const byId = (checks: ReturnType<typeof buildHealthChecks>, id: string) =>
  checks.find((check) => check.id === id)!;

describe('buildHealthChecks — healthy baseline', () => {
  it('reports every check as ok with concrete details', () => {
    const checks = buildHealthChecks(facts());
    expect(checks.map((check) => check.id)).toEqual([
      'credentials',
      'model',
      'workspace',
      'sandbox',
      'storage',
      'native-tools',
    ]);
    expect(checks.every((check) => check.status === 'ok')).toBe(true);
    expect(byId(checks, 'credentials').detail).toBe('Deep');
    expect(byId(checks, 'model').detail).toBe('claude-sonnet-4');
    expect(byId(checks, 'workspace').detail).toBe('/tmp/workspace');
    expect(byId(checks, 'sandbox').detail).toBe('lima');
    expect(byId(checks, 'native-tools').detail).toBe('git version 2.42.0');
  });

  it('falls back to the provider when the ConfigSet has no name', () => {
    const checks = buildHealthChecks(facts({ configSetName: '', provider: 'ollama' }));
    expect(byId(checks, 'credentials').detail).toBe('ollama');
  });
});

describe('buildHealthChecks — blocking conditions', () => {
  it('fails when the effective ConfigSet has no usable credentials', () => {
    const check = byId(buildHealthChecks(facts({ credentialsUsable: false })), 'credentials');
    expect(check.status).toBe('fail');
  });

  it('fails when no model is selected', () => {
    expect(byId(buildHealthChecks(facts({ model: '   ' })), 'model').status).toBe('fail');
  });

  it('fails when the workspace disappeared', () => {
    const check = byId(
      buildHealthChecks(facts({ workingDir: '/gone', workingDirExists: false })),
      'workspace'
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('/gone');
  });

  it('fails when the app storage is not writable', () => {
    const check = byId(buildHealthChecks(facts({ storageWritable: false })), 'storage');
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('/tmp/userData');
  });
});

describe('buildHealthChecks — degradations', () => {
  it('warns (does not fail) when no working directory is set yet', () => {
    expect(
      byId(buildHealthChecks(facts({ workingDir: null, workingDirExists: false })), 'workspace')
        .status
    ).toBe('warn');
  });

  it('warns when the sandbox is enabled but no backend is available', () => {
    expect(byId(buildHealthChecks(facts({ sandboxBackend: null })), 'sandbox').status).toBe('warn');
  });

  it('stays ok when the sandbox is disabled, even without a backend', () => {
    const checks = buildHealthChecks(
      facts({ sandboxEnabled: false, sandboxBackend: null })
    );
    expect(byId(checks, 'sandbox').status).toBe('ok');
  });

  it('warns when git is missing (worktree isolation unavailable)', () => {
    const check = byId(buildHealthChecks(facts({ gitVersion: null })), 'native-tools');
    expect(check.status).toBe('warn');
    expect(check.detail).toBeUndefined();
  });
});

describe('overallHealthStatus', () => {
  it('is ok when every check passes', () => {
    expect(overallHealthStatus(buildHealthChecks(facts()))).toBe('ok');
  });

  it('is warn when only a warning is present', () => {
    expect(overallHealthStatus(buildHealthChecks(facts({ gitVersion: null })))).toBe('warn');
  });

  it('is fail when anything blocks, even alongside warnings', () => {
    expect(
      overallHealthStatus(buildHealthChecks(facts({ gitVersion: null, credentialsUsable: false })))
    ).toBe('fail');
  });

  it('is ok for an empty check list', () => {
    expect(overallHealthStatus([])).toBe('ok');
  });
});

describe('buildHealthReport', () => {
  it('stamps the report and keeps the observed facts', () => {
    const report = buildHealthReport(facts(), 1234);
    expect(report.generatedAt).toBe(1234);
    expect(report.status).toBe('ok');
    expect(report.facts.provider).toBe('anthropic');
    expect(report.checks).toHaveLength(6);
  });

  it('surfaces the worst status of the run', () => {
    expect(buildHealthReport(facts({ model: '' })).status).toBe('fail');
    expect(buildHealthReport(facts({ storageWritable: false })).status).toBe('fail');
  });
});
