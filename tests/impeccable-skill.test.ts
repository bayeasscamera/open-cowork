import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const IMPECCABLE_DIR = path.resolve(import.meta.dirname, '..', '.claude', 'skills', 'impeccable');

describe('impeccable skill integration', () => {
  it('exists in .claude/skills/impeccable', () => {
    expect(fs.existsSync(IMPECCABLE_DIR)).toBe(true);
    expect(fs.statSync(IMPECCABLE_DIR).isDirectory()).toBe(true);
  });

  it('has a valid SKILL.md with compatible metadata', () => {
    const skillMd = path.join(IMPECCABLE_DIR, 'SKILL.md');
    expect(fs.existsSync(skillMd)).toBe(true);
    const content = fs.readFileSync(skillMd, 'utf-8');

    // Extract frontmatter
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(match).toBeTruthy();
    const frontmatter = match![1];

    // Name must be 'impeccable'
    const nameMatch = frontmatter.match(/name:\s*["']?([^"'\r\n]+)["']?/);
    expect(nameMatch).toBeTruthy();
    expect(nameMatch![1].trim()).toBe('impeccable');

    // Description must be single-line, unquoted, no apostrophes (SkillsManager parser invariant)
    const descMatch = frontmatter.match(/description:\s*["']?([^"'\r\n]+)["']?/);
    expect(descMatch).toBeTruthy();
    const desc = descMatch![1].trim();
    expect(desc.length).toBeGreaterThan(20);
    expect(desc).not.toContain("'");
    expect(desc).not.toContain('"');
    expect(desc).not.toContain('\n');
  });

  it('contains key reference playbooks', () => {
    const refDir = path.join(IMPECCABLE_DIR, 'reference');
    expect(fs.existsSync(refDir)).toBe(true);
    const requiredRefs = [
      'craft-floor.md',
      'new-work.md',
      'audit.md',
      'critique.md',
      'polish.md',
      'bolder.md',
      'quieter.md',
      'animate.md',
    ];
    for (const ref of requiredRefs) {
      expect(fs.existsSync(path.join(refDir, ref))).toBe(true);
    }
  });

  it('contains launcher script and Apache-2.0 license', () => {
    const launcher = path.join(IMPECCABLE_DIR, 'scripts', 'impeccable');
    expect(fs.existsSync(launcher)).toBe(true);
    const license = path.join(IMPECCABLE_DIR, 'LICENSE');
    expect(fs.existsSync(license)).toBe(true);
    const licenseContent = fs.readFileSync(license, 'utf-8');
    expect(licenseContent).toContain('Apache License');
    expect(licenseContent).toContain('Version 2.0');
  });
});
