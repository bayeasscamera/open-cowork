import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const AGENT_DIR = 'src/main/sandbox/vm-agent';

/**
 * The WSL (Windows) and Lima (macOS) sandbox agents share a single
 * implementation in vm-agent/agent.ts, parameterized by a platform
 * descriptor injected at each entry point. These guards make sure neither
 * entry point regresses: both must be self-contained bootstraps that import
 * the shared agent and inject their own platform constants.
 */
describe('sandbox agent platform entry points', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), AGENT_DIR, rel), 'utf8');

  const ENTRY_POINTS = [
    { file: 'wsl/index.ts', platform: 'WSL2', logPrefix: '[WSL-Agent]', env: 'WINDOWS_WORKSPACE', prefix: '/mnt/' },
    { file: 'lima/index.ts', platform: 'Lima VM', logPrefix: '[Lima-Agent]', env: 'MAC_WORKSPACE', prefix: '/Users/' },
  ];

  it('both entry points exist', () => {
    for (const entry of ENTRY_POINTS) {
      expect(fs.existsSync(path.resolve(process.cwd(), AGENT_DIR, entry.file)), entry.file).toBe(true);
    }
  });

  it('each entry point imports the shared agent and injects its platform descriptor', () => {
    for (const entry of ENTRY_POINTS) {
      const source = read(entry.file);
      expect(source, entry.file).toContain("import { runAgent } from '../agent'");
      expect(source, entry.file).toContain(`label: '${entry.platform}'`);
      expect(source, entry.file).toContain(`logPrefix: '${entry.logPrefix}'`);
      expect(source, entry.file).toContain(`hostWorkspaceEnv: '${entry.env}'`);
      expect(source, entry.file).toContain(`hostPathPrefix: '${entry.prefix}'`);
    }
  });

  it('shared agent has no hardcoded platform identifiers', () => {
    const agent = read('agent.ts');
    // Strip docblock/comment lines so the check only covers actual code.
    const codeOnly = agent
      .split('\n')
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(codeOnly).not.toContain('WINDOWS_WORKSPACE');
    expect(codeOnly).not.toContain('MAC_WORKSPACE');
    expect(codeOnly).not.toContain('[WSL-Agent]');
    expect(codeOnly).not.toContain('[Lima-Agent]');
    expect(codeOnly).not.toContain("'WSL2'");
    expect(codeOnly).not.toContain("'Lima VM'");
    expect(codeOnly).not.toContain("'/mnt/'");
    expect(codeOnly).not.toContain("'/Users/'");
    expect(codeOnly).toContain('this.platform.hostPathPrefix');
    expect(codeOnly).toContain('[this.platform.hostWorkspaceEnv]');
  });

  it('both platform bundles expose the same JSON-RPC method surface', () => {
    const methodPattern = /case '(\w+)':/g;
    const methods = (src: string) => [...src.matchAll(methodPattern)].map((m) => m[1]).sort();
    expect(methods(read('agent.ts'))).toEqual([
      'copyFile',
      'createDirectory',
      'deleteFile',
      'executeCommand',
      'fileExists',
      'listDirectory',
      'ping',
      'readFile',
      'runClaudeCode',
      'setWorkspace',
      'shutdown',
      'writeFile',
    ]);
  });

  it('setWorkspace accepts both bridge payload shapes (windowsPath / macPath)', () => {
    const agent = read('agent.ts');
    expect(agent).toContain('params.macPath || params.windowsPath');
  });
});
