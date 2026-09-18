import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  openPath: vi.fn(),
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  getLogFilePath: vi.fn(),
  getLogsDirectory: vi.fn(),
  getAllLogFiles: vi.fn(),
  closeLogFile: vi.fn(),
  setDevLogsEnabled: vi.fn(),
  isDevLogsEnabled: vi.fn(),
  configSet: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  shell: { openPath: mocks.openPath },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: mocks.log,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
  getLogFilePath: mocks.getLogFilePath,
  getLogsDirectory: mocks.getLogsDirectory,
  getAllLogFiles: mocks.getAllLogFiles,
  closeLogFile: mocks.closeLogFile,
  setDevLogsEnabled: mocks.setDevLogsEnabled,
  isDevLogsEnabled: mocks.isDevLogsEnabled,
}));

vi.mock('../src/main/config/config-store', () => ({
  configStore: { set: mocks.configSet },
}));

import { registerLogsIpcHandlers } from '../src/main/ipc/logs-handlers';

type Handler = (...args: unknown[]) => unknown;

function handler(channel: string): Handler {
  const call = mocks.handle.mock.calls.find(([name]) => name === channel);
  if (!call) throw new Error(`handler not registered: ${channel}`);
  return call[1] as Handler;
}

const CHANNELS = [
  'logs.getPath',
  'logs.getDirectory',
  'logs.getAll',
  'logs.open',
  'logs.clear',
  'logs.setEnabled',
  'logs.isEnabled',
  'logs.write',
];

describe('logs IPC handlers', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    registerLogsIpcHandlers();
    tempDir = mkdtempSync(join(tmpdir(), 'cowork-logs-ipc-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers every log channel', () => {
    expect(mocks.handle.mock.calls.map(([name]) => name)).toEqual(CHANNELS);
  });

  it('getPath and getDirectory return the logger values', () => {
    mocks.getLogFilePath.mockReturnValue('/data/app.log');
    mocks.getLogsDirectory.mockReturnValue('/data/logs');
    expect(handler('logs.getPath')(undefined)).toBe('/data/app.log');
    expect(handler('logs.getDirectory')(undefined)).toBe('/data/logs');
  });

  it('getPath degrades to null when the logger throws', () => {
    mocks.getLogFilePath.mockImplementation(() => {
      throw new Error('no userData yet');
    });
    expect(handler('logs.getPath')(undefined)).toBeNull();
    expect(mocks.logError).toHaveBeenCalled();
  });

  it('getAll returns the log files, or an empty list on failure', () => {
    mocks.getAllLogFiles.mockReturnValue([{ name: 'a.log', path: '/a', size: 1 }]);
    expect(handler('logs.getAll')(undefined)).toEqual([{ name: 'a.log', path: '/a', size: 1 }]);
    mocks.getAllLogFiles.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(handler('logs.getAll')(undefined)).toEqual([]);
  });

  it('open reveals the logs directory through the OS', async () => {
    mocks.getLogsDirectory.mockReturnValue('/data/logs');
    mocks.openPath.mockResolvedValue('');
    await expect(handler('logs.open')(undefined)).resolves.toEqual({ success: true });
    expect(mocks.openPath).toHaveBeenCalledWith('/data/logs');
  });

  it('open reports failure when the OS cannot open the directory', async () => {
    mocks.getLogsDirectory.mockReturnValue('/data/logs');
    mocks.openPath.mockRejectedValue(new Error('no app for directories'));
    const result = (await handler('logs.open')(undefined)) as { success: boolean; error?: string };
    expect(result).toEqual({ success: false, error: 'no app for directories' });
  });

  it('clear closes the log file and deletes every log file for real', async () => {
    const first = join(tempDir, 'first.log');
    const second = join(tempDir, 'second.log');
    writeFileSync(first, 'one');
    writeFileSync(second, 'two');
    mocks.getAllLogFiles.mockReturnValue([
      { name: 'first.log', path: first, size: 3 },
      { name: 'second.log', path: second, size: 3 },
    ]);

    const result = (await handler('logs.clear')(undefined)) as {
      success: boolean;
      deletedCount?: number;
    };

    expect(mocks.closeLogFile).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, deletedCount: 2 });
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it('setEnabled persists the flag and applies it to the logger', async () => {
    const result = (await handler('logs.setEnabled')(undefined, true)) as {
      success: boolean;
      enabled?: boolean;
    };
    expect(mocks.setDevLogsEnabled).toHaveBeenCalledWith(true);
    expect(mocks.configSet).toHaveBeenCalledWith('enableDevLogs', true);
    expect(result).toEqual({ success: true, enabled: true });
  });

  it('isEnabled reports the current dev-logs flag', () => {
    mocks.isDevLogsEnabled.mockReturnValue(true);
    expect(handler('logs.isEnabled')(undefined)).toEqual({ success: true, enabled: true });
  });

  it('write routes each level to the right logger function with array payloads', () => {
    expect(handler('logs.write')(undefined, 'warn', ['a', 'b'])).toEqual({ success: true });
    expect(mocks.logWarn).toHaveBeenCalledWith('a', 'b');
    expect(handler('logs.write')(undefined, 'error', ['x'])).toEqual({ success: true });
    expect(mocks.logError).toHaveBeenCalledWith('x');
    expect(handler('logs.write')(undefined, 'info', ['y'])).toEqual({ success: true });
    expect(mocks.log).toHaveBeenCalledWith('y');
  });

  it('write tolerates the legacy spread form without crashing', () => {
    expect(handler('logs.write')(undefined, 'warn', 'p', 'q')).toEqual({ success: true });
    expect(mocks.logWarn).toHaveBeenCalledWith('p', 'q');
  });
});