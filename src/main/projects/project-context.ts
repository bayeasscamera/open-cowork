/**
 * @module main/projects/project-context
 *
 * Resolves the working context of the project a session belongs to and turns
 * it into the system-prompt block injected at session start:
 *
 *   <project_context>
 *     project identity (name/description)
 *     <project_instructions> persistent instructions </project_instructions>
 *     <project_reference_files> attached files' content, bounded </project_reference_files>
 *   </project_context>
 *
 * Reference files are read by the MAIN process and injected as text — they are
 * never mounted writable, so the sandbox confinement is not extended. Files
 * outside the project workspace are therefore readable as context without
 * giving the agent write access to them.
 *
 * A session's own workspace AGENTS.md continues to load natively (SDK resource
 * loader) — project instructions complement it, they do not replace it.
 */

import { readFileSync } from 'fs';
import type { Project } from '../../shared/types';
import { logError } from '../utils/logger';

export interface ProjectContextResolution {
  /** The project the session belongs to, when any. */
  project: Project | undefined;
  /** ConfigSet the project pins for its sessions (overrides the global active set). */
  configSetId: string | null;
  /** Ready-to-inject system prompt block ('' when nothing applies). */
  systemPromptBlock: string;
}

/** Hard bounds: a runaway reference file can never flood the context window. */
const MAX_REFERENCE_FILES = 8;
const MAX_FILE_CHARS = 8000;
const MAX_TOTAL_FILE_CHARS = 32000;
const MAX_INSTRUCTIONS_CHARS = 8000;

/** What the context injection will actually spend for a project. */
export interface ProjectContextUsage {
  /** Chars of instructions injected (capped). */
  instructionsChars: number;
  /** Chars of reference-file content injected (sequential budget, capped). */
  filesChars: number;
  /** Total injection budget: instructions cap + files cap. */
  maxChars: number;
  /** How many of the attached files will actually be injected. */
  filesInjected: number;
  filesTotal: number;
}

/**
 * Mirror of the injection budget in buildSystemPromptBlock: this is the number
 * the UI progress bar shows, not an invented figure.
 */
export function computeProjectContextUsage(project: Project): ProjectContextUsage {
  const instructionsChars = Math.min(
    project.instructions?.length ?? 0,
    MAX_INSTRUCTIONS_CHARS
  );
  let filesChars = 0;
  let filesInjected = 0;
  let budget = MAX_TOTAL_FILE_CHARS;
  for (const file of project.referenceFiles.slice(0, MAX_REFERENCE_FILES)) {
    if (budget <= 0) break;
    let content = '';
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      content = '';
    }
    const injected = Math.min(content.length, MAX_FILE_CHARS, budget);
    filesChars += injected;
    budget -= injected;
    filesInjected += 1;
  }
  return {
    instructionsChars,
    filesChars,
    maxChars: MAX_INSTRUCTIONS_CHARS + MAX_TOTAL_FILE_CHARS,
    filesInjected,
    filesTotal: project.referenceFiles.length,
  };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… [truncated to the first ${maxChars} characters]`;
}

/** Read a reference file with per-file and total caps. Unreadable → marker, never throws. */
function readReferenceFile(path: string, remainingBudget: number): string {
  try {
    let content = readFileSync(path, 'utf-8');
    if (content.length > MAX_FILE_CHARS) content = truncate(content, MAX_FILE_CHARS);
    if (content.length > remainingBudget) content = truncate(content, remainingBudget);
    return content;
  } catch (err) {
    return `[unreadable file: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function buildSystemPromptBlock(project: Project): string {
  const parts: string[] = [
    '<project_context>',
    `This conversation belongs to the project "${project.name}".`,
  ];
  if (project.description) parts.push(`Description: ${project.description}`);
  parts.push(`Workspace: ${project.workdir}`);
  if (project.instructions) {
    parts.push(
      `<project_instructions>\nFollow these project instructions consistently for every request in this conversation:\n${truncate(
        project.instructions,
        MAX_INSTRUCTIONS_CHARS
      )}\n</project_instructions>`
    );
  }
  if (project.referenceFiles.length > 0) {
    let budget = MAX_TOTAL_FILE_CHARS;
    const fileBlocks: string[] = [];
    for (const file of project.referenceFiles.slice(0, MAX_REFERENCE_FILES)) {
      if (budget <= 0) {
        fileBlocks.push('[remaining reference files skipped: context budget exhausted]');
        break;
      }
      const content = readReferenceFile(file, budget);
      budget -= content.length;
      fileBlocks.push(`--- ${file} ---\n${content}`);
    }
    parts.push(
      `<project_reference_files>\nThe user attached these reference files for the project. Use them as authoritative context:\n${fileBlocks.join(
        '\n\n'
      )}\n</project_reference_files>`
    );
  }
  parts.push('</project_context>');
  return parts.join('\n');
}

/**
 * Resolve the project context for a session. Never throws: a broken DB or an
 * unreadable file degrades to an empty block, it never breaks the session.
 */
export function resolveProjectContext(
  sessionId: string,
  store: { getForSession: (sessionId: string) => Project | undefined }
): ProjectContextResolution {
  try {
    const project = store.getForSession(sessionId);
    if (!project || project.archived) {
      return { project: undefined, configSetId: null, systemPromptBlock: '' };
    }
    return {
      project,
      configSetId: project.configSetId,
      systemPromptBlock: buildSystemPromptBlock(project),
    };
  } catch (err) {
    // Resolve must never take a session down with it — degrade to no context.
    logError('[ProjectContext] Failed resolving project context for session:', sessionId, err);
    return { project: undefined, configSetId: null, systemPromptBlock: '' };
  }
}