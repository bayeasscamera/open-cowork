import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HINDSIGHT_DIR = path.resolve(import.meta.dirname, '..', '.claude', 'skills', 'hindsight-memory');

describe('hindsight-memory skill integration', () => {
  it('exists in .claude/skills/hindsight-memory', () => {
    expect(fs.existsSync(HINDSIGHT_DIR)).toBe(true);
    expect(fs.statSync(HINDSIGHT_DIR).isDirectory()).toBe(true);
  });

  it('has a valid SKILL.md with compatible metadata', () => {
    const skillMd = path.join(HINDSIGHT_DIR, 'SKILL.md');
    expect(fs.existsSync(skillMd)).toBe(true);
    const content = fs.readFileSync(skillMd, 'utf-8');

    // Extract frontmatter
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(match).toBeTruthy();
    const frontmatter = match![1];

    // Name must be 'hindsight-memory'
    const nameMatch = frontmatter.match(/name:\s*["']?([^"'\r\n]+)["']?/);
    expect(nameMatch).toBeTruthy();
    expect(nameMatch![1].trim()).toBe('hindsight-memory');

    // Description must be single-line, unquoted, no apostrophes (SkillsManager parser invariant)
    const descMatch = frontmatter.match(/description:\s*["']?([^"'\r\n]+)["']?/);
    expect(descMatch).toBeTruthy();
    const desc = descMatch![1].trim();
    expect(desc.length).toBeGreaterThan(10);
    expect(desc).not.toContain("'");
    expect(desc).not.toContain('"');
    expect(desc).not.toContain('\n');
  });

  it('contains MIT license file', () => {
    const license = path.join(HINDSIGHT_DIR, 'LICENSE');
    expect(fs.existsSync(license)).toBe(true);
    const content = fs.readFileSync(license, 'utf-8');
    expect(content).toContain('MIT License');
    expect(content).toContain('Vectorize AI');
  });
});
