import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `logAlways` exists for one-shot startup diagnostics.
 *
 * `enableDevLogs` defaults to false and boot applies it *before* the boot report
 * is written, so emitting that report through `log()` dropped it in every
 * default install and the `boot-perf` instrumentation produced nothing. These
 * tests run against the fallback userData directory, so they exercise the real
 * write path rather than a mocked one.
 */
describe('logAlways persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists an always-on line while the developer-logs gate drops info lines', async () => {
    vi.doMock('electron', () => ({ app: {} }));

    const logger = await import('../src/main/utils/logger');
    logger.log('opens the file');
    const logFilePath = logger.getLogFilePath();
    expect(logFilePath).toBeTruthy();

    logger.setDevLogsEnabled(false);
    logger.log('[BootPerf] dropped by the gate');
    logger.logAlways('[BootPerf] kept by design');

    logger.closeLogFile();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = fs.readFileSync(logFilePath!, 'utf8');
    expect(content).toContain('[BootPerf] kept by design');
    expect(content).not.toContain('[BootPerf] dropped by the gate');
  });

  it('keeps one file per session when developer logs are disabled', async () => {
    vi.doMock('electron', () => ({ app: {} }));

    const logger = await import('../src/main/utils/logger');
    logger.log('opens the file');
    const logFilePath = logger.getLogFilePath();
    expect(logFilePath).toBeTruthy();

    // Disabling must not destroy the stream. Boot has already opened the file by
    // this point, so closing here never produced "no log file" — it only split
    // one session across two, because the next always-persisted line reopened a
    // second one and left the startup context orphaned in the first.
    logger.setDevLogsEnabled(false);
    expect(logger.getLogFilePath()).toBe(logFilePath);

    logger.logWarn('a warning after disabling');
    logger.logAlways('a startup diagnostic after disabling');

    logger.closeLogFile();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = fs.readFileSync(logFilePath!, 'utf8');
    expect(content).toContain('a warning after disabling');
    expect(content).toContain('a startup diagnostic after disabling');
  });
});
