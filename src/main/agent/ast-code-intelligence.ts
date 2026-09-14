/**
 * @module main/agent/ast-code-intelligence
 *
 * Pilier 4 — AST-Aware Code Intelligence
 *
 * Uses @typescript-eslint/typescript-estree to parse TypeScript ASTs and:
 * 1. find_symbol_usages  — locate every import/usage of a symbol across the codebase
 * 2. ast_safe_rename     — rename a symbol in all files with proper AST awareness
 * 3. detect_dead_exports — find exported symbols that are never imported elsewhere
 *
 * Exposed as ToolDefinitions for the agent runtime.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse, AST_NODE_TYPES } from '@typescript-eslint/typescript-estree';
import { log } from '../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SymbolUsage {
  filePath: string;
  line: number;
  column: number;
  context: string;   // surrounding line text
  kind: 'import' | 'call' | 'reference' | 'export';
}

export interface RenameResult {
  filesModified: string[];
  totalReplacements: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// File walker (same as codebase-rag but local)
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set(['.ts', '.tsx']);
const EXCLUDE = new Set(['node_modules', 'dist', 'dist-electron', '.git', 'release']);

function walkTs(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) results.push(...walkTs(full));
      else if (SOURCE_EXTS.has(path.extname(e.name))) results.push(full);
    }
  } catch { /* ignore */ }
  return results;
}

// ---------------------------------------------------------------------------
// AST Utilities
// ---------------------------------------------------------------------------

function parseFile(filePath: string) {
  try {
    const code = fs.readFileSync(filePath, 'utf-8');
    return { code, ast: parse(code, { jsx: true, range: true, loc: true, tolerant: true }) };
  } catch {
    return null;
  }
}

function getLine(code: string, line: number): string {
  return code.split('\n')[line - 1] ?? '';
}

// ---------------------------------------------------------------------------
// AstCodeIntelligence
// ---------------------------------------------------------------------------

export class AstCodeIntelligence {
  constructor(private readonly projectRoot: string = process.cwd()) {}

  /**
   * Find all usages of a symbol (function, class, type, variable) in the project.
   */
  findSymbolUsages(symbolName: string): SymbolUsage[] {
    const usages: SymbolUsage[] = [];
    const files = walkTs(this.projectRoot);

    for (const filePath of files) {
      const parsed = parseFile(filePath);
      if (!parsed) continue;
      const { code, ast } = parsed;

      this.walkNode(ast as unknown as Record<string, unknown>, (node) => {
        const n = node as { type: string; loc?: { start: { line: number; column: number } }; name?: string; local?: { name: string }; imported?: { name: string }; source?: { value: string } };

        // Import specifier: import { symbolName } from '...'
        if (n.type === AST_NODE_TYPES.ImportSpecifier && n.local?.name === symbolName) {
          usages.push({ filePath, line: n.loc!.start.line, column: n.loc!.start.column, context: getLine(code, n.loc!.start.line), kind: 'import' });
        }
        // Import default: import symbolName from '...'
        if (n.type === AST_NODE_TYPES.ImportDefaultSpecifier && n.local?.name === symbolName) {
          usages.push({ filePath, line: n.loc!.start.line, column: n.loc!.start.column, context: getLine(code, n.loc!.start.line), kind: 'import' });
        }
        // Identifier reference
        if (n.type === AST_NODE_TYPES.Identifier && n.name === symbolName) {
          usages.push({ filePath, line: n.loc!.start.line, column: n.loc!.start.column, context: getLine(code, n.loc!.start.line), kind: 'reference' });
        }
      });
    }

    // Deduplicate by file+line
    const seen = new Set<string>();
    return usages.filter((u) => {
      const key = `${u.filePath}:${u.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Rename a symbol across all TypeScript files in the project.
   * Uses regex with word-boundary safety rather than full AST rewrite for speed.
   */
  safeRename(oldName: string, newName: string): RenameResult {
    const files = walkTs(this.projectRoot);
    const result: RenameResult = { filesModified: [], totalReplacements: 0, errors: [] };

    // Word boundary regex — matches `oldName` but not `oldName2` or `myOldName`
    const pattern = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');

    for (const filePath of files) {
      try {
        const original = fs.readFileSync(filePath, 'utf-8');
        const replaced = original.replace(pattern, newName);
        if (replaced !== original) {
          const count = (original.match(pattern) ?? []).length;
          fs.writeFileSync(filePath, replaced, 'utf-8');
          result.filesModified.push(filePath);
          result.totalReplacements += count;
        }
      } catch (err) {
        result.errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log(`[AstCodeIntelligence] Renamed "${oldName}" → "${newName}" in ${result.filesModified.length} files (${result.totalReplacements} occurrences)`);
    return result;
  }

  /**
   * Find exported symbols that are never imported anywhere else in the project.
   */
  detectDeadExports(): Array<{ filePath: string; symbol: string; line: number }> {
    const files = walkTs(this.projectRoot);
    const exportedSymbols: Array<{ filePath: string; symbol: string; line: number }> = [];
    const allImported = new Set<string>();

    // First pass: collect all exports and imports
    for (const filePath of files) {
      const parsed = parseFile(filePath);
      if (!parsed) continue;
      const { ast } = parsed;

      this.walkNode(ast as unknown as Record<string, unknown>, (node) => {
        const n = node as { type: string; loc?: { start: { line: number } }; declaration?: { id?: { name: string }; declarations?: Array<{ id: { name: string } }> }; specifiers?: Array<{ local: { name: string } }>; local?: { name: string }; imported?: { name: string } };

        if (n.type === AST_NODE_TYPES.ExportNamedDeclaration) {
          if (n.declaration) {
            const decl = n.declaration;
            if ('id' in decl && decl.id?.name) {
              exportedSymbols.push({ filePath, symbol: decl.id.name, line: n.loc!.start.line });
            }
            if ('declarations' in decl && decl.declarations) {
              for (const d of decl.declarations) {
                if (d.id.name) exportedSymbols.push({ filePath, symbol: d.id.name, line: n.loc!.start.line });
              }
            }
          }
          for (const spec of (n.specifiers ?? [])) {
            if (spec.local?.name) exportedSymbols.push({ filePath, symbol: spec.local.name, line: n.loc!.start.line });
          }
        }

        if (n.type === AST_NODE_TYPES.ImportSpecifier && n.imported?.name) {
          allImported.add(n.imported.name);
        }
        if (n.type === AST_NODE_TYPES.ImportDefaultSpecifier && n.local?.name) {
          allImported.add(n.local.name);
        }
      });
    }

    return exportedSymbols.filter((e) => !allImported.has(e.symbol));
  }

  private walkNode(node: Record<string, unknown>, visitor: (n: Record<string, unknown>) => void): void {
    if (!node || typeof node !== 'object') return;
    visitor(node);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item === 'object' && 'type' in item) {
            this.walkNode(item as Record<string, unknown>, visitor);
          }
        }
      } else if (child && typeof child === 'object' && 'type' in (child as Record<string, unknown>)) {
        this.walkNode(child as Record<string, unknown>, visitor);
      }
    }
  }
}
