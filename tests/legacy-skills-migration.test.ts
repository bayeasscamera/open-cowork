import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  DynamicSkillRegistry,
  migrateLegacyDynamicSkillsToProposals,
} from '../src/main/tools/dynamic-tool-creator';
import { initSkillProposals, listProposals, rejectProposal } from '../src/main/skills/skill-proposals';

describe('legacy dynamic_skills/ sweep → pending proposals (approval gate)', () => {
  let tmp: string;
  let registry: DynamicSkillRegistry;
  let legacyDir: string;
  const seeded: string[] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-migration-'));
    initSkillProposals(path.join(tmp, 'skills-proposed'));
    registry = DynamicSkillRegistry.getInstance();
    legacyDir = registry.getSkillsDir();
    seeded.length = 0;
  });

  afterEach(() => {
    // Clean both stores: pending proposals and any legacy residue.
    for (const p of listProposals()) void rejectProposal(p.name);
    for (const slug of seeded) registry.deleteSkill(slug);
    // Also drop anything the failed-migration test intentionally left behind.
    for (const s of registry.getAllSkills()) registry.deleteSkill(s.slug);
  });

  const seed = (name: string, content: string) => {
    const def = registry.createSkill({ name, description: 'Legacy skill', content });
    seeded.push(def.slug);
    return def;
  };

  it('migrates every legacy skill into PENDING proposals and deletes the legacy copy', () => {
    const def = seed('Legacy SEO Checklist', '# SEO checklist\n1. Check titles.');
    expect(fs.existsSync(path.join(legacyDir, def.slug, 'SKILL.md'))).toBe(true);

    const result = migrateLegacyDynamicSkillsToProposals();
    expect(result.migrated).toBeGreaterThanOrEqual(1);

    // PENDING proposal exists, authored by the migration, with the gate rationale.
    const pending = listProposals().find((p) => p.name === def.slug);
    expect(pending).toBeDefined();
    expect(pending?.proposedBy).toBe('legacy-migration');
    expect(pending?.rationale).toContain('approval');
    // The draft is INERT: it lives only in the proposals store.
    expect(pending?.path).toContain('skills-proposed');

    // Legacy copy removed — disk AND memory.
    expect(registry.getAllSkills().map((s) => s.slug)).not.toContain(def.slug);
    expect(fs.existsSync(path.join(legacyDir, def.slug))).toBe(false);
  });

  it('prepends frontmatter when a hand-edited legacy file lacks it', () => {
    const def = seed('Legacy Bare Skill', '# Just markdown');
    // Simulate a hand-edited legacy file: strip the auto-added frontmatter.
    const stored = registry.getAllSkills().find((s) => s.slug === def.slug);
    stored!.content = 'Just plain markdown, no frontmatter';

    const result = migrateLegacyDynamicSkillsToProposals();
    expect(result.skipped).toHaveLength(0);

    const pending = listProposals().find((p) => p.name === def.slug);
    expect(pending).toBeDefined();
    expect(pending?.content.startsWith('---')).toBe(true);
    expect(pending?.content).toContain('name: ' + def.slug);
    expect(pending?.content).toContain('Just plain markdown');
  });

  it('skips (and keeps) a legacy skill whose stored slug is invalid, reporting why', () => {
    const def = seed('Legacy Broken Slug', '# whatever');
    const stored = registry.getAllSkills().find((s) => s.slug === def.slug);
    stored!.slug = '../invalid escape';

    const result = migrateLegacyDynamicSkillsToProposals();
    const entry = result.skipped.find((s) => s.slug === '../invalid escape');
    expect(entry).toBeDefined();

    // Not deleted: still in the registry for the next sweep to retry safely.
    const stillThere = registry.getAllSkills().find((s) => s.slug === '../invalid escape');
    expect(stillThere).toBeDefined();
  });

  it('wiring — the sweep runs once at GUI app startup', () => {
    const index = fs.readFileSync('src/main/index.ts', 'utf-8');
    expect(index).toContain('migrateLegacyDynamicSkillsToProposals();');
    // Best-effort, never blocking startup on failure.
    expect(index).toContain('Legacy dynamic-skills migration failed');
  });
});
