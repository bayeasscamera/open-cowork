/**
 * @module main/presets/preset-loader
 *
 * Loads user presets from `<userData>/presets/<id>/preset.json`.
 *
 * A user preset is DATA and is validated before it is ever used. Three rules
 * are load-bearing:
 *
 *   1. A user preset can never shadow a built-in id. Same id = refused with a
 *      message, not silently overridden — otherwise editing one JSON file
 *      would change what "Standard" means for every session.
 *   2. `skills.extraDirs` never escapes its preset directory. Both the lexical
 *      `..` check (in preset-schema) and the realpath check (here) are needed:
 *      a symlink inside the directory is invisible to the first.
 *   3. A malformed preset is skipped, never partially loaded. One bad file must
 *      not take the whole set down, and must not be silently ignored either —
 *      every refusal is reported.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import {
  validateAgentPreset,
  type AgentPreset,
  type PresetValidationError,
} from './preset-schema';
import { getBuiltinPreset, listBuiltinPresets } from './builtin-presets';
import { log, logWarn } from '../utils/logger';

const PRESETS_DIRNAME = 'presets';
const PRESET_FILENAME = 'preset.json';

export interface PresetLoadIssue {
  /** Preset id, or the directory name when the id could not be read. */
  id: string;
  /** File that failed, for the UI to point at. */
  file: string;
  errors: string[];
}

export interface LoadedPresets {
  /** Built-ins first, then user presets, each group alphabetically ordered. */
  presets: AgentPreset[];
  /** Every refusal, so the UI can show them instead of hiding a broken preset. */
  issues: PresetLoadIssue[];
}

/** `<userData>/presets`, or null when there is no writable app data dir. */
export function presetsRoot(): string | null {
  try {
    const base = app?.getPath?.('userData');
    if (!base) return null;
    return path.join(base, PRESETS_DIRNAME);
  } catch {
    return null;
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve `extraDirs` against the preset directory, refusing anything that
 * leaves it — including via a symlink, which a lexical check cannot see.
 * Returns the safe directories plus the reasons the others were dropped.
 */
export function resolveExtraDirs(
  presetDir: string,
  extraDirs: readonly string[]
): { safe: string[]; errors: string[] } {
  const safe: string[] = [];
  const errors: string[] = [];
  // The preset directory itself, fully resolved, is the boundary.
  let realPresetDir = presetDir;
  try {
    realPresetDir = fs.realpathSync(presetDir);
  } catch {
    // A preset directory that does not exist yet cannot host extra dirs.
    return { safe, errors: extraDirs.map((d) => `skills.extraDirs: '${d}' has no preset directory.`) };
  }

  for (const dir of extraDirs) {
    const candidate = path.resolve(realPresetDir, dir);
    if (!isInside(candidate, realPresetDir)) {
      errors.push(`skills.extraDirs: '${dir}' escapes the preset directory.`);
      continue;
    }
    // Lexically inside is not enough: follow symlinks and re-check.
    try {
      const real = fs.realpathSync(candidate);
      if (!isInside(real, realPresetDir)) {
        errors.push(`skills.extraDirs: '${dir}' resolves outside the preset directory.`);
        continue;
      }
      safe.push(real);
    } catch {
      // A declared but not-yet-created directory is fine; the skills loader
      // tolerates a missing dir, and creating it is the author's business.
      safe.push(candidate);
    }
  }
  return { safe, errors };
}

/**
 * Verify a loaded preset's extraDirs against the filesystem. Kept separate from
 * the structural validation because it needs the directory it was read from.
 */
export function verifyPresetOnDisk(
  preset: AgentPreset,
  presetDir: string
): PresetValidationError | null {
  if (!preset.skills?.extraDirs?.length) return null;
  const { errors } = resolveExtraDirs(presetDir, preset.skills.extraDirs);
  if (errors.length === 0) return null;
  return { ok: false, errors };
}

/**
 * Load every preset available: built-ins, then well-formed user presets.
 *
 * Never throws. A missing presets directory is the normal case (nobody has
 * created a preset yet) and yields the built-ins alone.
 */
export function loadPresets(options: { root?: string } = {}): LoadedPresets {
  const presets: AgentPreset[] = [...listBuiltinPresets()];
  const issues: PresetLoadIssue[] = [];

  const root = options.root ?? presetsRoot();
  if (!root) return { presets, issues };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No presets directory yet: built-ins only. Not an issue to report.
    return { presets, issues };
  }

  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(root, entry.name);
    const file = path.join(dir, PRESET_FILENAME);

    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      issues.push({
        id: entry.name,
        file,
        errors: [`Could not read ${PRESET_FILENAME}: ${error instanceof Error ? error.message : String(error)}`],
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      issues.push({
        id: entry.name,
        file,
        errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
      });
      continue;
    }

    const result = validateAgentPreset(parsed);
    if (!result.ok) {
      issues.push({ id: entry.name, file, errors: result.errors });
      continue;
    }

    // Rule 1: a user preset never shadows a built-in.
    if (getBuiltinPreset(result.preset.id)) {
      issues.push({
        id: result.preset.id,
        file,
        errors: [
          `A user preset cannot use the built-in id '${result.preset.id}'. Rename it; built-in presets are read-only.`,
        ],
      });
      continue;
    }

    // The directory name and the declared id must agree, so the id in the UI
    // always matches the folder a user would inspect.
    if (result.preset.id !== entry.name) {
      issues.push({
        id: entry.name,
        file,
        errors: [
          `Preset id '${result.preset.id}' does not match its directory name '${entry.name}'.`,
        ],
      });
      continue;
    }

    // Rule 2: extraDirs must stay inside the preset directory.
    const onDisk = verifyPresetOnDisk(result.preset, dir);
    if (onDisk) {
      issues.push({ id: result.preset.id, file, errors: onDisk.errors });
      continue;
    }

    presets.push(result.preset);
  }

  if (issues.length > 0) {
    logWarn(
      `[Presets] ${issues.length} preset(s) refused: ` +
        issues.map((i) => `${i.id} (${i.errors[0]})`).join('; ')
    );
  } else {
    log(`[Presets] Loaded ${presets.length} preset(s).`);
  }

  return { presets, issues };
}

/** Look up one preset by id, preferring a user preset over nothing at all. */
export function findPreset(
  id: string | null | undefined,
  loaded: LoadedPresets
): AgentPreset | undefined {
  if (!id) return undefined;
  return loaded.presets.find((preset) => preset.id === id);
}
