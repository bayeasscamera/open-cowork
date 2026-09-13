import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const nativeExecutorPath = path.resolve(process.cwd(), 'src/main/sandbox/native-executor.ts');
const sharedAgentPath = path.resolve(process.cwd(), 'src/main/sandbox/vm-agent/agent.ts');

describe('Sandbox executor containment wiring', () => {
  it('uses containment helpers instead of raw workspace prefix matching', () => {
    const nativeSource = fs.readFileSync(nativeExecutorPath, 'utf8');
    const agentSource = fs.readFileSync(sharedAgentPath, 'utf8');

    expect(nativeSource).toContain("import { isPathWithinRoot } from '../tools/path-containment';");
    expect(nativeSource).toContain('isPathWithinRoot(targetCheck, workspaceCheck, isWindows)');
    expect(nativeSource).toContain('isPathWithinRoot(realCheck, workspaceCheck, isWindows)');

    expect(agentSource).toContain("import { isPathWithinRoot } from './path-containment';");
    expect(agentSource).toContain('isPathWithinRoot(resolved, this.workspacePath)');
  });
});
