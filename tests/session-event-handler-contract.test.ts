/**
 * Architectural contract for the extracted pi session event handler.
 *
 * The handler must stay a pure, injected module: no Electron, no singletons,
 * no class coupling. This guard fails if a future edit reaches back into the
 * runner or the environment, and it also pins the wiring between the
 * PiSessionEventContext / PiSessionEventState interfaces and the object
 * literals the runner builds — adding a field without wiring it fails here.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const NL = String.fromCharCode(10);
const handler = readFileSync(
  path.resolve(process.cwd(), 'src/main/agent/session-event-handler.ts'),
  'utf8'
);
const runner = readFileSync(path.resolve(process.cwd(), 'src/main/agent/agent-runner.ts'), 'utf8');

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Field names declared inside an exported interface, in source order. */
function interfaceKeys(source: string, name: string): string[] {
  const anchor = 'export interface ' + name + ' {';
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error('interface not found: ' + name);
  const bodyStart = source.indexOf('{', at) + 1;
  const bodyEnd = source.indexOf(NL + '}', bodyStart);
  if (bodyEnd < 0) throw new Error('interface end not found: ' + name);
  // Only top-level members count as keys. A member whose signature opens an
  // inline object type (e.g. `foo?(detail: {`) spans several lines and its
  // members must NOT leak in as phantom interface keys (this bit us once).
  const keys: string[] = [];
  let depth = 0;
  for (const raw of source.slice(bodyStart, bodyEnd).split(NL)) {
    const line = raw.trim();
    if (depth === 0) {
      const key = line.split(/[(:?]/)[0].trim();
      if (IDENTIFIER.test(key)) keys.push(key);
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  return keys;
}

describe('interfaceKeys extraction', () => {
  it('does not leak inline object-type members as phantom keys', () => {
    const source = [
      'export interface Demo {',
      '  plain: string;',
      '  nested?(detail: {',
      '    fragmentCount: number;',
      '    sample: string;',
      '  }): void;',
      '  after: number;',
      '}',
    ].join('\n');
    expect(interfaceKeys(source, 'Demo')).toEqual(['plain', 'nested', 'after']);
  });
});

/** Top-level object-literal keys of a declaration, ignoring nested values. */
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

describe('session-event-handler module contract', () => {
  it('stays free of Electron, singletons and class coupling', () => {
    expect(handler).not.toContain("from 'electron'");
    expect(handler).not.toContain('require(');
    expect(handler).not.toContain('config-store');
    expect(handler).not.toContain('mcp-config-store');
    expect(handler).not.toContain("'./agent-runner'");
    expect(handler).not.toContain('this.');
  });

  it('exposes exactly the injected handler surface', () => {
    expect(handler).toContain('export function handlePiSessionEvent(');
    expect(handler).toContain('export interface PiSessionEventContext');
    expect(handler).toContain('export interface PiSessionEventState');
    expect(handler).toContain('export interface PiSessionEventTelemetry');
  });

  it('is wired once from the runner subscribe callback', () => {
    expect(runner).toContain("from './session-event-handler'");
    expect(runner).toContain('handlePiSessionEvent(event, piSessionEventContext);');
  });

  it('provides every PiSessionEventContext field from the runner wiring', () => {
    const required = interfaceKeys(handler, 'PiSessionEventContext').sort();
    const provided = literalKeys(
      runner,
      'const piSessionEventContext: PiSessionEventContext ='
    ).sort();
    expect(required.length).toBeGreaterThan(10);
    expect(provided).toEqual(required);
  });

  it('provides every PiSessionEventState field from the runner wiring', () => {
    const required = interfaceKeys(handler, 'PiSessionEventState').sort();
    const provided = literalKeys(runner, 'const piSessionEventState: PiSessionEventState =').sort();
    expect(required.length).toBeGreaterThan(4);
    expect(provided).toEqual(required);
  });
});
