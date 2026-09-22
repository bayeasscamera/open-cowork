/**
 * @module main/agent/skills-directory-setup
 *
 * Prepares the runner's Claude skills directories on the first query: ensures
 * the config and skills roots exist, links (or copies) the built-in skills and
 * synchronizes user / configured skills into them.
 *
 * Extracted from CoworkAgentRunner.run(). Every filesystem collaborator is
 * injected so this module owns no runner state and stays unit-testable; the
 * caller keeps the first-query guard (`_skillsSetupDone`).
 */

import * as fs from 'fs';
import * as path from 'path';
import { log, logWarn } from '../utils/logger';

export interface SkillsDirectorySetupDeps {
  /** App-specific Claude config directory (`<userData>/claude`). */
  appAgentDir: string;
  /** Runtime skills directory (`<appAgentDir>/skills`). */
  runtimeSkillsDir: string;
  /** Built-in skills directory shipped with the app; empty when unavailable. */
  builtinSkillsPath: string;
  /** Recursive copy fallback used when symlinking is impossible. */
  copyDirectorySync(source: string, target: string): void;
  /** Import the user's own `~/.claude/skills` entries. */
  syncUserSkillsToAppDir(appSkillsDir: string): void;
  /** Mirror a configured global skills directory into the runtime dir. */
  syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir: string): void;
}

/** Matches `.asar/` but NOT `.asar.unpacked/` (which is a real directory). */
const ASAR_SEGMENT = /\.asar[/\\]/;

export function setupSkillsDirectories(deps: SkillsDirectorySetupDeps): void {
  const {
    appAgentDir,
    runtimeSkillsDir,
    builtinSkillsPath,
    copyDirectorySync,
    syncUserSkillsToAppDir,
    syncConfiguredSkillsToRuntimeDir,
  } = deps;

  // Ensure app Claude config directory exists
  if (!fs.existsSync(appAgentDir)) {
    fs.mkdirSync(appAgentDir, { recursive: true });
  }

  // Ensure app Claude skills directory exists
  if (!fs.existsSync(runtimeSkillsDir)) {
    fs.mkdirSync(runtimeSkillsDir, { recursive: true });
  }

  // Copy built-in skills to app Claude skills directory if they don't exist
  if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
    // Symlinks into .asar archives don't work at the OS level (ENOTDIR),
    // so always copy when the source is inside an asar archive.
    const sourceInsideAsar = ASAR_SEGMENT.test(builtinSkillsPath);
    const builtinSkills = fs.readdirSync(builtinSkillsPath);
    for (const skillName of builtinSkills) {
      const builtinSkillPath = path.join(builtinSkillsPath, skillName);
      const userSkillPath = path.join(runtimeSkillsDir, skillName);

      // Clean up broken symlinks pointing into .asar from previous versions
      try {
        const lstat = fs.lstatSync(userSkillPath);
        if (lstat.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(userSkillPath);
          if (ASAR_SEGMENT.test(linkTarget)) {
            fs.unlinkSync(userSkillPath);
            log(`[CoworkAgentRunner] Removed broken asar symlink: ${userSkillPath}`);
          }
        }
      } catch {
        // Path doesn't exist — fine, we'll create it below
      }

      // Only set up if it's a directory and doesn't exist in app directory
      if (fs.statSync(builtinSkillPath).isDirectory() && !fs.existsSync(userSkillPath)) {
        if (sourceInsideAsar) {
          // Source is inside .asar — must copy (symlinks to asar paths fail at OS level)
          copyDirectorySync(builtinSkillPath, userSkillPath);
          log(`[CoworkAgentRunner] Copied built-in skill from asar: ${skillName}`);
        } else {
          // Source is a real directory — symlink for space efficiency
          try {
            fs.symlinkSync(builtinSkillPath, userSkillPath, 'dir');
            log(`[CoworkAgentRunner] Linked built-in skill: ${skillName}`);
          } catch (err) {
            logWarn(`[CoworkAgentRunner] Failed to symlink ${skillName}, copying instead:`, err);
            copyDirectorySync(builtinSkillPath, userSkillPath);
          }
        }
      }
    }
  }

  syncUserSkillsToAppDir(runtimeSkillsDir);
  syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir);
}
