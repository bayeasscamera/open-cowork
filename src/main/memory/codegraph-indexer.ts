/**
 * @module main/memory/codegraph-indexer
 * v3.6+: Local Codebase Graph RAG and Symbol Indexer
 */

import * as fs from 'fs';
import * as path from 'path';

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

export class CodeGraphIndexer {
  private index: Map<string, CodeSymbol[]> = new Map();
  private isScanning: boolean = false;

  public isCurrentlyScanning(): boolean {
    return this.isScanning;
  }

  public async scanDirectory(dirPath: string, extensions: string[] = ['.ts', '.tsx', '.js', '.jsx', '.py']): Promise<CodeGraphIndex> {
    this.isScanning = true;
    const allSymbols: CodeSymbol[] = [];
    let filesCount = 0;

    const traverse = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'release') {
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          traverse(fullPath);
        } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
          filesCount++;
          const fileSymbols = this.extractSymbolsFromFile(fullPath);
          allSymbols.push(...fileSymbols);
        }
      }
    };

    traverse(dirPath);

    for (const sym of allSymbols) {
      const key = sym.name.toLowerCase();
      if (!this.index.has(key)) {
        this.index.set(key, []);
      }
      this.index.get(key)!.push(sym);
    }

    this.isScanning = false;
    return {
      symbols: allSymbols,
      filesCount,
      lastIndexed: Date.now(),
    };
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

  private extractSymbolsFromFile(filePath: string): CodeSymbol[] {
    const symbols: CodeSymbol[] = [];
    const content = fs.readFileSync(filePath, 'utf-8');
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
