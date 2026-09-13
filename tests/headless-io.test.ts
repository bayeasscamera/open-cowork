import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for src/main/cli/headless-io.ts
 *
 * Since headless-io has no Electron dependency, we can import and test it
 * directly under the vitest mock of Electron (provided by vitest.config).
 */

// We need to mock electron since the module imports from renderer/types which
// may transitively reference Electron. The mock is already in vitest setup.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test-user-data',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: () => true,
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    dock: { setMenu: vi.fn() },
    whenReady: () => Promise.resolve(),
    getName: () => 'test',
    name: 'test',
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  shell: {},
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
  Tray: vi.fn(),
}));

describe('headless-io', () => {
  describe('parseHeadlessArgs', () => {
    let originalArgv: string[];

    beforeEach(() => {
      originalArgv = process.argv;
    });

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('detects --headless flag', async () => {
      process.argv = ['node', 'app', '--headless'];
      const { parseHeadlessArgs } = await import('../src/main/cli/headless-io');
      const args = parseHeadlessArgs();
      expect(args.headless).toBe(true);
      expect(args.prompt).toBeNull();
      expect(args.autoApprove).toBe(false);
      expect(args.mode).toBe('rpc'); // default when no prompt
    });

    it('parses -p flag', async () => {
      process.argv = ['node', 'app', '--headless', '-p', 'hello world'];
      const { parseHeadlessArgs } = await import('../src/main/cli/headless-io');
      const args = parseHeadlessArgs();
      expect(args.prompt).toBe('hello world');
      expect(args.mode).toBe('json'); // default when prompt given
    });

    it('parses --prompt flag', async () => {
      process.argv = ['node', 'app', '--headless', '--prompt', 'test prompt'];
      const { parseHeadlessArgs } = await import('../src/main/cli/headless-io');
      const args = parseHeadlessArgs();
      expect(args.prompt).toBe('test prompt');
    });

    it('parses --cwd flag', async () => {
      process.argv = ['node', 'app', '--headless', '--cwd', '/tmp/test'];
      const { parseHeadlessArgs } = await import('../src/main/cli/headless-io');
      const args = parseHeadlessArgs();
      expect(args.cwd).toBe('/tmp/test');
    });

    it('detects --auto-approve flag', async () => {
      process.argv = ['node', 'app', '--headless', '--auto-approve', '-p', 'test'];
      const { parseHeadlessArgs } = await import('../src/main/cli/headless-io');
      const args = parseHeadlessArgs();
      expect(args.autoApprove).toBe(true);
    });

    it('parses --mode rpc', async () => {
      process.argv = ['node', 'app', '--headless', '--mode', 'rpc'];
      const { parseHeadlessArgs } = await import('../src/main/cli/headless-io');
      const args = parseHeadlessArgs();
      expect(args.mode).toBe('rpc');
    });

    it('parses --mode json', async () => {
      process.argv = ['node', 'app', '--headless', '--mode', 'json'];
      const { parseHeadlessArgs } = await import('../src/main/cli/headless-io');
      const args = parseHeadlessArgs();
      expect(args.mode).toBe('json');
    });

    it('defaults headless to false when flag absent', async () => {
      process.argv = ['node', 'app'];
      const { parseHeadlessArgs } = await import('../src/main/cli/headless-io');
      const args = parseHeadlessArgs();
      expect(args.headless).toBe(false);
    });
  });

  describe('createHeadlessSendToRenderer', () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      writeSpy.mockRestore();
    });

    it('writes stream.partial as JSONL', async () => {
      const { createHeadlessSendToRenderer } = await import('../src/main/cli/headless-io');
      const send = createHeadlessSendToRenderer();
      send({
        type: 'stream.partial',
        payload: { sessionId: 'test-123', delta: 'Hello' },
      });

      expect(writeSpy).toHaveBeenCalledTimes(1);
      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.type).toBe('stream.partial');
      expect(parsed.sessionId).toBe('test-123');
      expect(parsed.text).toBe('Hello');
    });

    it('writes session.status as JSONL', async () => {
      const { createHeadlessSendToRenderer } = await import('../src/main/cli/headless-io');
      const send = createHeadlessSendToRenderer();
      send({
        type: 'session.status',
        payload: { sessionId: 'abc', status: 'idle' },
      });

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.type).toBe('session.status');
      expect(parsed.status).toBe('idle');
    });

    it('writes error events as JSONL', async () => {
      const { createHeadlessSendToRenderer } = await import('../src/main/cli/headless-io');
      const send = createHeadlessSendToRenderer();
      send({
        type: 'error',
        payload: { message: 'something broke', code: 'CONFIG_REQUIRED_ACTIVE_SET' },
      });

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.type).toBe('error');
      expect(parsed.message).toBe('something broke');
    });

    it('forwards unknown event types as passthrough', async () => {
      const { createHeadlessSendToRenderer } = await import('../src/main/cli/headless-io');
      const send = createHeadlessSendToRenderer();
      send({
        type: 'new-session',
      } as unknown as Parameters<typeof send>[0]);

      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.type).toBe('new-session');
    });
  });

  describe('redirectConsoleToStderr', () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let origLog: typeof console.log;
    let origWarn: typeof console.warn;
    let origInfo: typeof console.info;

    beforeEach(() => {
      origLog = console.log;
      origWarn = console.warn;
      origInfo = console.info;
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      console.log = origLog;
      console.warn = origWarn;
      console.info = origInfo;
      stderrSpy.mockRestore();
    });

    it('redirects console.log to stderr', async () => {
      const { redirectConsoleToStderr } = await import('../src/main/cli/headless-io');
      redirectConsoleToStderr();
      console.log('test message');
      expect(stderrSpy).toHaveBeenCalled();
      const output = stderrSpy.mock.calls[0][0] as string;
      expect(output).toContain('test message');
    });
  });

  describe('emitSessionStarted / emitSessionEnded', () => {
    let writeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      writeSpy.mockRestore();
    });

    it('emits session.started', async () => {
      const { emitSessionStarted } = await import('../src/main/cli/headless-io');
      emitSessionStarted('sid-1');
      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.type).toBe('session.started');
      expect(parsed.sessionId).toBe('sid-1');
    });

    it('emits session.ended', async () => {
      const { emitSessionEnded } = await import('../src/main/cli/headless-io');
      emitSessionEnded('sid-2');
      const output = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output.trim());
      expect(parsed.type).toBe('session.ended');
      expect(parsed.sessionId).toBe('sid-2');
    });
  });
});
