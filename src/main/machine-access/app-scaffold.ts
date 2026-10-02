/**
 * @module main/machine-access/app-scaffold
 *
 * Application creation (spec 7): generate a project INSIDE a granted folder
 * (never anywhere else), install dependencies and launch through the command
 * runner as background jobs with visible progress, detect port conflicts,
 * and flag typo-suspicious package names before installing.
 *
 * A downloaded executable is never auto-launched: only source scaffolding is
 * written here, and every install goes through the approval flow.
 */

import * as net from 'net';
import { randomUUID } from 'crypto';
import { resolveSafePath } from './safe-path';
import type { FolderGrant } from './types';

export type ScaffoldKind = 'node-http' | 'node-cli' | 'python-basic';

export interface ScaffoldRequest {
  kind: ScaffoldKind;
  /** Destination folder name, resolved inside the granted folder. */
  name: string;
  /** Granted folder that contains the destination (usually the workspace). */
  grantedRoot: string;
  grants?: FolderGrant[];
  autonomy?: 'ask-always' | 'read-free' | 'extended-trust' | 'allow-all';
}

export interface ScaffoldResult {
  ok: boolean;
  projectDir?: string;
  files: string[];
  error?: string;
}

const INVALID_DIR = /[<>:"|?*\0/\\]/;

export function validateAppName(name: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Application name is required.');
  if (INVALID_DIR.test(trimmed)) throw new Error(`Invalid application name: '${trimmed}'.`);
  if (platform === 'win32') {
    const upper = trimmed.split('.')[0]?.toUpperCase() ?? '';
    if (new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1']).has(upper)) {
      throw new Error(`Reserved application name: '${trimmed}'.`);
    }
  }
  return trimmed;
}

function filesFor(kind: ScaffoldKind, name: string): Record<string, string> {
  if (kind === 'node-http') {
    return {
      'package.json': `${JSON.stringify(
        { name, version: '0.1.0', private: true, type: 'module', scripts: { start: 'node server.js' } },
        null,
        2
      )}\n`,
      'server.js':
        `import http from 'node:http';\n\n` +
        `const port = Number(process.env.PORT ?? 3000);\n\n` +
        `http\n` +
        `  .createServer((req, res) => {\n` +
        `    res.writeHead(200, { 'content-type': 'application/json' });\n` +
        `    res.end(JSON.stringify({ ok: true, name: ${JSON.stringify(name)} }));\n` +
        `  })\n` +
        `  .listen(port, () => console.log('listening on http://localhost:' + port));\n`,
      'README.md': `# ${name}\n\nRun with \`npm start\`. The port is read from PORT.\n`,
      '.gitignore': 'node_modules/\n',
    };
  }
  if (kind === 'node-cli') {
    return {
      'package.json': `${JSON.stringify(
        { name, version: '0.1.0', private: true, type: 'module', bin: { [name]: './cli.js' } },
        null,
        2
      )}\n`,
      'cli.js': `#!/usr/bin/env node\nconsole.log(${JSON.stringify(`${name} ok`)});\n`,
      'README.md': `# ${name}\n\nRun with \`node cli.js\`.\n`,
    };
  }
  return {
    'main.py': `def main() -> None:\n    print(${JSON.stringify(`${name} ok`)})\n\n\nif __name__ == "__main__":\n    main()\n`,
    'README.md': `# ${name}\n\nRun with \`python3 main.py\`.\n`,
  };
}

/**
 * Write a scaffold into a granted folder. Confines the destination with
 * resolveSafePath so a crafted name cannot escape (e.g. '../../etc').
 */
export function scaffoldApp(request: ScaffoldRequest, writeFile: (p: string, c: string) => void, mkdir: (p: string) => void): ScaffoldResult {
  let name: string;
  try {
    name = validateAppName(request.name);
  } catch (error) {
    return { ok: false, files: [], error: error instanceof Error ? error.message : String(error) };
  }
  // Autonomy is deliberately NOT forwarded: 'allow-all' relaxes the ordinary
  // grant check, but a scaffold destination must ALWAYS stay inside a granted
  // folder (spec 7: "jamais ailleurs").
  const resolved = resolveSafePath(name, {
    workspaceRoot: request.grantedRoot,
    grants: request.grants ?? [],
    needsWrite: true,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      files: [],
      error: `Refused to create '${name}' outside the granted folder (${resolved.error ?? 'unknown'}).`,
    };
  }
  if (resolved.sensitive === true) {
    return { ok: false, files: [], error: 'Destination is a sensitive zone; explicit approval required.' };
  }
  const projectDir = resolved.realPath ?? '';
  const files = filesFor(request.kind, name);
  mkdir(projectDir);
  for (const [relative, content] of Object.entries(files)) {
    writeFile(`${projectDir}/${relative}`, content);
  }
  return { ok: true, projectDir, files: Object.keys(files) };
}

/** Parse `PORT=3000` from package.json scripts / env files. */
export function detectDeclaredPort(sources: string[]): number | undefined {
  for (const src of sources) {
    const match = /"?PORT"?\s*[:=]\s*(\d{2,5})/.exec(src);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** First free port at or after `start`, checked for real. */
export async function findFreePort(start: number, attempts = 20, host = '127.0.0.1'): Promise<number> {
  for (let p = start; p < start + attempts; p += 1) {
    if (await isPortFree(p, host)) return p;
  }
  throw new Error(`No free port found in ${start}..${start + attempts - 1}.`);
}

const KNOWN_PACKAGES = new Set([
  'react', 'react-dom', 'vue', 'svelte', 'express', 'next', 'vite', 'typescript', 'jest', 'vitest',
  'axios', 'lodash', 'zod', 'dotenv', 'commander', 'chalk', 'ws', 'uuid', 'electron', 'tailwindcss',
]);

/**
 * Typo-suspicious package detection: a name one edit away from a known
 * package is the classic typosquat shape. Never blocks — it asks.
 */
export function suspiciousPackage(name: string, known: Set<string> = KNOWN_PACKAGES): string | null {
  const target = name.toLowerCase();
  if (known.has(target)) return null;
  if (!/^@?[a-z0-9][a-z0-9-_.]*$/i.test(target)) return 'unusual package name format';
  for (const pkg of known) {
    if (editDistance(target, pkg) <= 1) return `looks like a typo of '${pkg}'`;
  }
  return null;
}

export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i += 1) {
    const curr = [i];
    for (let j = 1; j < cols; j += 1) {
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[cols - 1] ?? 0;
}

export interface BackgroundJobHandle {
  id: string;
  projectDir: string;
  command: string;
  startedAt: number;
}

/**
 * Track a launched dev server. The AbortSignal lets the emergency stop kill
 * the whole process group without going through the agent loop.
 */
export function createBackgroundJob(projectDir: string, command: string): BackgroundJobHandle {
  return { id: randomUUID(), projectDir, command, startedAt: Date.now() };
}