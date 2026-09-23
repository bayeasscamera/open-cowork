/**
 * Cross-module contract for the agent modules extracted out of run().
 *
 * Two guarantees:
 *  1. Boundary — each extracted module stays free of Electron and singletons.
 *  2. Wiring — every field declared on an injected deps interface is provided
 *     by the object literal the runner builds at the call site, so adding a
 *     field without wiring it fails the build.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const NL = String.fromCharCode(10);
const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');
const runner = read('src/main/agent/agent-runner.ts');

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Field names declared inside an exported interface, in source order. */
function interfaceKeys(source: string, name: string): string[] {
  const anchor = 'export interface ' + name + ' {';
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error('interface not found: ' + name);
  const bodyStart = source.indexOf('{', at) + 1;
  const bodyEnd = source.indexOf(NL + '}', bodyStart);
  if (bodyEnd < 0) throw new Error('interface end not found: ' + name);

  const keys: string[] = [];
  let nested = 0;
  for (const raw of source.slice(bodyStart, bodyEnd).split(NL)) {
    if (nested === 0) {
      // Only a top-level line declares a field; the parameters of a multi-line
      // function type are indented continuations that must not be counted.
      const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\??\s*[:(]/.exec(raw.trim());
      if (match) keys.push(match[1]);
    }
    for (const ch of raw) {
      if (ch === '(' || ch === '{' || ch === '[') nested++;
      else if (ch === ')' || ch === '}' || ch === ']') nested--;
    }
  }
  return keys;
}

/** Top-level object-literal keys of a call/declaration, ignoring nested values. */
function literalKeys(source: string, declaration: string): string[] {
  const at = source.indexOf(declaration);
  if (at < 0) throw new Error('declaration not found: ' + declaration);
  const open = source.indexOf('{', at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new Error('literal end not found: ' + declaration);

  const keys: string[] = [];
  let nested = 0;
  for (const raw of source.slice(open + 1, close).split(NL)) {
    const line = raw.trim();
    if (nested === 0) {
      const key = line.replace(/:.*$/, '').replace(/,+$/, '').trim();
      if (IDENTIFIER.test(key)) keys.push(key);
    }
    for (const ch of raw) {
      if (ch === '{' || ch === '(' || ch === '[') nested++;
      else if (ch === '}' || ch === ')' || ch === ']') nested--;
    }
  }
  return keys;
}

const EXTRACTED_MODULES = [
  'session-event-handler',
  'session-event-logging',
  'contextual-prompt',
  'pi-session-tools',
  'create-pi-session',
  'reuse-pi-session',
  'loop-guard-controller',
  'runtime-config-summary',
  'skills-directory-setup',
  'pi-session-lifecycle',
];

describe('extracted agent modules — environment boundary', () => {
  it.each(EXTRACTED_MODULES)('%s.ts never imports Electron or a singleton store', (name) => {
    const source = read('src/main/agent/' + name + '.ts');
    expect(source).not.toContain("from 'electron'");
    expect(source).not.toContain('require(');
    expect(source).not.toContain("from '../config/config-store'");
    expect(source).not.toContain("from '../mcp/mcp-config-store'");
  });
});

const WIRING: Array<{ module: string; iface: string; declaration: string }> = [
  {
    module: 'contextual-prompt',
    iface: 'AssembleContextualPromptDeps',
    declaration: 'await assembleContextualPrompt(',
  },
  {
    module: 'pi-session-tools',
    iface: 'BuildPiSessionToolsDeps',
    declaration: 'await buildPiSessionTools(',
  },
  {
    module: 'create-pi-session',
    iface: 'CreatePiSessionDeps',
    declaration: 'await createPiSession(',
  },
  {
    module: 'loop-guard-controller',
    iface: 'LoopGuardControllerDeps',
    declaration: 'createLoopGuardController({',
  },
  {
    module: 'reuse-pi-session',
    iface: 'ReusePiSessionDeps',
    declaration: 'await reusePiSession(',
  },
  {
    module: 'pi-session-lifecycle',
    iface: 'PiSessionInfrastructureSignatures',
    declaration: 'resolvePiSessionRecreateReason(cachedSession, {',
  },
  {
    module: 'session-event-logging',
    iface: 'SessionEventLoggingDeps',
    declaration: 'const sessionEventLoggingDeps: SessionEventLoggingDeps =',
  },
  {
    module: 'session-event-handler',
    iface: 'PiSessionEventContext',
    declaration: 'const piSessionEventContext: PiSessionEventContext =',
  },
  {
    module: 'session-event-handler',
    iface: 'PiSessionEventState',
    declaration: 'const piSessionEventState: PiSessionEventState =',
  },
];

describe('extracted agent modules — runner wiring', () => {
  it.each(WIRING)(
    '$iface is fully provided at the $module call site',
    ({ module, iface, declaration }) => {
      const source = read('src/main/agent/' + module + '.ts');
      const required = interfaceKeys(source, iface).sort();
      const provided = literalKeys(runner, declaration).sort();
      expect(required.length).toBeGreaterThan(0);
      expect(provided).toEqual(required);
    }
  );
});
