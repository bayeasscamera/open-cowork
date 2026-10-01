import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for the reason delegated tasks never used skills.
 *
 * The three task paths built their `DefaultResourceLoader` without
 * `additionalSkillPaths`, so they received no skill directory at all — silently,
 * with no warning and no log line. The main agent passed them, which made the
 * app look like it worked: the omission was only ever visible on a task.
 *
 * These assertions are on the source rather than on a live session because the
 * failure mode is a missing constructor argument; a behavioural test would need
 * a full agent session to notice the same thing.
 */
const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf-8');

const TASK_PATHS = {
  'workflow tasks': 'src/main/agent/agent-task-runner.ts',
  'swarm agents': 'src/main/agent/swarm-runner.ts',
  'sub-agent extension': 'src/main/agent/subagent-extension.ts',
} as const;

describe('delegated task paths receive skills', () => {
  for (const [label, file] of Object.entries(TASK_PATHS)) {
    it(`${label} passes selected skills to the resource loader`, () => {
      const source = read(file);

      expect(source).toContain('additionalSkillPaths: skillSelectionDirs(');
      expect(source).toContain('selectRelevantSkills(');
      expect(source).toContain("from '../skills/skill-selection-runtime'");
    });
  }

  it('no longer builds a task loader without any skill path', () => {
    for (const file of Object.values(TASK_PATHS)) {
      const source = read(file);
      const loaderCalls = source.match(/new DefaultResourceLoader\(\{/g) ?? [];
      expect(loaderCalls.length).toBeGreaterThan(0);
      // Every loader in a task path must carry skill paths.
      for (const call of loaderCalls) {
        const body = source.slice(
          source.indexOf(call),
          source.indexOf(call) + 400
        );
        expect(body).toContain('additionalSkillPaths');
      }
    }
  });

  it('tells the sub-agent the skills exist — a loaded skill it was never told about is unused', () => {
    for (const file of Object.values(TASK_PATHS)) {
      expect(read(file)).toContain('formatSkillHint(');
    }
  });
});

describe('skill selection is shared, not re-derived per path', () => {
  it('routes all three paths through the one selection module', () => {
    for (const file of Object.values(TASK_PATHS)) {
      const source = read(file);
      expect(source).toContain("from './skill-selection'");
    }
  });

  it('registers the skills manager at startup so the toggle is honoured on every path', () => {
    const index = read('src/main/index.ts');

    expect(index).toContain("from './skills/skill-selection-runtime'");
    expect(index).toContain('setSkillEnabledLookup(skillsManager)');
  });
});
