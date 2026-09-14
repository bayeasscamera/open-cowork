import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

import { writeMCPLog } from '../mcp-logger.js';
import { PLATFORM } from './state.js';

const execFileAsync = promisify(execFile);

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function getResourcesDirCandidates(): string[] {
  const candidates: string[] = [];

  // If Electron main process passes resourcesPath into env for spawned MCP servers
  const envResources = process.env.OPEN_COWORK_RESOURCES_PATH;
  if (envResources) candidates.push(envResources);

  // Packaged: .../Contents/Resources/mcp -> .../Contents/Resources
  candidates.push(path.resolve(__dirname, '..'));

  // Dev (running bundled JS from dist-mcp): .../dist-mcp -> .../resources
  candidates.push(path.resolve(__dirname, '..', 'resources'));

  // Dev (running TS from src/main/mcp): .../src/main/mcp -> .../resources
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'resources'));

  // Dedupe
  return [...new Set(candidates)];
}

export async function resolveBundledExecutable(relativeFromResources: string): Promise<string | null> {
  for (const resourcesDir of getResourcesDirCandidates()) {
    const candidate = path.join(resourcesDir, relativeFromResources);
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

export let cachedCliclickPath: string | null | undefined;

export async function resolveCliclickPath(): Promise<string | null> {
  if (cachedCliclickPath !== undefined) return cachedCliclickPath;
  if (PLATFORM !== 'darwin') {
    cachedCliclickPath = null;
    return null;
  }

  // 1) Explicit override (useful for debugging)
  const envOverride = process.env.OPEN_COWORK_CLICLICK_PATH;
  if (envOverride && (await pathExists(envOverride))) {
    cachedCliclickPath = envOverride;
    return envOverride;
  }

  // 2) 内置随应用打包（推荐）
  // 打包布局：Resources/tools/darwin-{arch}/bin/cliclick
  // 旧版布局：Resources/tools/bin/cliclick
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const archBundled = await resolveBundledExecutable(
    path.join('tools', `darwin-${arch}`, 'bin', 'cliclick')
  );
  const legacyBundled = await resolveBundledExecutable(path.join('tools', 'bin', 'cliclick'));
  const bundled = archBundled || legacyBundled;
  if (bundled) {
    cachedCliclickPath = bundled;
    return bundled;
  }

  // 3) Common Homebrew locations (packaged apps may have limited PATH)
  const commonLocations = ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick'];
  for (const p of commonLocations) {
    if (await pathExists(p)) {
      cachedCliclickPath = p;
      return p;
    }
  }

  // 4) PATH lookup
  try {
    const { stdout } = await executeCommandSafe('/usr/bin/which', ['cliclick'], { timeout: 2000 });
    const whichPath = stdout.trim();
    if (whichPath) {
      cachedCliclickPath = whichPath;
      return whichPath;
    }
  } catch {
    // ignore
  }

  cachedCliclickPath = null;
  return null;
}

export function normalizeModifierKeys(modifiers: string[]): string[] {
  const modifierMap: Record<string, string> = {
    command: 'cmd',
    cmd: 'cmd',
    shift: 'shift',
    option: 'alt',
    alt: 'alt',
    control: 'ctrl',
    ctrl: 'ctrl',
    'control/ctrl': 'ctrl',
    'command/cmd': 'cmd',
    'option/alt': 'alt',
  };

  return modifiers.map((m) => modifierMap[m.toLowerCase()]).filter((m): m is string => Boolean(m));
}

/**
 * Format coordinates for cliclick command.
 * cliclick requires a '=' prefix before negative coordinates.
 * For example: c:=-1000,500 instead of c:-1000,500
 * @param x X coordinate
 * @param y Y coordinate
 * @returns Formatted coordinate string like "500,300" or "=-1000,500"
 */
export function formatCliclickCoords(x: number, y: number): string {
  // If either coordinate is negative, we need the '=' prefix
  if (x < 0 || y < 0) {
    return `=${x},${y}`;
  }
  return `${x},${y}`;
}

export type PythonExec = {
  python: string;
  pythonRoot: string;
  env: NodeJS.ProcessEnv;
};

export let cachedPythonExec: PythonExec | null | undefined;

// Check if we're in dev environment
export function isDevEnvironment(): boolean {
  // MCP servers run as child processes — cannot use Electron's app.isPackaged
  // Use VITE_DEV_SERVER_URL (set during dev) or script path heuristic
  const isDev = !!process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development';
  writeMCPLog(`[isDevEnvironment] isDev=${isDev}`, 'Python Resolve');
  return isDev;
}

export async function resolvePythonExec(): Promise<PythonExec | null> {
  if (cachedPythonExec !== undefined) {
    writeMCPLog(
      `[resolvePythonExec] Using cached Python: ${cachedPythonExec?.python}`,
      'Python Resolve'
    );
    return cachedPythonExec;
  }

  writeMCPLog('[resolvePythonExec] Resolving Python executable...', 'Python Resolve');
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  const isDev = isDevEnvironment();

  writeMCPLog(`[resolvePythonExec] Dev environment: ${isDev}`, 'Python Resolve');
  if (isDev) {
    writeMCPLog(
      `[resolvePythonExec] Dev mode: Will prioritize current terminal Python`,
      'Python Resolve'
    );
    writeMCPLog(
      `[resolvePythonExec] Current PATH: ${process.env.PATH?.substring(0, 200) || 'not set'}...`,
      'Python Resolve'
    );
    writeMCPLog(
      `[resolvePythonExec] CONDA_PREFIX: ${process.env.CONDA_PREFIX || 'not set'}`,
      'Python Resolve'
    );
  }

  // 1) Explicit override (useful for debugging)
  const envPython = process.env.OPEN_COWORK_PYTHON_PATH;
  const envPythonHome = process.env.OPEN_COWORK_PYTHON_HOME;
  if (envPython && (await pathExists(envPython))) {
    writeMCPLog(`[resolvePythonExec] Found explicit override: ${envPython}`, 'Python Resolve');
    const pythonRoot = envPythonHome || path.resolve(envPython, '..', '..');
    const extraSite = path.join(pythonRoot, 'site-packages');
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      PYTHONHOME: pythonRoot,
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUTF8: '1',
    };
    if (await pathExists(extraSite)) {
      env.PYTHONPATH = [extraSite, baseEnv.PYTHONPATH].filter(Boolean).join(path.delimiter);
    }
    cachedPythonExec = { python: envPython, pythonRoot, env };
    writeMCPLog(
      `[resolvePythonExec] Using explicit override Python: ${envPython}`,
      'Python Resolve'
    );
    return cachedPythonExec;
  }

  // In dev environment, use current terminal's Python (e.g., conda environment)
  if (isDev) {
    writeMCPLog(
      '[resolvePythonExec] Dev mode: Attempting to find Python in current PATH',
      'Python Resolve'
    );
    // Try to find python3 in current PATH
    try {
      const whichCmd = PLATFORM === 'win32' ? 'where' : 'which';
      const pythonArg = PLATFORM === 'win32' ? 'python' : 'python';
      writeMCPLog(
        `[resolvePythonExec] Dev mode: Running command: ${whichCmd} ${pythonArg}`,
        'Python Resolve'
      );
      const { stdout } = await executeCommandSafe(whichCmd, [pythonArg], { timeout: 2000 });
      const pythonPath = stdout.trim().split(/\r?\n/).filter(Boolean)[0];
      writeMCPLog(
        `[resolvePythonExec] Dev mode: which/where result: ${pythonPath}`,
        'Python Resolve'
      );

      if (pythonPath && (await pathExists(pythonPath))) {
        writeMCPLog(
          `[resolvePythonExec] Dev mode: Found Python at: ${pythonPath}`,
          'Python Resolve'
        );
        // In dev mode, use the Python from current environment without overriding PYTHONHOME
        // This preserves conda/venv environment settings
        cachedPythonExec = {
          python: pythonPath,
          pythonRoot: path.resolve(pythonPath, '..', '..'),
          env: {
            ...baseEnv, // Keep all current environment variables (including conda settings)
            // Don't set PYTHONHOME in dev mode to preserve conda/venv environment
            PYTHONNOUSERSITE: '1',
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUTF8: '1',
          },
        };
        writeMCPLog(
          `[resolvePythonExec] Dev mode: Using Python from PATH: ${pythonPath}`,
          'Python Resolve'
        );
        writeMCPLog(
          `[resolvePythonExec] Dev mode: Preserving environment (CONDA_PREFIX=${process.env.CONDA_PREFIX || 'not set'})`,
          'Python Resolve'
        );
        return cachedPythonExec;
      } else {
        writeMCPLog(
          `[resolvePythonExec] Dev mode: Python path not found or doesn't exist: ${pythonPath}`,
          'Python Resolve'
        );
      }
    } catch (error) {
      writeMCPLog(
        `[resolvePythonExec] Dev mode: which/where command failed: ${error instanceof Error ? error.message : String(error)}`,
        'Python Resolve'
      );
    }

    // Fallback: try 'python3' (or 'python' on Windows) directly
    // This handles cases where which/where doesn't work but python is in PATH
    const python3Cmd = PLATFORM === 'win32' ? 'python' : 'python3';
    writeMCPLog(
      `[resolvePythonExec] Dev mode: Trying ${python3Cmd} --version as fallback`,
      'Python Resolve'
    );
    try {
      const testResult = await executeCommandSafe(python3Cmd, ['--version'], { timeout: 2000 });
      writeMCPLog(
        `[resolvePythonExec] Dev mode: ${python3Cmd} --version result: stdout=${testResult.stdout}, stderr=${testResult.stderr}`,
        'Python Resolve'
      );
      if (testResult.stdout || testResult.stderr) {
        // python is available, try to get its full path for consistency
        let pythonPath = python3Cmd;
        try {
          const whichResult = await executeCommandSafe(
            PLATFORM === 'win32' ? 'where' : 'which',
            [python3Cmd],
            { timeout: 2000 }
          );
          const resolvedPath = whichResult.stdout.trim().split(/\r?\n/).filter(Boolean)[0];
          writeMCPLog(
            `[resolvePythonExec] Dev mode: Resolved ${python3Cmd} path: ${resolvedPath}`,
            'Python Resolve'
          );
          if (resolvedPath && (await pathExists(resolvedPath))) {
            pythonPath = resolvedPath;
          }
        } catch (error) {
          writeMCPLog(
            `[resolvePythonExec] Dev mode: Failed to resolve ${python3Cmd} path: ${error instanceof Error ? error.message : String(error)}`,
            'Python Resolve'
          );
          // If which/where fails, just use the command name directly
        }

        cachedPythonExec = {
          python: pythonPath,
          pythonRoot: pythonPath !== python3Cmd ? path.resolve(pythonPath, '..', '..') : '',
          env: {
            ...baseEnv, // Keep all current environment variables (including conda settings)
            // Don't set PYTHONHOME in dev mode to preserve conda/venv environment
            PYTHONNOUSERSITE: '1',
            PYTHONDONTWRITEBYTECODE: '1',
            PYTHONUTF8: '1',
          },
        };
        writeMCPLog(
          `[resolvePythonExec] Dev mode: Using ${python3Cmd} (${pythonPath}) from current environment`,
          'Python Resolve'
        );
        return cachedPythonExec;
      }
    } catch (error) {
      writeMCPLog(
        `[resolvePythonExec] Dev mode: ${python3Cmd} --version test failed: ${error instanceof Error ? error.message : String(error)}`,
        'Python Resolve'
      );
    }
    writeMCPLog(
      '[resolvePythonExec] Dev mode: Failed to find Python in current environment, falling back to bundled Python',
      'Python Resolve'
    );
  }

  // 2) Bundled with the app (recommended for production)
  // Packaged layout: Resources/python/bin/python3
  // Dev layout:      resources/python/darwin-${arch}/bin/python3
  if (PLATFORM === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    writeMCPLog(`[resolvePythonExec] Checking bundled Python (arch: ${arch})`, 'Python Resolve');
    const packaged = await resolveBundledExecutable(path.join('python', 'bin', 'python3'));
    const devBundled = await resolveBundledExecutable(
      path.join('python', `darwin-${arch}`, 'bin', 'python3')
    );
    writeMCPLog(
      `[resolvePythonExec] Packaged Python: ${packaged || 'not found'}`,
      'Python Resolve'
    );
    writeMCPLog(
      `[resolvePythonExec] Dev bundled Python: ${devBundled || 'not found'}`,
      'Python Resolve'
    );
    const pythonPath = packaged || devBundled;
    if (pythonPath) {
      const pythonRoot = path.resolve(pythonPath, '..', '..');
      const extraSite = path.join(pythonRoot, 'site-packages');
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        PYTHONHOME: pythonRoot,
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUTF8: '1',
      };
      if (await pathExists(extraSite)) {
        env.PYTHONPATH = [extraSite, baseEnv.PYTHONPATH].filter(Boolean).join(path.delimiter);
        writeMCPLog(
          `[resolvePythonExec] Found extra site-packages: ${extraSite}`,
          'Python Resolve'
        );
      }

      cachedPythonExec = { python: pythonPath, pythonRoot, env };
      writeMCPLog(`[resolvePythonExec] Using bundled Python: ${pythonPath}`, 'Python Resolve');
      return cachedPythonExec;
    }

    // 3) System python (fallback)
    const systemPython = '/usr/bin/python3';
    writeMCPLog(`[resolvePythonExec] Checking system Python: ${systemPython}`, 'Python Resolve');
    if (await pathExists(systemPython)) {
      cachedPythonExec = {
        python: systemPython,
        pythonRoot: path.resolve(systemPython, '..', '..'),
        env: {
          ...baseEnv,
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUTF8: '1',
        },
      };
      writeMCPLog(`[resolvePythonExec] Using system Python: ${systemPython}`, 'Python Resolve');
      return cachedPythonExec;
    }
  }

  // Generic fallback for other platforms: rely on PATH if available
  try {
    writeMCPLog(
      '[resolvePythonExec] Checking PATH for Python (generic fallback)',
      'Python Resolve'
    );
    const { stdout } = await executeCommandSafe(
      PLATFORM === 'win32' ? 'where' : 'which',
      ['python'],
      { timeout: 2000 }
    );
    const p = stdout.trim().split(/\r?\n/).filter(Boolean)[0];
    if (p) {
      cachedPythonExec = {
        python: p,
        pythonRoot: path.resolve(p, '..', '..'),
        env: {
          ...baseEnv,
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          PYTHONUTF8: '1',
        },
      };
      writeMCPLog(`[resolvePythonExec] Using PATH Python: ${p}`, 'Python Resolve');
      return cachedPythonExec;
    }
  } catch (error) {
    writeMCPLog(
      `[resolvePythonExec] PATH lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      'Python Resolve'
    );
  }

  writeMCPLog('[resolvePythonExec] No Python executable found!', 'Python Resolve Error');
  cachedPythonExec = null;
  return null;
}

export async function executePython(
  code: string,
  timeout: number = 10000
): Promise<{ stdout: string; stderr: string }> {
  const execInfo = await resolvePythonExec();
  if (!execInfo) {
    throw new Error(
      'Python 3 runtime not found.\n' +
        '- Recommended (macOS): bundle Python into the app at Resources/python/bin/python3 with required packages (Pillow, pyobjc-framework-Quartz)\n' +
        '- Or install python3 + dependencies on this machine.\n'
    );
  }

  const { python, env } = execInfo;
  writeMCPLog(`[executePython] Using Python: ${python}`, 'Python Execution');
  writeMCPLog(`[executePython] Python root: ${execInfo.pythonRoot}`, 'Python Execution');
  writeMCPLog(`[executePython] PYTHONHOME: ${env.PYTHONHOME || 'not set'}`, 'Python Execution');
  writeMCPLog(`[executePython] PYTHONPATH: ${env.PYTHONPATH || 'not set'}`, 'Python Execution');
  writeMCPLog(`[executePython] CONDA_PREFIX: ${env.CONDA_PREFIX || 'not set'}`, 'Python Execution');
  writeMCPLog(`[executePython] Code length: ${code.length} chars`, 'Python Execution');
  writeMCPLog(`[executePython] Timeout: ${timeout}ms`, 'Python Execution');

  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(python, ['-c', code], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          child.kill(); // On Windows, kill() sends TerminateProcess
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
      writeMCPLog(
        `[executePython] Execution timed out after ${timeout}ms`,
        'Python Execution Error'
      );
      reject(new Error('Python execution timed out'));
    }, timeout);

    child.on('error', (err) => {
      clearTimeout(timer);
      writeMCPLog(`[executePython] Spawn failed: ${err.message}`, 'Python Execution Error');
      reject(new Error(`Python spawn failed: ${err.message}`));
    });

    child.stdout.on('data', (d) => {
      const data = d.toString();
      stdout += data;
      writeMCPLog(
        `[executePython] stdout chunk: ${data.substring(0, 200)}${data.length > 200 ? '...' : ''}`,
        'Python Execution'
      );
    });

    child.stderr.on('data', (d) => {
      const data = d.toString();
      stderr += data;
      writeMCPLog(
        `[executePython] stderr chunk: ${data.substring(0, 200)}${data.length > 200 ? '...' : ''}`,
        'Python Execution Error'
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      writeMCPLog(`[executePython] Process closed with code: ${code}`, 'Python Execution');
      if (code === 0) {
        writeMCPLog(
          `[executePython] Execution succeeded. stdout length: ${stdout.length}, stderr length: ${stderr.length}`,
          'Python Execution'
        );
        resolve({ stdout, stderr });
      } else {
        const msg = (stderr || stdout).trim();
        writeMCPLog(
          `[executePython] Execution failed with exit code ${code}: ${msg.substring(0, 500)}${msg.length > 500 ? '...' : ''}`,
          'Python Execution Error'
        );
        reject(new Error(msg || `Python exited with code ${code}`));
      }
    });
  });
}

export async function macReadClipboardBytes(timeoutMs: number = 2000): Promise<Buffer | null> {
  if (PLATFORM !== 'darwin') return null;

  const pbpastePath = '/usr/bin/pbpaste';
  return await new Promise<Buffer | null>((resolve) => {
    const child = spawn(pbpastePath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          child.kill(); // On Windows, kill() sends TerminateProcess
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
      resolve(null);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });

    child.stdout.on('data', (d) => {
      stdoutChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
      } else {
        resolve(null);
      }
    });
  });
}

export async function macWriteClipboardBytes(bytes: Buffer, timeoutMs: number = 5000): Promise<void> {
  if (PLATFORM !== 'darwin') {
    throw new Error('pbcopy is only available on macOS.');
  }

  const pbcopyPath = '/usr/bin/pbcopy';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pbcopyPath, [], { stdio: ['pipe', 'ignore', 'pipe'] });
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          child.kill(); // On Windows, kill() sends TerminateProcess
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // ignore
      }
      reject(new Error('pbcopy timed out'));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.stderr.on('data', (d) => {
      stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
    });

    child.stdin.on('error', () => {
      // Ignore stdin errors here; we'll rely on exit code/stderr.
    });

    child.stdin.end(bytes);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(stderr || `pbcopy exited with code ${code}`));
      }
    });
  });
}

/**
 * Execute a command safely using execFileAsync (no shell interpolation).
 * Prefer this over executeCommand when the executable and arguments are known.
 */
export async function executeCommandSafe(
  command: string,
  args: string[],
  options?: { timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, { timeout: options?.timeout || 30000 });
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
    };
  } catch (error: unknown) {
    throw new Error(
      `Command execution failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Execute an AppleScript via osascript safely (no shell interpolation).
 */
export async function executeAppleScript(
  script: string,
  timeout: number = 10000
): Promise<{ stdout: string; stderr: string }> {
  return executeCommandSafe('/usr/bin/osascript', ['-e', script], { timeout });
}

/**
 * Execute a JXA (JavaScript for Automation) script via osascript safely.
 */
export async function executeJXAScript(
  script: string,
  timeout: number = 10000
): Promise<{ stdout: string; stderr: string }> {
  return executeCommandSafe('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout });
}

export async function getFrontmostMacApplicationName(): Promise<string | null> {
  if (PLATFORM !== 'darwin') return null;

  try {
    const { stdout } = await executeAppleScript(
      'tell application "System Events" to get name of first process whose frontmost is true',
      5000
    );
    const name = stdout.trim();
    return name || null;
  } catch (error) {
    writeMCPLog(
      `[GuiOperateServer] Error getting frontmost app: ${error}`,
      'getFrontmostMacApplicationName'
    );
    return null;
  }
}

export async function executeCliclick(command: string): Promise<{ stdout: string; stderr: string }> {
  if (PLATFORM !== 'darwin') {
    throw new Error('cliclick is only available on macOS. Use Windows-specific functions instead.');
  }

  const cliclickPath = await resolveCliclickPath();
  if (!cliclickPath) {
    throw new Error(
      'cliclick is required for GUI automation on macOS but was not found.\n' +
        `- Recommended: bundle it inside the app at Resources/tools/darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}/bin/cliclick\n` +
        '- Or legacy path: Resources/tools/bin/cliclick\n' +
        '- Or install it on this machine: brew install cliclick\n' +
        `Searched: bundled Resources/tools/darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}/bin/cliclick, ` +
        'Resources/tools/bin/cliclick, /opt/homebrew/bin/cliclick, /usr/local/bin/cliclick, and PATH.'
    );
  }

  // Parse cliclick command string into arguments array
  // cliclick commands are space-separated tokens like "c:100,200" or "kd:cmd kp:c ku:cmd"
  const cliclickArgs = command.split(/\s+/).filter(Boolean);
  writeMCPLog(
    `[executeCliclick] Executing: ${cliclickPath} ${cliclickArgs.join(' ')}`,
    'Cliclick Command'
  );

  try {
    const result = await executeCommandSafe(cliclickPath, cliclickArgs);
    writeMCPLog(
      `[executeCliclick] Command completed. stdout: ${result.stdout}, stderr: ${result.stderr}`,
      'Cliclick Result'
    );

    // cliclick may exit 0 while warning that Accessibility permission is missing.
    // Treat this as a hard failure to avoid reporting false-positive click success.
    if (/Accessibility privileges not enabled/i.test(result.stderr || '')) {
      const hint =
        '\n\nmacOS 权限提示 / Permissions:\n' +
        '- System Settings → Privacy & Security → Accessibility：允许 Open Cowork\n' +
        '- 如果是终端运行：允许 Terminal/iTerm\n' +
        '- 授权后请重启 Open Cowork 再重试\n';
      throw new Error(
        `cliclick cannot control UI because Accessibility permission is not enabled.${hint}`
      );
    }

    return result;
  } catch (error: unknown) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const hint =
      '\n\nmacOS 权限提示 / Permissions:\n' +
      '- System Settings → Privacy & Security → Accessibility：允许 Open Cowork\n' +
      '- System Settings → Privacy & Security → Automation：允许 Open Cowork 控制 “System Events”\n';
    throw new Error(`${baseMessage}${hint}`);
  }
}
