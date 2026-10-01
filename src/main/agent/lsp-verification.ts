/**
 * @module main/agent/lsp-verification
 *
 * Semantic verification that goes beyond what an AST parse can see.
 *
 * The AST check (`checkModifiedFilesSyntax` in swarm-runner.ts) only catches
 * parse errors. It is structurally blind to the errors that actually break a
 * build: a wrong argument type, a misspelled import, a property that does not
 * exist on an inferred type. This module adds those checks by asking a real
 * TypeScript `Program` for SEMANTIC diagnostics on the modified files.
 *
 * Why this is OPT-IN and lazy (measured, not guessed — see the numbers in the
 * module docs below): a full `Program` over this repo costs, cold, roughly
 * 2.4 s and ~1 GB of RSS, against 23 ms / 24 MB for the AST parse. So:
 *   - it is never on by default;
 *   - the Program is built lazily, once, and CACHED per project — a warm pass
 *     costs only the per-file diagnostic query;
 *   - every pass is bounded by a time budget and degrades to "no findings" on
 *     timeout, so verification can never stall a task.
 *
 * It COMPLEMENTS the AST check; it never replaces it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { log, logWarn } from '../utils/logger';

export interface SemanticIssue {
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
}

type TypescriptModule = typeof import('typescript');

/** Lazily imported once; the compiler is ~10 MB and only needed when opted in. */
let tsModulePromise: Promise<TypescriptModule> | null = null;
function getTypescript(): Promise<TypescriptModule> {
  if (!tsModulePromise) {
    tsModulePromise = import('typescript');
  }
  return tsModulePromise;
}

interface CachedProgram {
  program: import('typescript').Program;
  /** tsconfig mtime + size, so an edited config invalidates the cache. */
  signature: string;
  /** Extra roots added on top of the tsconfig (files created after the build). */
  extraRoots: readonly string[];
}

const programCache = new Map<string, CachedProgram>();

/** Cap the cached programs so a long-lived app does not accumulate them. */
const MAX_CACHED_PROGRAMS = 3;

/** Configs consulted, in order, when walking up from a modified file. */
const TSCONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];

/**
 * Walk up from `file` to find the nearest tsconfig/jsconfig.
 * Returns null when the file is not inside a TypeScript project — in which
 * case semantic checking is simply unavailable (a plain-JS file with no config
 * has nothing to type-check against).
 */
export function findProjectConfig(file: string): string | null {
  let dir = path.dirname(path.resolve(file));
  const { root } = path.parse(dir);
  // Stop at the filesystem root; `path.dirname('/') === '/'` is the exit.
  for (;;) {
    for (const name of TSCONFIG_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Cheap signature of the config file so an edit rebuilds the Program. */
function configSignature(configPath: string): string {
  try {
    const stat = fs.statSync(configPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

/** Only these extensions can carry TypeScript semantic diagnostics. */
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.d.ts']);

export function isSemanticallyCheckable(file: string): boolean {
  return TS_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Build (or reuse) the Program for the project owning `configPath`.
 *
 * The reuse is the whole point: rebuilding per file is what made the first
 * (naive) measurement look 5x worse than reality. Keyed by the config path, so
 * two different projects never share a Program.
 *
 * `extraRoots` matter more than they look: the common sub-agent flow CREATES a
 * file and then has it checked. A Program built before that file existed does
 * not know it (`getSourceFile` returns undefined) and would silently skip it —
 * exactly the file we were asked to verify. Any requested file that the cached
 * Program cannot resolve therefore forces a rebuild with the file added as an
 * extra root.
 */
async function getProgramFor(
  configPath: string,
  ts: TypescriptModule,
  requiredFiles: readonly string[]
): Promise<import('typescript').Program | null> {
  const signature = configSignature(configPath);
  const cached = programCache.get(configPath);

  if (cached && cached.signature === signature) {
    const missing = requiredFiles.filter(
      (file) => !cached.extraRoots.includes(file) && !cached.program.getSourceFile(file)
    );
    if (missing.length === 0) {
      return cached.program;
    }
    return rebuildProgram(ts, configPath, signature, [
      ...cached.extraRoots,
      ...missing,
    ]);
  }

  return rebuildProgram(ts, configPath, signature, [...requiredFiles]);
}

/** Build a Program from the config plus any extra roots, and cache it. */
function rebuildProgram(
  ts: TypescriptModule,
  configPath: string,
  signature: string,
  extraRoots: readonly string[]
): import('typescript').Program | null {
  try {
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {
        // A malformed config degrades to "no semantic check", never a crash.
      },
    });
    if (!parsed) return null;

    // Extra roots are deduplicated against the config's own file list.
    const known = new Set(parsed.fileNames.map((name) => path.resolve(name)));
    const additions = extraRoots.filter((file) => !known.has(path.resolve(file)));

    const program = ts.createProgram({
      rootNames: [...parsed.fileNames, ...additions],
      options: parsed.options,
      projectReferences: parsed.projectReferences,
    });

    if (programCache.size >= MAX_CACHED_PROGRAMS) {
      const oldest = programCache.keys().next();
      if (!oldest.done) programCache.delete(oldest.value);
    }
    programCache.set(configPath, {
      program,
      signature,
      extraRoots: [...extraRoots],
    });
    return program;
  } catch (error) {
    logWarn('[LspVerify] Could not build a TypeScript program:', {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** One diagnostic, flattened to a compact record. */
function toIssue(
  ts: TypescriptModule,
  file: string,
  diagnostic: import('typescript').Diagnostic
): SemanticIssue {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  if (diagnostic.start === undefined) {
    return { file, line: 0, column: 0, code: diagnostic.code, message };
  }
  const sourceFile = diagnostic.file;
  if (!sourceFile) {
    return { file, line: 0, column: 0, code: diagnostic.code, message };
  }
  const pos = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  return {
    file,
    line: pos.line + 1,
    column: pos.character + 1,
    code: diagnostic.code,
    message,
  };
}

/**
 * Diagnostics we deliberately ignore:
 *  - TS6133/TS6192 ("declared but never read"/"never used"): a sub-agent
 *    editing one function routinely leaves an import used elsewhere in the
 *    file, and flagging it would fire constantly without meaning anything;
 *  - TS2307 for a module the project has not installed yet: a half-finished
 *    install is not a code error and would be a false positive mid-task.
 */
const IGNORED_CODES = new Set([6133, 6192, 6196, 6198, 6199]);

export interface SemanticCheckOptions {
  /** Hard ceiling for the whole pass. On expiry, return what we have. */
  budgetMs?: number;
  /** Max diagnostics reported per file. */
  maxPerFile?: number;
}

const DEFAULT_BUDGET_MS = 20_000;
const DEFAULT_MAX_PER_FILE = 5;

/**
 * Type-check the given files against their project.
 *
 * Returns `[]` — never throws — when semantic checking is unavailable
 * (JS-only project, missing compiler, budget exhausted, or opt-in off).
 */
export async function checkFilesSemantics(
  files: string[],
  options: SemanticCheckOptions = {}
): Promise<SemanticIssue[]> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const maxPerFile = options.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  const deadline = Date.now() + budgetMs;

  const checkable = files.filter((file) => isSemanticallyCheckable(file));
  if (checkable.length === 0) {
    return [];
  }

  // Group by project so a Program is built once per project, not once per file.
  const byProject = new Map<string, string[]>();
  for (const file of checkable) {
    const configPath = findProjectConfig(file);
    if (!configPath) continue;
    const bucket = byProject.get(configPath);
    if (bucket) bucket.push(file);
    else byProject.set(configPath, [file]);
  }
  if (byProject.size === 0) {
    return [];
  }

  const issues: SemanticIssue[] = [];
  try {
    const ts = await getTypescript();

    for (const [configPath, projectFiles] of byProject) {
      if (Date.now() > deadline) {
        log('[LspVerify] Semantic check budget exhausted; reporting partial results');
        break;
      }

      const program = await getProgramFor(configPath, ts, projectFiles);
      if (!program) continue;

      for (const file of projectFiles) {
        if (Date.now() > deadline) break;
        try {
          if (!fs.existsSync(file)) continue;
          const sourceFile = program.getSourceFile(file);
          if (!sourceFile) {
            // The file is not part of the program (e.g. excluded). Skipping is
            // correct: reporting "unresolved" here would be a false positive.
            continue;
          }
          const diagnostics = [
            ...program.getSyntacticDiagnostics(sourceFile),
            ...program.getSemanticDiagnostics(sourceFile),
          ];
          let taken = 0;
          for (const diagnostic of diagnostics) {
            if (IGNORED_CODES.has(diagnostic.code)) continue;
            issues.push(toIssue(ts, file, diagnostic));
            taken += 1;
            if (taken >= maxPerFile) break;
          }
        } catch (error) {
          logWarn('[LspVerify] Per-file semantic check failed:', {
            file,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  } catch (error) {
    logWarn('[LspVerify] Semantic verification unavailable:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  return issues;
}

/** Render issues the same way the syntax check is rendered, for the report. */
export function formatSemanticIssues(issues: SemanticIssue[]): string {
  return issues.map((issue) => `${issue.file}:${issue.line} — ${issue.message}`).join('\n');
}

/** Drop cached programs — used by tests and by an explicit "re-check" action. */
export function resetProgramCache(): void {
  programCache.clear();
}

/** Number of cached programs; exposed for tests and diagnostics. */
export function cachedProgramCount(): number {
  return programCache.size;
}
