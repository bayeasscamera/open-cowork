/**
 * @module main/skills/skill-runtime-view
 *
 * The single source of truth for "which skills will the agent load?".
 *
 * Before this module the app answered a different question: SkillsManager keeps
 * an in-memory `enabled` flag on skills it has listed, and the capability pane
 * displayed that flag as if it described the runtime. It did not — the pi
 * resource loader is handed root directories and scans them itself, so a skill
 * switched off in the UI was still loaded. This module walks the same roots with
 * the same discovery rules as the loader, so the answer it produces is the one
 * the agent will actually get.
 *
 * Discovery mirrors the SDK (pi-coding-agent `loadSkillsFromDir`):
 * - a directory containing SKILL.md is itself a skill, and is not recursed into;
 * - otherwise subdirectories are scanned recursively;
 * - entries starting with '.' and node_modules are skipped.
 * The SDK additionally honours .gitignore files; that rule is not replicated here,
 * so a gitignored skill may be reported even though the loader would skip it.
 *
 * Pure by design: no Electron import, so it is unit-testable against temp dirs.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  RuntimeSkillEntry,
  RuntimeSkillSource,
  RuntimeSkillView,
  SkillRuntimeSourceInput,
} from '../../shared/skill-runtime-types';

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/;
const SKILL_FILE = 'SKILL.md';

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Read `name` and `description` out of a SKILL.md YAML frontmatter block. */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = FRONTMATTER_BLOCK.exec(content);
  if (!match) {
    return {};
  }
  const parsed: { name?: string; description?: string } = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const separator = rawLine.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = rawLine.slice(0, separator).trim();
    if (key !== 'name' && key !== 'description') {
      continue;
    }
    const value = unquote(rawLine.slice(separator + 1).trim());
    if (value.length === 0) {
      continue;
    }
    if (key === 'name') {
      parsed.name = value;
    } else {
      parsed.description = value;
    }
  }
  return parsed;
}

function isFileEntry(dir: string, entry: fs.Dirent): boolean {
  if (entry.isFile()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return fs.statSync(path.join(dir, entry.name)).isFile();
  } catch {
    return false;
  }
}

function isDirectoryEntry(dir: string, entry: fs.Dirent): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return fs.statSync(path.join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Enumerate the skill directories under `root`, following the loader's rules.
 * Returns absolute paths, in directory order, with no duplicates.
 */
export function discoverSkillDirs(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A directory holding SKILL.md is the skill itself; the loader stops there.
    for (const entry of entries) {
      if (entry.name === SKILL_FILE && isFileEntry(dir, entry)) {
        found.push(dir);
        return;
      }
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      if (isDirectoryEntry(dir, entry)) {
        visit(path.join(dir, entry.name));
      }
    }
  };
  visit(root);
  return found;
}

function readSkillEntry(skillDir: string, enabled: boolean): RuntimeSkillEntry {
  let name = path.basename(skillDir);
  let description: string | undefined;
  try {
    const parsed = parseSkillFrontmatter(fs.readFileSync(path.join(skillDir, SKILL_FILE), 'utf-8'));
    if (parsed.name && parsed.name.length > 0) {
      name = parsed.name;
    }
    description = parsed.description;
  } catch {
    // Unreadable SKILL.md — the directory is still a skill the loader would try.
  }
  return { name, description, path: skillDir, enabled };
}

/**
 * Walk every source root and report the skills it holds. `isEnabled` decides
 * whether a skill is handed to the loader; it defaults to allowing everything,
 * which matches the pre-existing behaviour when no manager is available.
 */
export function describeSkillRuntime(
  sources: SkillRuntimeSourceInput[],
  isEnabled: (name: string, skillDir: string) => boolean = () => true
): RuntimeSkillView {
  const resolved: RuntimeSkillSource[] = [];
  let loaded = 0;
  let disabled = 0;

  for (const source of sources) {
    const skills = discoverSkillDirs(source.root)
      .map((skillDir) => {
        const discovered = readSkillEntry(skillDir, true);
        const enabled = isEnabled(discovered.name, skillDir);
        if (enabled) {
          loaded += 1;
        } else {
          disabled += 1;
        }
        return { ...discovered, enabled };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    resolved.push({ root: source.root, kind: source.kind, skills });
  }

  return { sources: resolved, loaded, disabled };
}

/** The exact directory list to hand to the resource loader. */
export function runtimeSkillDirs(view: RuntimeSkillView): string[] {
  const dirs: string[] = [];
  for (const source of view.sources) {
    for (const skill of source.skills) {
      if (skill.enabled) {
        dirs.push(skill.path);
      }
    }
  }
  return dirs;
}
