/**
 * The collector is the only place that touches the outside world (config store,
 * sandbox adapter, filesystem, git). These tests keep it on a leash: it must map
 * observed facts faithfully and must never throw while diagnosing.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  userDataPath: '/tmp',
  store: {
    getAll: vi.fn(),
    get: vi.fn(),
    getConfigSetProjectedConfig: vi.fn(),
    hasUsableCredentials: vi.fn(),
  },
  adapter: { isWSL: false, isLima: true },
  execFileSync: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataPath },
}));

vi.mock('../src/main/config/config-store', () => ({ configStore: mocks.store }));

vi.mock('../src/main/sandbox/sandbox-adapter', () => ({
  getSandboxAdapter: () => mocks.adapter,
}));

vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }));

import {
  collectHealthFacts,
  collectHealthReport,
  resolveCredentialFacts,
} from '../src/main/utils/health-report-collector';

const SET_1 = {
  id: 'set-1',
  name: 'Fast',
  provider: 'anthropic',
  activeProfileKey: 'anthropic',
  profiles: { anthropic: { model: 'claude-haiku', apiKey: 'sk-x' } },
};
const SET_2 = {
  id: 'set-2',
  name: 'Deep',
  provider: 'anthropic',
  activeProfileKey: 'anthropic',
  profiles: { anthropic: { model: 'claude-opus', apiKey: 'sk-x' } },
};

function primeStore(): void {
  mocks.store.getAll.mockReturnValue({
    activeConfigSetId: 'set-1',
    configSets: [SET_1, SET_2],
  });
  mocks.store.get.mockImplementation((key: string) => {
    if (key === 'sandboxEnabled') return true;
    if (key === 'defaultWorkdir') return '/tmp';
    return undefined;
  });
  mocks.store.getConfigSetProjectedConfig.mockReturnValue({ provider: 'anthropic', apiKey: 'sk-x' });
  mocks.store.hasUsableCredentials.mockReturnValue(true);
  mocks.execFileSync.mockReturnValue('git version 2.42.0\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adapter = { isWSL: false, isLima: true };
  primeStore();
});

describe('resolveCredentialFacts', () => {
  it('projects the active ConfigSet and probes its credentials', () => {
    const credentials = resolveCredentialFacts({});
    expect(mocks.store.getConfigSetProjectedConfig).toHaveBeenCalledWith('set-1', 'claude-haiku');
    expect(credentials).toEqual({
      credentialsUsable: true,
      provider: 'anthropic',
      model: 'claude-haiku',
      configSetName: 'Fast',
    });
  });

  it('lets a session override the ConfigSet being probed', () => {
    resolveCredentialFacts({
      session: {
        id: 's1',
        title: 't',
        status: 'idle',
        mountedPaths: [],
        allowedTools: [],
        memoryEnabled: false,
        configSetId: 'set-2',
        configModelId: 'claude-haiku',
        createdAt: 0,
        updatedAt: 0,
      },
    });
    expect(mocks.store.getConfigSetProjectedConfig).toHaveBeenCalledWith('set-2', 'claude-haiku');
  });

  it('degrades to unusable instead of throwing when the store explodes', () => {
    mocks.store.getAll.mockImplementation(() => {
      throw new Error('store unavailable');
    });
    expect(resolveCredentialFacts({})).toEqual({
      credentialsUsable: false,
      provider: '',
      model: '',
      configSetName: '',
    });
  });
});

describe('collectHealthFacts', () => {
  it('observes the workspace, sandbox, storage and tooling', () => {
    const facts = collectHealthFacts({});
    expect(facts.workingDir).toBe('/tmp');
    expect(facts.workingDirExists).toBe(true);
    expect(facts.sandboxEnabled).toBe(true);
    expect(facts.sandboxBackend).toBe('lima');
    expect(facts.storageWritable).toBe(true);
    expect(facts.storagePath).toBe('/tmp');
    expect(facts.gitVersion).toBe('git version 2.42.0');
  });

  it('prefers the session working directory over the default one', () => {
    const facts = collectHealthFacts({
      session: {
        id: 's1',
        title: 't',
        status: 'idle',
        cwd: '/tmp',
        mountedPaths: [],
        allowedTools: [],
        memoryEnabled: false,
        createdAt: 0,
        updatedAt: 0,
      },
    });
    expect(facts.workingDir).toBe('/tmp');
    expect(facts.workingDirExists).toBe(true);
  });

  it('reports a missing workspace as non-existent rather than crashing', () => {
    mocks.store.get.mockImplementation((key: string) => {
      if (key === 'defaultWorkdir') return '/definitely/missing/cowork-path';
      return undefined;
    });
    const facts = collectHealthFacts({});
    expect(facts.workingDirExists).toBe(false);
  });

  it('reports no sandbox backend when the sandbox is disabled', () => {
    mocks.store.get.mockReturnValue(undefined);
    const facts = collectHealthFacts({});
    expect(facts.sandboxEnabled).toBe(false);
    expect(facts.sandboxBackend).toBeNull();
  });

  it('treats a failing git probe as missing', () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(collectHealthFacts({}).gitVersion).toBeNull();
  });

  it('treats a blank git output as missing', () => {
    mocks.execFileSync.mockReturnValue('   ');
    expect(collectHealthFacts({}).gitVersion).toBeNull();
  });
});

describe('collectHealthReport', () => {
  it('returns a healthy report when every probe succeeds', () => {
    const report = collectHealthReport({});
    expect(report.status).toBe('ok');
    expect(report.checks.map((check) => check.id)).toContain('credentials');
  });

  it('still returns a report when the config store is unavailable', () => {
    mocks.store.getAll.mockImplementation(() => {
      throw new Error('store unavailable');
    });
    const report = collectHealthReport({});
    expect(report.status).toBe('fail');
    expect(report.facts.credentialsUsable).toBe(false);
  });
});
