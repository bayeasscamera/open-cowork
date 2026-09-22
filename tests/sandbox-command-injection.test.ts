/**
 * Tests for sandbox command injection fixes.
 *
 * Validates that:
 * 1. sessionId is validated against a strict allowlist pattern
 * 2. WSL distro names are validated before use in shell commands
 * 3. Lima execLimaShellWithRetry uses execFileAsync (no host shell)
 * 4. The in-VM agent path is checked for shell metacharacters
 * 5. rm -rf verifies real path is within sandbox root before deletion
 * 6. SandboxSync.wslExec is async and captures stderr
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const sandboxSyncPath = path.resolve(process.cwd(), 'src/main/sandbox/sandbox-sync.ts');
const wslBridgePath = path.resolve(process.cwd(), 'src/main/sandbox/wsl-bridge.ts');
const limaBridgePath = path.resolve(process.cwd(), 'src/main/sandbox/lima-bridge.ts');
const sandboxVmBridgePath = path.resolve(process.cwd(), 'src/main/sandbox/sandbox-vm-bridge.ts');
const limaSyncPath = path.resolve(process.cwd(), 'src/main/sandbox/lima-sync.ts');
const syncHelpersPath = path.resolve(process.cwd(), 'src/main/sandbox/sync-helpers.ts');
const sandboxVmSyncPath = path.resolve(process.cwd(), 'src/main/sandbox/sandbox-vm-sync.ts');

const sandboxSyncSrc = fs.readFileSync(sandboxSyncPath, 'utf8');
const wslBridgeSrc = fs.readFileSync(wslBridgePath, 'utf8');
const limaBridgeSrc = fs.readFileSync(limaBridgePath, 'utf8');
const sandboxVmBridgeSrc = fs.readFileSync(sandboxVmBridgePath, 'utf8');
const limaSyncSrc = fs.readFileSync(limaSyncPath, 'utf8');
const syncHelpersSrc = fs.readFileSync(syncHelpersPath, 'utf8');
const sandboxVmSyncSrc = fs.readFileSync(sandboxVmSyncPath, 'utf8');

describe('sync-helpers sessionId validation', () => {
  it('defines a validateSessionId function with strict alphanumeric pattern', () => {
    expect(syncHelpersSrc).toContain('if (!/^[a-zA-Z0-9_-]+$/.test(sessionId))');
    expect(syncHelpersSrc).toContain('throw new Error(`Invalid sessionId: ${sessionId}`)');
  });
});

describe('sandbox-vm-sync input validation', () => {
  it('validates the sessionId before running any VM command', () => {
    const initStart = sandboxVmSyncSrc.indexOf('protected static async initSyncCore(');
    const validateCall = sandboxVmSyncSrc.indexOf('validateSessionId(sessionId)', initStart);
    const firstExec = sandboxVmSyncSrc.indexOf('this.execCommand(', initStart);
    expect(validateCall).toBeGreaterThan(initStart);
    expect(validateCall).toBeLessThan(firstExec);
  });

  it('validates the VM context before running any VM command', () => {
    const initStart = sandboxVmSyncSrc.indexOf('protected static async initSyncCore(');
    const validateCall = sandboxVmSyncSrc.indexOf('this.validateContext(context)', initStart);
    const firstExec = sandboxVmSyncSrc.indexOf('this.execCommand(', initStart);
    expect(validateCall).toBeGreaterThan(initStart);
    expect(validateCall).toBeLessThan(firstExec);
  });

  it('runs distro validation for WSL through the context hook', () => {
    expect(sandboxSyncSrc).toContain('validateDistroName(context as string)');
  });
});

describe('wsl-bridge distro name validation', () => {
  it('has validateDistroName method with strict pattern', () => {
    expect(wslBridgeSrc).toContain('private static validateDistroName(distro: string)');
    expect(wslBridgeSrc).toContain('if (!/^[a-zA-Z0-9\\-_.]+$/.test(distro))');
  });

  it('validates distro at the top of installNodeInWSL', () => {
    const methodStart = wslBridgeSrc.indexOf('static async installNodeInWSL(distro: string)');
    const validateCall = wslBridgeSrc.indexOf('WSLBridge.validateDistroName(distro)', methodStart);
    expect(validateCall).toBeGreaterThan(methodStart);
    // Should be within the first few lines of the method
    expect(validateCall - methodStart).toBeLessThan(100);
  });

  it('validates distro at the top of installNodeViaNvm', () => {
    const methodStart = wslBridgeSrc.indexOf('static async installNodeViaNvm(distro: string)');
    const validateCall = wslBridgeSrc.indexOf('WSLBridge.validateDistroName(distro)', methodStart);
    expect(validateCall).toBeGreaterThan(methodStart);
    expect(validateCall - methodStart).toBeLessThan(100);
  });

  it('validates distro at the top of installPythonInWSL', () => {
    const methodStart = wslBridgeSrc.indexOf('static async installPythonInWSL(distro: string)');
    const validateCall = wslBridgeSrc.indexOf('WSLBridge.validateDistroName(distro)', methodStart);
    expect(validateCall).toBeGreaterThan(methodStart);
    expect(validateCall - methodStart).toBeLessThan(100);
  });

  it('validates distro at the top of installClaudeCodeInWSL', () => {
    const methodStart = wslBridgeSrc.indexOf('static async installClaudeCodeInWSL(distro: string)');
    const validateCall = wslBridgeSrc.indexOf('WSLBridge.validateDistroName(distro)', methodStart);
    expect(validateCall).toBeGreaterThan(methodStart);
    expect(validateCall - methodStart).toBeLessThan(100);
  });

  it('validates distro in installSkillDependencies', () => {
    const methodStart = wslBridgeSrc.indexOf(
      'static async installSkillDependencies(distro: string)'
    );
    const validateCall = wslBridgeSrc.indexOf('WSLBridge.validateDistroName(distro)', methodStart);
    expect(validateCall).toBeGreaterThan(methodStart);
  });

  it('validates distro in installPipInWSL', () => {
    const methodStart = wslBridgeSrc.indexOf('static async installPipInWSL(distro: string)');
    const validateCall = wslBridgeSrc.indexOf('WSLBridge.validateDistroName(distro)', methodStart);
    expect(validateCall).toBeGreaterThan(methodStart);
  });
});

describe('lima-bridge execLimaShellWithRetry uses execFileAsync', () => {
  it('imports execFile from child_process', () => {
    expect(limaBridgeSrc).toMatch(/import\s*\{[^}]*execFile[^}]*\}\s*from\s*'child_process'/);
  });

  it('creates execFileAsync via promisify', () => {
    expect(limaBridgeSrc).toContain('const execFileAsync = promisify(execFile)');
  });

  it('uses execFileAsync with argument array in execLimaShellWithRetry', () => {
    const fnStart = limaBridgeSrc.indexOf('const execLimaShellWithRetry');
    const fnEnd = limaBridgeSrc.indexOf('};', fnStart + 100);
    const fnBody = limaBridgeSrc.substring(fnStart, fnEnd);

    // Should use execFileAsync, not execAsync
    expect(fnBody).toContain('execFileAsync(');
    expect(fnBody).not.toContain('execAsync(');

    // Should pass arguments as array, not string interpolation
    expect(fnBody).toContain("['shell', LIMA_INSTANCE_NAME, '--', 'bash', '-c', command]");
  });
});

describe('sandbox vm bridge agent path metacharacter check', () => {
  it('validates the resolved VM agent path for shell metacharacters before use', () => {
    const startAgentStart = sandboxVmBridgeSrc.indexOf('async startAgent()');
    const startAgentEnd = sandboxVmBridgeSrc.indexOf('waitForAgentReady()', startAgentStart);
    const startAgentBody = sandboxVmBridgeSrc.substring(startAgentStart, startAgentEnd);

    // Should check for metacharacters
    expect(startAgentBody).toContain('/[;&|`$(){}]/.test(vmAgentPath)');
    expect(startAgentBody).toContain('throw new Error(`Invalid agent path: ${vmAgentPath}`)');
  });
});

describe('rm -rf symlink protection', () => {
  it('verifies realpath before rm -rf in the shared sync base', () => {
    const cleanupStart = sandboxVmSyncSrc.indexOf('static async cleanup(sessionId: string)');
    const cleanupEnd = sandboxVmSyncSrc.indexOf('Cleanup failed:', cleanupStart);
    const cleanupBody = sandboxVmSyncSrc.substring(cleanupStart, cleanupEnd);

    expect(cleanupBody).toContain('realpath');
    expect(cleanupBody).toContain('isRealPathWithinSandboxRoot(realPath, session.sandboxPath)');
    expect(cleanupBody).toContain('Refusing to delete');
    // The containment check must happen before the deletion command is built
    expect(cleanupBody.indexOf('isRealPathWithinSandboxRoot')).toBeLessThan(
      cleanupBody.indexOf('rm -rf')
    );
    expect(syncHelpersSrc).toContain(SANDBOX_ROOT_CHECK);
  });

  it('routes both VM backends through the shared cleanup', () => {
    expect(sandboxSyncSrc).toContain('extends SandboxVmSync');
    expect(limaSyncSrc).toContain('extends SandboxVmSync');
  });
});

// Helper: the cleanup must verify the resolved path starts within the sandbox root
const SANDBOX_ROOT_CHECK = 'startsWith(';
describe('sandbox-sync wslExec is async with stderr capture', () => {
  it('does not use execFileSync', () => {
    expect(sandboxSyncSrc).not.toContain('execFileSync');
  });

  it('imports execFile and promisify for async execution', () => {
    expect(sandboxSyncSrc).toContain("import { execFile } from 'child_process'");
    expect(sandboxSyncSrc).toContain("import { promisify } from 'util'");
    expect(sandboxSyncSrc).toContain('const execFileAsync = promisify(execFile)');
  });

  it('uses execFileAsync in wslExec', () => {
    const wslExecStart = sandboxSyncSrc.indexOf('private static async wslExec(');
    const wslExecEnd = sandboxSyncSrc.indexOf(
      '}',
      sandboxSyncSrc.indexOf('return { stdout:', wslExecStart)
    );
    const wslExecBody = sandboxSyncSrc.substring(wslExecStart, wslExecEnd);

    expect(wslExecBody).toContain('await execFileAsync(');
    expect(wslExecBody).not.toContain('execFileSync');
  });

  it('captures and logs stderr', () => {
    const wslExecStart = sandboxSyncSrc.indexOf('private static async wslExec(');
    const wslExecEnd = sandboxSyncSrc.indexOf(
      '}',
      sandboxSyncSrc.indexOf('return { stdout:', wslExecStart)
    );
    const wslExecBody = sandboxSyncSrc.substring(wslExecStart, wslExecEnd);

    expect(wslExecBody).toContain('result.stderr');
    // Stderr should not be hardcoded as empty string
    expect(wslExecBody).not.toContain("stderr: ''");
  });
});
