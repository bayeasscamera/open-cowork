import { describe, expect, it } from 'vitest';

// Redaction happens inside logger.ts internals; exercise the string pipeline
// by importing the module and asserting its exported normalization behavior
// through a minimal reflection over the source of truth.
import * as loggerModule from '../src/main/utils/logger';

describe('logger secret redaction', () => {
  it('module loads and exports the logging surface', () => {
    expect(typeof loggerModule.log).toBe('function');
    expect(typeof loggerModule.logError).toBe('function');
  });

  it('masks sk-style API keys', async () => {
    const { redactSecretsForTest } = await import('../src/main/utils/logger');
    const out = redactSecretsForTest('token: sk-abc123def456ghi789jkl done');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-abc123def456ghi789jkl');
  });

  it('masks bearer tokens', async () => {
    const { redactSecretsForTest } = await import('../src/main/utils/logger');
    const out = redactSecretsForTest('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });

  it('masks api_key values but keeps the field name', async () => {
    const { redactSecretsForTest } = await import('../src/main/utils/logger');
    const out = redactSecretsForTest('api_key=abcd1234efgh5678ijkl');
    expect(out).toContain('api_key=');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('abcd1234efgh5678ijkl');
  });

  it('leaves normal text untouched', async () => {
    const { redactSecretsForTest } = await import('../src/main/utils/logger');
    expect(redactSecretsForTest('session started for user 42')).toBe(
      'session started for user 42'
    );
  });
});
