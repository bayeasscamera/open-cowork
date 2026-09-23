import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const runner = read('src/main/agent/agent-runner.ts');
const sessionManager = read('src/main/session/session-manager.ts');
const index = read('src/main/index.ts');
const skillsManager = read('src/main/skills/skills-manager.ts');

describe('skills runtime wiring', () => {
  it('lets the runner receive the adapter after construction', () => {
    expect(runner).toContain('setSkillsAdapter(adapter: SkillsAdapter | undefined): void {');
    expect(runner).toContain('this._skillsAdapter = adapter;');
    expect(runner).toContain('this._skillsAdapter.getSkillPaths()');
  });

  it('forwards the adapter through the session manager and remembers it', () => {
    expect(sessionManager).toContain('private skillsAdapter?: SkillsAdapter;');
    expect(sessionManager).toContain('setSkillsAdapter(adapter: SkillsAdapter): void {');
    expect(sessionManager).toContain('this.agentRunner as CoworkAgentRunner).setSkillsAdapter(adapter)');
    expect(sessionManager).toContain('this.skillsAdapter,\n      this.extensionManager,');
  });

  it('installs the adapter once the skills manager exists, on both startup paths', () => {
    const installs = index.match(/createSkillsRuntimeAdapter\(\{/g) ?? [];
    expect(installs.length).toBe(2);
    expect(index).toContain('resolveSources: baseSkillSources,');
    expect(index).toContain('fallback: legacySkillPaths,');
    expect(index).toContain('sessionManager.setSkillsAdapter(');
  });

  it('no longer pretends to compute per-session active skills', () => {
    expect(skillsManager).not.toContain('getActiveSkills');
  });
});
