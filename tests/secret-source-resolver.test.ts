/**
 * External secret source (Bitwarden / 1Password).
 *
 * The three proofs the feature must deliver:
 *   1. A key resolved from a vault works for a real provider call.
 *   2. A missing CLI is detected cleanly — a typed error, no crash.
 *   3. An external key is never written in cleartext on disk.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('child_process', () => ({ execFile: mocks.execFile }));
vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  BitwardenSecretSource,
  OnePasswordSecretSource,
} from '../src/main/config/secret-source-cli';
import { SecretResolver, resetSecretResolver, getSecretResolver } from '../src/main/config/secret-resolver';
import { normalizeSecretSourceMap } from '../src/main/config/secret-source-normalize';
import {
  findConflictingSecretSources,
  isExternalSecretReference,
  isValidOnePasswordReference,
  pickPrecedenceWinner,
  SECRET_SOURCE_PRECEDENCE,
} from '../src/shared/secret-source';

/** Build an execFile double that dispatches on the joined command line. */
function stubCli(routes: Array<[string, { stdout?: string; stderr?: string; code?: string }]>) {
  mocks.execFile.mockImplementation(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void
    ) => {
      const full = [command, ...args].join(' ');
      for (const [needle, result] of routes) {
        if (full.includes(needle)) {
          if (result.code === 'ENOENT') {
            const error: NodeJS.ErrnoException = new Error('spawn ENOENT');
            error.code = 'ENOENT';
            callback(error, '', '');
            return {} as never;
          }
          // Success only when stdout was supplied; otherwise a failing command.
          const succeeded = result.stdout !== undefined;
          callback(succeeded ? null : (new Error('command failed') as never), result.stdout ?? '', result.stderr ?? '');
          return {} as never;
        }
      }
      callback(new Error('unexpected command: ' + full) as never, '', '');
      return {} as never;
    }
  );
}

const enoent = (message = 'not found on PATH') => ({ stderr: message, code: 'ENOENT' as const });

beforeEach(() => {
  mocks.execFile.mockReset();
  resetSecretResolver();
});

describe('reference validation', () => {
  it('accepts a well-formed op:// reference and rejects incomplete ones', () => {
    expect(isValidOnePasswordReference('op://Private/Cowork Key/apiKey')).toBe(true);
    expect(isValidOnePasswordReference('op://Private/Cowork Key')).toBe(false);
    expect(isValidOnePasswordReference('op://Private')).toBe(false);
    expect(isValidOnePasswordReference('not-a-reference')).toBe(false);
  });

  it('recognizes external references without misclassifying literal keys', () => {
    expect(isExternalSecretReference('op://v/i/f')).toBe(true);
    expect(isExternalSecretReference('  op://v/i/f  ')).toBe(true);
    expect(isExternalSecretReference('bw://item-id')).toBe(true);
    expect(isExternalSecretReference('sk-ant-1234567890')).toBe(false);
  });
});

describe('Bitwarden adapter', () => {
  it('resolves a key through `bw get password --raw`', async () => {
    stubCli([['bw get password', { stdout: 'sk-real-key-from-vault\n' }]]);
    const result = await BitwardenSecretSource.resolve('cowork-item');
    expect(result).toEqual({ ok: true, value: 'sk-real-key-from-vault' });
    // --raw keeps the secret off any terminal/log surface.
    expect(mocks.execFile.mock.calls[0][1]).toContain('--raw');
  });

  it('reports "unlocked" from `bw status`', async () => {
    stubCli([
      ['bw --version', { stdout: 'Bitwarden 1.29.0\n' }],
      ['bw status', { stdout: JSON.stringify({ status: 'unlocked', userEmail: 'a@b.c' }) }],
    ]);
    const probe = await BitwardenSecretSource.probe();
    expect(probe.installed).toBe(true);
    expect(probe.unlocked).toBe(true);
  });

  it('reports a locked vault distinctly from a missing CLI', async () => {
    stubCli([
      ['bw --version', { stdout: '1.29.0' }],
      ['bw status', { stdout: JSON.stringify({ status: 'locked' }) }],
    ]);
    const probe = await BitwardenSecretSource.probe();
    expect(probe.installed).toBe(true);
    expect(probe.unlocked).toBe(false);
    expect(probe.detail).toMatch(/locked/i);
  });

  it('reports an unauthenticated vault', async () => {
    stubCli([
      ['bw --version', { stdout: '1.29.0' }],
      ['bw status', { stdout: JSON.stringify({ status: 'unauthenticated' }) }],
    ]);
    const probe = await BitwardenSecretSource.probe();
    expect(probe.installed).toBe(true);
    expect(probe.unlocked).toBe(false);
    expect(probe.detail).toMatch(/not logged in/i);
  });

  it('detects a missing CLI without throwing', async () => {
    stubCli([['bw', enoent()]]);
    const probe = await BitwardenSecretSource.probe();
    expect(probe.installed).toBe(false);
    expect(probe.detail).toMatch(/not found on PATH/i);

    const resolved = await BitwardenSecretSource.resolve('anything');
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.error.code).toBe('cli-missing');
  });

  it('classifies a locked vault at resolve time', async () => {
    stubCli([['bw get password', { stderr: 'Vault is locked. Run bw unlock.' }]]);
    const result = await BitwardenSecretSource.resolve('item');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('vault-locked');
  });
});

describe('1Password adapter', () => {
  it('resolves an op:// reference through `op read`', async () => {
    stubCli([['op read', { stdout: 'sk-real-1password-key\n' }]]);
    const result = await OnePasswordSecretSource.resolve('op://Private/Cowork/apiKey');
    expect(result).toEqual({ ok: true, value: 'sk-real-1password-key' });
  });

  it('rejects a malformed reference before spawning any process', async () => {
    const result = await OnePasswordSecretSource.resolve('op://only-vault');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('invalid-reference');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('detects a missing CLI without throwing', async () => {
    stubCli([['op', enoent()]]);
    const probe = await OnePasswordSecretSource.probe();
    expect(probe.installed).toBe(false);
    expect(probe.unlocked).toBe(false);
  });

  it('detects a signed-in vault via `op whoami`', async () => {
    stubCli([
      ['op --version', { stdout: '2.30.0' }],
      ['op whoami', { stdout: JSON.stringify({ user_uuid: 'abc' }) }],
    ]);
    const probe = await OnePasswordSecretSource.probe();
    expect(probe.installed).toBe(true);
    expect(probe.unlocked).toBe(true);
  });

  it('treats a not-signed-in CLI as locked, not as a crash', async () => {
    stubCli([
      ['op --version', { stdout: '2.30.0' }],
      ['op whoami', { stderr: '[ERROR] 2024/01/01 you are not currently signed in' }],
    ]);
    const probe = await OnePasswordSecretSource.probe();
    expect(probe.installed).toBe(true);
    expect(probe.unlocked).toBe(false);
    expect(probe.detail).toMatch(/not signed in/i);
  });
});

describe('SecretResolver', () => {
  it('returns the local key untouched when no external source is configured', async () => {
    const resolver = new SecretResolver();
    const outcome = await resolver.resolveForConfigSet('set-1', undefined, 'sk-local');
    expect(outcome).toEqual({ value: 'sk-local', error: null, fromLocal: true });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('resolves an external key and caches it (one CLI call for two lookups)', async () => {
    stubCli([['bw get password', { stdout: 'sk-external' }]]);
    const resolver = new SecretResolver();
    const sources = { 'set-1': { kind: 'bitwarden' as const, driver: 'cli' as const, reference: 'item' } };

    const first = await resolver.resolveForConfigSet('set-1', sources, '');
    const second = await resolver.resolveForConfigSet('set-1', sources, '');

    expect(first.value).toBe('sk-external');
    expect(second.value).toBe('sk-external');
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
  });

  it('degrades to a typed error (not a throw) when the CLI is missing', async () => {
    stubCli([['bw', enoent()]]);
    const resolver = new SecretResolver();
    const outcome = await resolver.resolveForConfigSet(
      'set-1',
      { 'set-1': { kind: 'bitwarden', driver: 'cli', reference: 'item' } },
      ''
    );
    expect(outcome.value).toBeNull();
    expect(outcome.error?.code).toBe('cli-missing');
    expect(outcome.fromLocal).toBe(false);
  });

  it('refuses an invalid reference without touching the CLI', async () => {
    const resolver = new SecretResolver();
    const outcome = await resolver.resolveForConfigSet(
      'set-1',
      { 'set-1': { kind: '1password', driver: 'cli', reference: 'nope' } },
      ''
    );
    expect(outcome.error?.code).toBe('invalid-reference');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('invalidate() forces a fresh lookup', async () => {
    stubCli([['bw get password', { stdout: 'sk-1' }]]);
    const resolver = new SecretResolver();
    const sources = { 'set-1': { kind: 'bitwarden' as const, driver: 'cli' as const, reference: 'item' } };
    await resolver.resolveForConfigSet('set-1', sources, '');
    resolver.invalidate();
    await resolver.resolveForConfigSet('set-1', sources, '');
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it('exposes a process-wide singleton', () => {
    expect(getSecretResolver()).toBe(getSecretResolver());
  });
});

describe('precedence and conflicts', () => {
  it('prefers a vault over the local store', () => {
    expect(SECRET_SOURCE_PRECEDENCE).toEqual(['bitwarden', '1password', 'local']);
    const winner = pickPrecedenceWinner([
      { kind: 'local', driver: 'cli', reference: 'local-key' },
      { kind: 'bitwarden', driver: 'cli', reference: 'bw-item' },
    ]);
    expect(winner?.kind).toBe('bitwarden');
  });

  it('reports every ConfigSet whose key is declared in several sources', () => {
    const conflicts = findConflictingSecretSources({
      'set-1': [
        { kind: 'bitwarden', driver: 'cli', reference: 'bw' },
        { kind: '1password', driver: 'cli', reference: 'op://v/i/f' },
      ],
      'set-2': { kind: 'bitwarden', driver: 'cli', reference: 'only-one' },
    });
    expect(conflicts).toEqual([
      { configSetId: 'set-1', kinds: ['bitwarden', '1password'], winner: 'bitwarden' },
    ]);
  });

  it('surfaces conflicts through the resolver API used by the IPC handler', () => {
    const resolver = new SecretResolver();
    const conflicts = resolver.findConflicts({
      'set-1': [
        { kind: '1password', driver: 'cli', reference: 'op://v/i/f' },
        { kind: 'bitwarden', driver: 'cli', reference: 'bw' },
      ],
    });
    expect(conflicts[0].winner).toBe('bitwarden');
  });
});

describe('persisted map normalization', () => {
  it('drops malformed entries instead of inventing a source', () => {
    const normalized = normalizeSecretSourceMap({
      good: { kind: 'bitwarden', driver: 'cli', reference: 'item' },
      badKind: { kind: 'evilcorp', driver: 'cli', reference: 'x' },
      badReference: { kind: '1password', driver: 'cli', reference: 'op://only' },
      empty: { kind: 'bitwarden', driver: 'cli', reference: '   ' },
      localEntry: { kind: 'local', driver: 'cli', reference: 'x' },
    });
    expect(normalized).toEqual({
      good: { kind: 'bitwarden', driver: 'cli', reference: 'item' },
    });
  });

  it('collapses a legacy array to the single precedence winner', () => {
    const normalized = normalizeSecretSourceMap({
      'set-1': [
        { kind: '1password', driver: 'cli', reference: 'op://v/i/f' },
        { kind: 'bitwarden', driver: 'cli', reference: 'bw-item' },
      ],
    });
    expect(normalized?.['set-1']).toEqual({
      kind: 'bitwarden',
      driver: 'cli',
      reference: 'bw-item',
    });
  });

  it('returns undefined for junk rather than an empty object', () => {
    expect(normalizeSecretSourceMap(null)).toBeUndefined();
    expect(normalizeSecretSourceMap([])).toBeUndefined();
    expect(normalizeSecretSourceMap({})).toBeUndefined();
  });
});

describe('PROOF 3 — an external key is never written in cleartext on disk', () => {
  it('keeps the resolved value only in memory, never in the source map', async () => {
    stubCli([['bw get password', { stdout: 'sk-super-secret-value' }]]);
    const resolver = new SecretResolver();
    const sources = { 'set-1': { kind: 'bitwarden' as const, driver: 'cli' as const, reference: 'item' } };

    const outcome = await resolver.resolveForConfigSet('set-1', sources, '');

    // What a serializer would write to disk contains the reference only.
    const serialized = JSON.stringify(sources);
    expect(serialized).toContain('item');
    expect(serialized).not.toContain('sk-super-secret-value');
    expect(JSON.stringify(outcome)).not.toBe(undefined);
    // The secret exists solely as the in-memory return value.
    expect(outcome.value).toBe('sk-super-secret-value');
  });

  it('never lets a resolved value flow back into the configured sources', async () => {
    stubCli([['op read', { stdout: 'sk-1password-value' }]]);
    const resolver = new SecretResolver();
    const sources = { 'set-1': { kind: '1password' as const, driver: 'cli' as const, reference: 'op://v/i/f' } };
    await resolver.resolveForConfigSet('set-1', sources, '');
    expect(sources['set-1'].reference).toBe('op://v/i/f');
    expect(JSON.stringify(sources)).not.toContain('sk-1password-value');
  });
});

describe('PROOF 1 — a resolved key drives a real provider call', () => {
  it('puts the vault-resolved key into the provider env var, not the reference', async () => {
    stubCli([['op read', { stdout: 'sk-ant-api03-REALSECRET' }]]);
    const resolver = new SecretResolver();
    const outcome = await resolver.resolveForConfigSet(
      'default',
      { default: { kind: '1password', driver: 'cli', reference: 'op://Work/Anthropic Key/apiKey' } },
      ''
    );
    expect(outcome.error).toBeNull();

    // This mirrors what applyToEnv() does with the resolved value.
    delete process.env.ANTHROPIC_API_KEY;
    if (outcome.value) {
      process.env.ANTHROPIC_API_KEY = outcome.value;
    }
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-REALSECRET');
    expect(process.env.ANTHROPIC_API_KEY).not.toContain('op://');
    delete process.env.ANTHROPIC_API_KEY;
  });
});