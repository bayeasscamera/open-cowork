/**
 * @module main/memory/codegraph-indexer
 * v3.6+: Local Codebase Graph RAG and Symbol Indexer
 */

import * as fs from 'fs';
import * as path from 'path';
// Type-only: erased at compile time, the runtime value is loaded lazily via
// import('typescript') inside extractSymbolsFromFile.
import type * as ts from 'typescript';

export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'variable' | 'type';
  filePath: string;
  line: number;
}

export interface CodeGraphIndex {
  symbols: CodeSymbol[];
  filesCount: number;
  lastIndexed: number;
}

/** Module-level shared indexer so tools reuse one in-memory index. */
let sharedIndexer: CodeGraphIndexer | null = null;

export function getCodeGraphIndexer(): CodeGraphIndexer {
  if (!sharedIndexer) {
    sharedIndexer = new CodeGraphIndexer();
  }
  return sharedIndexer;
}

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const CACHE_TTL_MS = 3600 * 1000;

export class CodeGraphIndexer {
  private index: Map<string, CodeSymbol[]> = new Map();
  private isScanning: boolean = false;
  private cacheDir: string;
  private readonly scannedDirs = new Set<string>();
  private tsModulePromise: Promise<typeof import('typescript')> | null = null;

  constructor(customCacheDir?: string) {
    this.cacheDir = customCacheDir || path.join(process.cwd(), '.cowork', 'cache');
  }

  private getTypescript(): Promise<typeof import('typescript')> {
    // The native TS compiler is big: load it once, lazily, only when a TS/JS
    // file is actually parsed (kept out of app startup and of regex-only scans).
    if (!this.tsModulePromise) {
      this.tsModulePromise = import('typescript');
    }
    return this.tsModulePromise;
  }

  public isCurrentlyScanning(): boolean {
    return this.isScanning;
  }

  private getCachePath(dirPath: string): string {
    const hash = Buffer.from(dirPath).toString('base64url');
    return path.join(this.cacheDir, `codegraph-${hash}.json`);
  }

  private loadPersistentIndex(dirPath: string): CodeGraphIndex | null {
    try {
      const cacheFile = this.getCachePath(dirPath);
      if (!fs.existsSync(cacheFile)) return null;

      const raw = fs.readFileSync(cacheFile, 'utf-8');
      const data = JSON.parse(raw) as CodeGraphIndex;

      // Cache validity: 1 hour
      if (Date.now() - data.lastIndexed > CACHE_TTL_MS) {
        return null;
      }

      this.index.clear();
      for (const sym of data.symbols) {
        const key = sym.name.toLowerCase();
        if (!this.index.has(key)) {
          this.index.set(key, []);
        }
        this.index.get(key)!.push(sym);
      }

      return data;
    } catch {
      return null;
    }
  }

  private savePersistentIndex(dirPath: string, data: CodeGraphIndex): void {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
      const cacheFile = this.getCachePath(dirPath);
      const tmpFile = `${cacheFile}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpFile, cacheFile);
    } catch {
      // Best-effort cache save
    }
  }

  /**
   * Drop every cached symbol belonging to a changed file, in memory and in
   * the on-disk cache, without rescanning the whole directory. Consumers
   * (e.g. a sub-agent runner that knows which files it modified) call this
   * instead of waiting for the TTL to expire.
   */
  invalidateFile(filePath: string): void {
    const target = path.resolve(filePath);
    for (const [key, list] of this.index) {
      const remaining = list.filter((sym) => path.resolve(sym.filePath) !== target);
      if (remaining.length === 0) {
        this.index.delete(key);
      } else {
        this.index.set(key, remaining);
      }
    }

    for (const dirPath of this.scannedDirs) {
      try {
        const cacheFile = this.getCachePath(dirPath);
        if (!fs.existsSync(cacheFile)) continue;
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as CodeGraphIndex;
        const filtered = data.symbols.filter((sym) => path.resolve(sym.filePath) !== target);
        if (filtered.length === data.symbols.length) continue;
        this.savePersistentIndex(dirPath, { ...data, symbols: filtered });
      } catch {
        // Best-effort cache rewrite
      }
    }
  }

  public async scanDirectory(
    dirPath: string,
    extensions: string[] = ['.ts', '.tsx', '.js', '.jsx', '.py'],
    forceReindex: boolean = false
  ): Promise<CodeGraphIndex> {
    if (!forceReindex) {
      const cached = this.loadPersistentIndex(dirPath);
      if (cached) {
        return cached;
      }
    }

    this.isScanning = true;
    this.scannedDirs.add(dirPath);
    const allSymbols: CodeSymbol[] = [];
    let filesCount = 0;

    const traverse = async (currentDir: string) => {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.name.startsWith('.') ||
            entry.name === 'node_modules' ||
            entry.name === 'dist' ||
            entry.name === 'release' ||
            entry.name === 'build'
          ) {
            continue;
          }

          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            await traverse(fullPath);
          } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
            filesCount++;
            const fileSymbols = await this.extractSymbolsFromFile(fullPath);
            allSymbols.push(...fileSymbols);
          }
        }
      } catch {
        // Skip unreadable directories
      }
    };

    await traverse(dirPath);

    this.index.clear();
    for (const sym of allSymbols) {
      const key = sym.name.toLowerCase();
      if (!this.index.has(key)) {
        this.index.set(key, []);
      }
      this.index.get(key)!.push(sym);
    }

    this.isScanning = false;
    const result: CodeGraphIndex = {
      symbols: allSymbols,
      filesCount,
      lastIndexed: Date.now(),
    };

    this.savePersistentIndex(dirPath, result);
    return result;
  }

  public searchSymbol(query: string): CodeSymbol[] {
    const q = query.toLowerCase();
    const results: CodeSymbol[] = [];
    for (const [name, list] of this.index.entries()) {
      if (name.includes(q)) {
        results.push(...list);
      }
    }
    return results;
  }

  private async extractSymbolsFromFile(filePath: string): Promise<CodeSymbol[]> {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    if (!TS_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      return this.extractSymbolsWithRegex(filePath, content);
    }

    // The native TypeScript AST is loaded lazily: it is bundled into the main
    // process, and parsing the module eagerly would slow app startup.
    const symbols = this.extractSymbolsWithAst(await this.getTypescript(), content, filePath);
    if (symbols.length === 0) {
      // Fall back to the regex extractor for JS-style files the AST rejected.
      return this.extractSymbolsWithRegex(filePath, content);
    }
    return symbols;
  }

  private extractSymbolsWithAst(
    ts: typeof import('typescript'),
    content: string,
    filePath: string
  ): CodeSymbol[] {
    const ext = path.extname(filePath).toLowerCase();
    const scriptKind =
      ext === '.tsx'
        ? ts.ScriptKind.TSX
        : ext === '.jsx'
          ? ts.ScriptKind.JSX
          : ext === '.js'
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKind
    );
    const symbols: CodeSymbol[] = [];
    const lineOf = (node: ts.Node): number =>
      sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: 'class', filePath, line: lineOf(node) });
      } else if (ts.isInterfaceDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: 'interface', filePath, line: lineOf(node) });
      } else if (ts.isTypeAliasDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: 'type', filePath, line: lineOf(node) });
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        symbols.push({ name: node.name.text, kind: 'function', filePath, line: lineOf(node) });
      } else if (ts.isVariableStatement(node)) {
        // Module-level variable declarations (including exports), so imported
        // helper constants are discoverable without drowning in locals.
        const isTopLevel =
          ts.isSourceFile(node.parent) || ts.isModuleBlock(node.parent);
        if (isTopLevel) {
          for (const decl of node.declarationList.declarations) {
            if (decl.name && ts.isIdentifier(decl.name)) {
              symbols.push({
                name: decl.name.text,
                kind: 'variable',
                filePath,
                line: lineOf(decl),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return symbols;
  }

  private extractSymbolsWithRegex(filePath: string, content: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const lines = content.split('\n');

    const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/;
    const classRegex = /(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/;
    const interfaceRegex = /(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/;
    const typeRegex = /(?:export\s+)?type\s+([a-zA-Z0-9_$]+)/;

    lines.forEach((line, index) => {
      let match = line.match(classRegex);
      if (match) {
        symbols.push({ name: match[1], kind: 'class', filePath, line: index + 1 });
        return;
      }
      match = line.match(interfaceRegex);
      if (match) {
        symbols.push({ name: match[1], kind: 'interface', filePath, line: index + 1 });
        return;
      }
      match = line.match(typeRegex);
      if (match) {
        symbols.push({ name: match[1], kind: 'type', filePath, line: index + 1 });
        return;
      }
      match = line.match(funcRegex);
      if (match) {
        symbols.push({ name: match[1], kind: 'function', filePath, line: index + 1 });
        return;
      }
    });

    return symbols;
  }
}